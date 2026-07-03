/// <reference lib="webworker" />
import type { Remote } from "comlink";
import {
  COMLINK,
  MSG,
  REQUEST_TIMEOUT_MS,
  SESSION_RECV_TIMEOUT_MS,
  WARMUP_REQUEST_HEADER,
  WS_FRAME,
} from "./constants";
import { Comlink, createSwDeliveryApi } from "./comlink";
import type { RHostApi } from "./comlink";
import { httpuvDebugLog } from "./debug";
import {
  isHostPushUrl,
  normalizeSessionHandle,
  parseSessionAction,
  resolveSessionPrefix,
  resolveShinyPrefix,
} from "./prefix";
import { resolveShinyStaticRHomePath, rHomePathFromVfsDir } from "./static-resolve";
import type { HeaderMap, PendingResponse } from "./types";

// `self` is typed as Window because the DOM lib is enabled for the other
// entries; cast it to the service-worker global for this bundle.
const swSelf = self as unknown as ServiceWorkerGlobalScope;

const SHINY_PREFIX = resolveShinyPrefix(import.meta.url);
const SESSION_PREFIX = resolveSessionPrefix(import.meta.url);
void SESSION_PREFIX;

/** Host-announced prefix (defaults to SW script path; updated via REGISTER_HOST). */
let shinyAppPrefix = SHINY_PREFIX;

let hostClientId: string | null = null;

let rwasmHost: Remote<RHostApi> | null = null;

let rwasmHostReadyResolve: (() => void) | null = null;

let rwasmHostReady: Promise<void> = new Promise((resolve) => {
  rwasmHostReadyResolve = resolve;
});

interface WsPushMsg {
  wsType?: string;
  binary?: boolean;
  message?: unknown;
}

interface HttpWaiter {
  resolve: (resp: PendingResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  url: string;
  method: string;
}

interface RecvWaiter {
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HostOutbound {
  type: string;
  uuid?: string;
  status?: number;
  headers?: HeaderMap;
  body?: ArrayBuffer | Uint8Array | string | null;
  handle?: string;
  binary?: boolean;
  wsType?: string;
  message?: unknown;
}

async function connectSwToWorker(port: MessagePort): Promise<void> {
  const workerHost = Comlink.wrap<RHostApi>(port);
  const deliveryChannel = new MessageChannel();
  Comlink.expose(
    createSwDeliveryApi((msg) => handleHostOutboundMessage(msg as HostOutbound)),
    deliveryChannel.port1,
  );
  try {
    await workerHost.registerSwDelivery(
      Comlink.transfer(deliveryChannel.port2, [deliveryChannel.port2]),
    );
    rwasmHost = workerHost;
    markRwasmHostReady();
    console.info("[httpuv-sw] Comlink: unified session connected");
  } catch (err) {
    console.error("[httpuv-sw] Comlink unified setup failed", err);
    resetRwasmHostWaiter();
  }
}

function markRwasmHostReady(): void {
  if (rwasmHostReadyResolve) {
    rwasmHostReadyResolve();
    rwasmHostReadyResolve = null;
  }
}

function resetRwasmHostWaiter(): void {
  rwasmHost = null;
  rwasmHostReady = new Promise((resolve) => {
    rwasmHostReadyResolve = resolve;
  });
}

async function waitForRwasmHost(timeoutMs = REQUEST_TIMEOUT_MS): Promise<Remote<RHostApi>> {
  if (rwasmHost) {
    return rwasmHost;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("R worker Comlink not ready")), timeoutMs);
  });

  try {
    await Promise.race([rwasmHostReady, timeout]);
  } finally {
    clearTimeout(timer);
  }

  if (!rwasmHost) {
    throw new Error("R worker Comlink not ready");
  }
  return rwasmHost;
}

/** Ask the host page to re-handshake Comlink MessagePorts. */
async function requestComlinkFromHost(): Promise<void> {
  const client = await getHostClient();
  client?.postMessage({ type: MSG.REQUEST_COMLINK });
}

const pendingHttp = new Map<string, HttpWaiter>();

const pendingRecv = new Map<string, RecvWaiter[]>();

const queuedWsPush = new Map<string, WsPushMsg[]>();

/** Cached GET /shiny/ document so warmup and iframe do not each trigger a full R render. */
let cachedAppDocument: PendingResponse | null = null;

/** addResourcePath prefix -> VFS directory (e.g. jquery-3.7.1 -> /R_HOME/library/shiny/www/shared). */
let shinyResourcePaths = new Map<string, string>();

function isAppDocumentRequest(urlString: string): boolean {
  const url = new URL(urlString);
  if (!url.pathname.startsWith(shinyAppPrefix)) {
    return false;
  }
  const rest = url.pathname.slice(shinyAppPrefix.length).replace(/\/$/, "");
  return rest === "" || rest === "index.html";
}

function pathUnderShinyPrefix(pathname: string): boolean {
  return pathname.startsWith(shinyAppPrefix) || pathname.startsWith(SHINY_PREFIX);
}

function clonePendingResponse(resp: PendingResponse): PendingResponse {
  let body = resp.body;
  if (body instanceof ArrayBuffer) {
    body = body.slice(0);
  } else if (body instanceof Uint8Array) {
    body = body.slice();
  }
  return {
    status: resp.status,
    headers: { ...(resp.headers ?? {}) },
    body,
  };
}

function clearCachedAppDocument(): void {
  cachedAppDocument = null;
}

function clearShinyResourcePaths(): void {
  shinyResourcePaths = new Map();
}

function setShinyResourcePaths(paths: Record<string, string>): void {
  shinyResourcePaths = new Map();
  for (const [prefix, dir] of Object.entries(paths ?? {})) {
    if (prefix && dir) {
      shinyResourcePaths.set(prefix, dir);
    }
  }
  if (shinyResourcePaths.size > 0) {
    console.info(
      "[httpuv-sw] registered",
      shinyResourcePaths.size,
      "Shiny resource path(s):",
      [...shinyResourcePaths.keys()].join(", "),
    );
  }
}

function mimeForAssetSuffix(suffix: string): string {
  if (suffix.endsWith(".js") || suffix.endsWith(".mjs")) {
    return "application/javascript";
  }
  if (suffix.endsWith(".css")) {
    return "text/css";
  }
  if (suffix.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (suffix.endsWith(".png")) {
    return "image/png";
  }
  if (suffix.endsWith(".woff2")) {
    return "font/woff2";
  }
  if (suffix.endsWith(".woff")) {
    return "font/woff";
  }
  return "application/octet-stream";
}

async function fetchRHomeAsset(rHomeRelative: string, originUrl: URL): Promise<Response | null> {
  const assetUrl = new URL(`R_HOME/${rHomeRelative}`, originUrl.origin);
  const assetRes = await fetch(assetUrl, { cache: "force-cache" });
  if (!assetRes.ok) {
    httpuvDebugLog("sw-static-miss", {
      path: rHomeRelative,
      status: assetRes.status,
      url: assetUrl.href,
    });
    return null;
  }
  return assetRes;
}

/** Serve Shiny web dependencies from the preloaded R_HOME tree (no R eval). */
async function tryServeShinyStaticAsset(request: Request): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const url = new URL(request.url);
  if (!url.pathname.startsWith(shinyAppPrefix)) {
    return null;
  }

  const rest = url.pathname.slice(shinyAppPrefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return null;
  }

  const prefix = rest.slice(0, slash);
  const suffix = rest.slice(slash + 1);
  if (!suffix || suffix.includes("..")) {
    return null;
  }

  const localDir = shinyResourcePaths.get(prefix);
  const rHomeRelative =
    (localDir ? rHomePathFromVfsDir(localDir, suffix) : null) ??
    resolveShinyStaticRHomePath(prefix, suffix);
  if (!rHomeRelative) {
    return null;
  }

  const assetRes = await fetchRHomeAsset(rHomeRelative, url);
  if (!assetRes) {
    return null;
  }

  httpuvDebugLog("sw-static-hit", {
    prefix,
    suffix,
    source: localDir ? "resourcePaths" : "fallback",
    path: rHomeRelative,
  });

  const headers = new Headers(assetRes.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", mimeForAssetSuffix(suffix));
  }
  headers.set("X-Httpuv-Static", localDir ? "rhome" : "rhome-fallback");

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(assetRes.body, { status: 200, headers });
}

swSelf.addEventListener("install", (event) => {
  console.info("[httpuv-sw] installing, shiny prefix:", SHINY_PREFIX);
  event.waitUntil(swSelf.skipWaiting());
});

swSelf.addEventListener("activate", (event) => {
  console.info("[httpuv-sw] activated, shiny prefix:", SHINY_PREFIX);
  resetRwasmHostWaiter();
  event.waitUntil(swSelf.clients.claim());
});

function waitForHttpResponse(uuid: string, url: string, method: string): Promise<PendingResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHttp.delete(uuid);
      httpuvDebugLog("sw-timeout", { uuid, timeoutMs: REQUEST_TIMEOUT_MS });
      reject(new Error(`httpuv request ${uuid} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    pendingHttp.set(uuid, { resolve, reject, timer, url, method });
  });
}

function maybeCacheAppDocument(resp: PendingResponse, url: string, method: string): void {
  if (url && method === "GET" && isAppDocumentRequest(url) && resp.status === 200) {
    cachedAppDocument = clonePendingResponse(resp);
    console.info("[httpuv-sw] cached app document", url);
  }
}

function toFetchResponse(resp: PendingResponse): Response {
  const headers = new Headers(resp.headers ?? {});
  if (resp.body == null) {
    return new Response(null, { status: resp.status, headers });
  }
  return new Response(resp.body as BodyInit, { status: resp.status, headers });
}

async function headersToObject(request: Request): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function messageBodyLength(message: unknown): number {
  if (typeof message === "string") {
    return message.length;
  }
  if (message instanceof ArrayBuffer) {
    return message.byteLength;
  }
  if (ArrayBuffer.isView(message)) {
    return message.byteLength;
  }
  return 0;
}

function deliverWsPush(handle: string, msg: WsPushMsg): void {
  const key = normalizeSessionHandle(handle);
  const queue = pendingRecv.get(key);
  httpuvDebugLog("sw-ws-push", {
    handle: key,
    wsType: msg.wsType,
    messageLen: messageBodyLength(msg.message),
    recvWaiters: queue?.length ?? 0,
    queuedBefore: queuedWsPush.get(key)?.length ?? 0,
  });
  if (queue && queue.length > 0) {
    const waiter = queue.shift();
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    if (queue.length === 0) {
      pendingRecv.delete(key);
    }
    const headers = new Headers();
    headers.set("X-Httpuv-WS-Type", msg.wsType ?? WS_FRAME.SEND);
    headers.set("X-Httpuv-WS-Binary", msg.binary ? "1" : "0");
    if (!msg.binary) {
      headers.set("Content-Type", "text/plain; charset=UTF-8");
    }
    waiter.resolve(
      new Response((msg.message ?? null) as BodyInit | null, {
        status: 200,
        headers,
      }),
    );
    return;
  }

  const existing = queuedWsPush.get(key);
  if (existing) {
    existing.push(msg);
  } else {
    queuedWsPush.set(key, [msg]);
  }
}

async function handleSessionRecv(event: FetchEvent): Promise<Response> {
  const url = new URL(event.request.url);
  const handle = normalizeSessionHandle(url.searchParams.get("handle"));
  httpuvDebugLog("sw-recv", { handle, url: url.href });
  if (!handle) {
    return new Response("missing handle query parameter", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const queued = queuedWsPush.get(handle);
  if (queued && queued.length > 0) {
    const msg = queued.shift();
    if (queued.length === 0) {
      queuedWsPush.delete(handle);
    }
    const headers = new Headers();
    headers.set("X-Httpuv-WS-Type", msg?.wsType ?? WS_FRAME.SEND);
    headers.set("X-Httpuv-WS-Binary", msg?.binary ? "1" : "0");
    if (!msg?.binary) {
      headers.set("Content-Type", "text/plain; charset=UTF-8");
    }
    return new Response((msg?.message ?? null) as BodyInit | null, { status: 200, headers });
  }

  return new Promise<Response>((resolve) => {
    const timer = setTimeout(() => {
      const waiters = pendingRecv.get(handle);
      if (!waiters) {
        return;
      }
      const idx = waiters.findIndex((w) => w.timer === timer);
      if (idx !== -1) {
        waiters.splice(idx, 1);
      }
      if (waiters.length === 0) {
        pendingRecv.delete(handle);
      }
      resolve(new Response(null, { status: 204 }));
    }, SESSION_RECV_TIMEOUT_MS);

    const waiters = pendingRecv.get(handle);
    if (waiters) {
      waiters.push({ resolve, timer });
    } else {
      pendingRecv.set(handle, [{ resolve, timer }]);
    }
  });
}

async function getHostClient(): Promise<Client | undefined> {
  if (hostClientId) {
    const client = await swSelf.clients.get(hostClientId);
    if (client) {
      return client;
    }
  }
  const clients = await swSelf.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  return clients[0];
}

function handleHostOutboundMessage(msg: HostOutbound): void {
  switch (msg.type) {
    case MSG.HTTP_RESPONSE: {
      httpuvDebugLog("sw-response", { uuid: msg.uuid, status: msg.status });
      const pending = msg.uuid ? pendingHttp.get(msg.uuid) : undefined;
      if (!pending || !msg.uuid) {
        console.warn("[httpuv-sw] No pending request for", msg.uuid);
        return;
      }
      clearTimeout(pending.timer);
      pendingHttp.delete(msg.uuid);
      const resp: PendingResponse = {
        status: msg.status ?? 500,
        headers: msg.headers ?? {},
        body: msg.body ?? null,
      };
      maybeCacheAppDocument(resp, pending.url, pending.method);
      pending.resolve(resp);
      break;
    }
    case MSG.WS_PUSH: {
      if (!msg.handle) {
        console.warn("[httpuv-sw] WS_PUSH missing handle");
        return;
      }
      httpuvDebugLog("sw-ws-push-inbound", {
        handle: normalizeSessionHandle(msg.handle),
        wsType: msg.wsType,
        messageLen: messageBodyLength(msg.message),
      });
      deliverWsPush(normalizeSessionHandle(msg.handle), msg);
      break;
    }
    default:
      console.warn("[httpuv-sw] Ignoring unknown host push message", msg.type);
  }
}

async function handleHostPush(event: FetchEvent): Promise<Response> {
  try {
    const msg = (await event.request.json()) as HostOutbound;
    handleHostOutboundMessage(msg);
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error("[httpuv-sw] host push failed", err);
    return new Response("bad host push payload", { status: 400 });
  }
}

async function handleShinyFetch(event: FetchEvent): Promise<Response> {
  const request = event.request;
  const uuid = crypto.randomUUID();
  httpuvDebugLog("sw-request", { uuid, method: request.method, url: request.url });

  const bypassAppCache = request.headers.get(WARMUP_REQUEST_HEADER) === "1";
  if (
    request.method === "GET" &&
    isAppDocumentRequest(request.url) &&
    cachedAppDocument &&
    !bypassAppCache
  ) {
    console.info("[httpuv-sw] app document cache hit", request.url);
    httpuvDebugLog("sw-app-cache-hit", { uuid, url: request.url });
    return toFetchResponse(clonePendingResponse(cachedAppDocument));
  }

  const staticRes = await tryServeShinyStaticAsset(request);
  if (staticRes) {
    return staticRes;
  }

  if (!rwasmHost) {
    void requestComlinkFromHost();
    try {
      await waitForRwasmHost(60_000);
    } catch (err) {
      console.error("[httpuv-sw] R worker not ready for", request.url, err);
      return new Response("Shiny R worker is not ready", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    }
  }

  const host = rwasmHost;
  if (!host) {
    return new Response("Shiny R worker is not ready", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const body =
    request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();

  const responsePromise = waitForHttpResponse(uuid, request.url, request.method);

  const payload = {
    uuid,
    method: request.method,
    url: request.url,
    headers: await headersToObject(request),
    body,
    clientId: event.clientId,
  };

  const delivery = host
    .deliverHttpRequest(body ? Comlink.transfer(payload, [body]) : payload)
    .catch((err: unknown) => {
      console.error("[httpuv-sw] R worker request failed", err);
      throw err;
    });

  try {
    const resp = await responsePromise;
    await delivery;
    return toFetchResponse(resp);
  } catch (err) {
    const pending = pendingHttp.get(uuid);
    if (pending) {
      clearTimeout(pending.timer);
      pendingHttp.delete(uuid);
    }
    console.error("[httpuv-sw]", err);
    const failed = err instanceof Error && err.message.includes("request failed");
    return new Response(failed ? "Bad Gateway" : "Gateway Timeout", {
      status: failed ? 502 : 504,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

swSelf.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!pathUnderShinyPrefix(url.pathname)) {
    return;
  }

  if (
    isHostPushUrl(event.request.url, shinyAppPrefix) ||
    isHostPushUrl(event.request.url, SHINY_PREFIX)
  ) {
    event.respondWith(handleHostPush(event));
    return;
  }

  const session =
    parseSessionAction(event.request.url, shinyAppPrefix) ??
    parseSessionAction(event.request.url, SHINY_PREFIX);
  if (session?.action === "recv") {
    event.respondWith(handleSessionRecv(event));
    return;
  }

  event.respondWith(handleShinyFetch(event));
});

swSelf.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") {
    return;
  }

  if (msg.type === COMLINK.PORT_HANDOFF && event.ports[0]) {
    const port = event.ports[0];
    port.start();
    resetRwasmHostWaiter();
    void connectSwToWorker(port);
    return;
  }

  if (typeof msg.type !== "string") {
    return;
  }

  switch (msg.type) {
    case MSG.REGISTER_HOST: {
      if (typeof msg.shinyPrefix === "string" && msg.shinyPrefix) {
        shinyAppPrefix = msg.shinyPrefix.endsWith("/") ? msg.shinyPrefix : `${msg.shinyPrefix}/`;
      }
      const source = event.source;
      if (source && "id" in source) {
        hostClientId = source.id;
        console.info("[httpuv-sw] Registered host client", hostClientId);
      }
      break;
    }

    case MSG.HTTP_RESPONSE: {
      handleHostOutboundMessage(msg as HostOutbound);
      break;
    }

    case MSG.WS_PUSH: {
      handleHostOutboundMessage(msg as HostOutbound);
      break;
    }

    case MSG.CLEAR_APP_CACHE: {
      clearCachedAppDocument();
      clearShinyResourcePaths();
      break;
    }

    case MSG.SYNC_RESOURCE_PATHS: {
      const replyPort = event.ports?.[0] ?? null;
      const finish = () => {
        replyPort?.postMessage({ ok: true });
      };
      if (!rwasmHost) {
        console.warn("[httpuv-sw] SYNC_RESOURCE_PATHS: R worker not connected");
        finish();
        break;
      }
      void rwasmHost
        .getShinyResourcePaths()
        .then((paths) => {
          setShinyResourcePaths(paths);
        })
        .catch((err: unknown) => {
          console.warn("[httpuv-sw] failed to sync resource paths", err);
        })
        .finally(finish);
      break;
    }

    case MSG.REGISTER_RESOURCE_PATHS: {
      setShinyResourcePaths(msg.paths);
      break;
    }

    case MSG.STOP: {
      clearCachedAppDocument();
      clearShinyResourcePaths();
      for (const [uuid, pending] of pendingHttp) {
        clearTimeout(pending.timer);
        pending.reject(new Error("httpuv stopped"));
        pendingHttp.delete(uuid);
      }
      for (const [, waiters] of pendingRecv) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(new Response(null, { status: 204 }));
        }
      }
      pendingRecv.clear();
      queuedWsPush.clear();
      hostClientId = null;
      if (rwasmHost) {
        void rwasmHost.stop().catch((err: unknown) => {
          console.warn("[httpuv-sw] R worker stop failed", err);
        });
      }
      break;
    }

    default:
      break;
  }
});
