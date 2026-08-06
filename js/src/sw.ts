/// <reference lib="webworker" />
import type { Remote } from "comlink";
import {
  COMLINK,
  MSG,
  REQUEST_TIMEOUT_MS,
  SESSION_RECV_TIMEOUT_MS,
  WASM_R_HOME,
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
  setHostPrefixDir,
  tryGetHostPrefixDir,
} from "./prefix";
import { resolveShinyStaticRHomePath, rHomeAssetHttpPath, rHomePathFromVfsDir } from "./static-resolve";
import type { HeaderMap, PendingResponse } from "./types";

// `self` is typed as Window because the DOM lib is enabled for the other
// entries; cast it to the service-worker global for this bundle.
const swSelf = self as unknown as ServiceWorkerGlobalScope;

/**
 * Resolve the initial mount prefix without assuming the SW script location.
 * The bundle may be served from a deep path (e.g. /_env-wasm/lib/R/library/httpuv/www/),
 * so deriving the prefix from import.meta.url is wrong. Prefer an explicit
 * `?shinyPrefix=` on the registration URL; otherwise default to the origin
 * root, giving `/shiny/`. The host also confirms this via REGISTER_HOST.
 * Likewise `?hostPrefix=` names the host directory for static R assets.
 */
function initialShinyPrefix(): string {
  try {
    const own = new URL(swSelf.location.href);
    const declared = own.searchParams.get("shinyPrefix");
    if (declared) {
      return declared.endsWith("/") ? declared : `${declared}/`;
    }
  } catch {
    // fall through to origin-root default
  }
  return resolveShinyPrefix(new URL("/", swSelf.location.href).href);
}

function initialHostPrefixDir(): string | null {
  try {
    const own = new URL(swSelf.location.href);
    const declared = own.searchParams.get("hostPrefix");
    if (declared) {
      return declared.replace(/^\/+|\/+$/g, "");
    }
  } catch {
    // fall through
  }
  return null;
}

const declaredHostPrefixDir = initialHostPrefixDir();
if (declaredHostPrefixDir) {
  setHostPrefixDir(declaredHostPrefixDir);
}

const SHINY_PREFIX = initialShinyPrefix();
const SESSION_PREFIX = resolveSessionPrefix(new URL("/", swSelf.location.href).href);
void SESSION_PREFIX;

/** Host-announced prefix (defaults to the origin-root mount; updated via REGISTER_HOST). */
let shinyAppPrefix = SHINY_PREFIX;

let hostClientId: string | null = null;

let rwasmHost: Remote<RHostApi> | null = null;

interface RwasmHostReady {
  promise: Promise<Remote<RHostApi>>;
  resolve: (host: Remote<RHostApi>) => void;
  reject: (err: Error) => void;
}

function createRwasmHostReady(): RwasmHostReady {
  let resolve!: (host: Remote<RHostApi>) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<Remote<RHostApi>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Pending waiters until Comlink connects or the handshake is reset/fails. */
let rwasmHostReady: RwasmHostReady = createRwasmHostReady();

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
    httpuvDebugLog("sw-comlink-connected");
  } catch (err) {
    console.error("[httpuv-sw] Comlink unified setup failed", err);
    const message = err instanceof Error ? err.message : String(err);
    resetRwasmHostWaiter(new Error(`R worker Comlink setup failed: ${message}`));
  }
}

function markRwasmHostReady(): void {
  if (!rwasmHost) {
    return;
  }
  rwasmHostReady.resolve(rwasmHost);
}

/**
 * Hard reset: drop the host and reject anyone waiting (activate / STOP / fatal
 * Comlink failure). Callers that need a reconnect should use
 * {@link rollRwasmHostWaiter} instead so in-flight fetches keep waiting.
 */
function resetRwasmHostWaiter(reason?: Error): void {
  const previous = rwasmHostReady;
  rwasmHost = null;
  rwasmHostReady = createRwasmHostReady();
  previous.reject(reason ?? new Error("R worker Comlink not ready"));
}

/**
 * Soft reset for PORT_HANDOFF: clear the live host and open a new waiter, but
 * forward settlement to the previous promise so warmup/fetch waiters are not
 * rejected mid-handshake (that produced instant HTTP 503 "not ready").
 */
function rollRwasmHostWaiter(): void {
  const previous = rwasmHostReady;
  rwasmHost = null;
  rwasmHostReady = createRwasmHostReady();
  void rwasmHostReady.promise.then(
    (host) => {
      previous.resolve(host);
    },
    (err: unknown) => {
      previous.reject(err instanceof Error ? err : new Error(String(err)));
    },
  );
}

async function waitForRwasmHost(): Promise<Remote<RHostApi>> {
  // Retry across soft handoffs: a PORT_HANDOFF may replace rwasmHostReady while
  // we are awaiting; permanent rejects (STOP / setup failure) still propagate.
  for (;;) {
    if (rwasmHost) {
      return rwasmHost;
    }
    const ready = rwasmHostReady;
    try {
      return await ready.promise;
    } catch (err) {
      if (rwasmHost) {
        return rwasmHost;
      }
      if (rwasmHostReady !== ready) {
        continue;
      }
      throw err;
    }
  }
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

/** addResourcePath prefix -> VFS directory (e.g. jquery-3.7.1 -> /lib/R/library/shiny/www/shared). */
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
    httpuvDebugLog("sw-resource-paths", {
      count: shinyResourcePaths.size,
      keys: [...shinyResourcePaths.keys()],
    });
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

/** Site root for static R_HOME assets. Prefer the SW registration scope so
 * project GitHub Pages mounts (`/repo/`) resolve to `/repo/_env-wasm/...`
 * instead of origin-absolute `/_env-wasm/...`. */
function siteRootUrl(fallbackOrigin: URL): URL {
  const scope = swSelf.registration?.scope;
  if (scope) {
    return new URL(scope);
  }
  return new URL("/", fallbackOrigin.origin);
}

async function fetchRHomeAsset(rHomeRelative: string, requestUrl: URL): Promise<Response | null> {
  const hostPrefixDir = tryGetHostPrefixDir();
  if (!hostPrefixDir) {
    httpuvDebugLog("sw-static-miss", {
      path: rHomeRelative,
      reason: "hostPrefix not configured",
    });
    return null;
  }
  const assetUrl = new URL(rHomeAssetHttpPath(hostPrefixDir, rHomeRelative), siteRootUrl(requestUrl));
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

/** Serve Shiny web dependencies from the preloaded wasm prefix (no R eval). */
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

  const toStaticResponse = (
    assetRes: Response,
    source: string,
  ): Response => {
    const headers = new Headers(assetRes.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", mimeForAssetSuffix(suffix));
    }
    headers.set("X-Httpuv-Static", source);
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(assetRes.body, { status: 200, headers });
  };

  // 1. Known R library layout (bootstrap JS, bslib components, jquery, …).
  const fallbackPath = resolveShinyStaticRHomePath(prefix, suffix);
  if (fallbackPath) {
    const assetRes = await fetchRHomeAsset(fallbackPath, url);
    if (assetRes) {
      httpuvDebugLog("sw-static-hit", { prefix, suffix, source: "rhome-fallback", path: fallbackPath });
      return toStaticResponse(assetRes, "rhome-fallback");
    }
  }

  // 2. Synced shiny::resourcePaths() directories.
  const localDir = shinyResourcePaths.get(prefix);
  if (localDir) {
    if (localDir.startsWith(`${WASM_R_HOME}/`)) {
      const rHomeRelative = rHomePathFromVfsDir(localDir, suffix);
      if (rHomeRelative) {
        const assetRes = await fetchRHomeAsset(rHomeRelative, url);
        if (assetRes) {
          httpuvDebugLog("sw-static-hit", { prefix, suffix, source: "rhome", path: rHomeRelative });
          return toStaticResponse(assetRes, "rhome");
        }
      }
    } else {
      // Runtime bslib/sass cache (not under /lib/R/): read from Emscripten VFS
      // via the worker without an R eval (avoids WASM traps on large base64 JSON).
      try {
        const host = await waitForRwasmHost();
        const body = await host.readVfsFile(localDir, suffix);
        if (body) {
          httpuvDebugLog("sw-static-hit", { prefix, suffix, source: "vfs", path: localDir });
          const headers = new Headers({
            "Content-Type": mimeForAssetSuffix(suffix),
            "X-Httpuv-Static": "vfs",
          });
          if (request.method === "HEAD") {
            return new Response(null, { status: 200, headers });
          }
          return new Response(body, { status: 200, headers });
        }
      } catch (err) {
        httpuvDebugLog("sw-vfs-read-fail", { prefix, suffix, vfsDir: localDir, err: String(err) });
      }
    }
  }

  return null;
}

swSelf.addEventListener("install", (event) => {
  httpuvDebugLog("sw-install", { shinyPrefix: SHINY_PREFIX });
  event.waitUntil(swSelf.skipWaiting());
});

swSelf.addEventListener("activate", (event) => {
  httpuvDebugLog("sw-activate", { shinyPrefix: SHINY_PREFIX });
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
    httpuvDebugLog("sw-app-cache-store", { url });
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
        httpuvDebugLog("sw-response-orphan", { uuid: msg.uuid });
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
        httpuvDebugLog("sw-ws-push-missing-handle");
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
      httpuvDebugLog("sw-unknown-push", { type: msg.type });
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
      await waitForRwasmHost();
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
  if (msg === "skipWaiting" || msg?.type === "SKIP_WAITING") {
    void swSelf.skipWaiting();
    return;
  }
  if (!msg || typeof msg !== "object") {
    return;
  }

  if (msg.type === COMLINK.PORT_HANDOFF && event.ports[0]) {
    const port = event.ports[0];
    port.start();
    // Soft roll: keep in-flight waitForRwasmHost() waiters alive across handoff.
    rollRwasmHostWaiter();
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
      if (typeof msg.hostPrefix === "string" && msg.hostPrefix) {
        setHostPrefixDir(msg.hostPrefix);
      }
      const source = event.source;
      if (source && "id" in source) {
        hostClientId = source.id;
        httpuvDebugLog("sw-host-registered", { hostClientId });
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
      resetRwasmHostWaiter(new Error("httpuv stopped"));
      break;
    }

    default:
      break;
  }
});
