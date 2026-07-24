var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/constants.ts
var WS_FRAME = {
  SEND: "websocket.send"};
var WASM_R_HOME = "/lib/R";
var REQUEST_TIMEOUT_MS = 18e4;
var SESSION_RECV_TIMEOUT_MS = 25e3;
var MSG = {
  REGISTER_HOST: "httpuv_register_host",
  HTTP_RESPONSE: "httpuv_http_response",
  WS_PUSH: "httpuv_ws_push",
  STOP: "httpuv_stop",
  /** Drop cached GET /shiny/ without tearing down the R worker (app restart). */
  CLEAR_APP_CACHE: "httpuv_clear_app_cache",
  /** Ask the SW to refresh shiny::resourcePaths() from the R worker. */
  SYNC_RESOURCE_PATHS: "httpuv_sync_resource_paths",
  /** R worker -> SW mapping of addResourcePath prefixes to VFS directories. */
  REGISTER_RESOURCE_PATHS: "httpuv_register_resource_paths",
  /** SW -> host: Comlink to the R worker was lost (e.g. after SW update). */
  REQUEST_COMLINK: "httpuv_request_comlink"
};
var WARMUP_REQUEST_HEADER = "X-Shiny-Forge-Warmup";
var COMLINK = {
  PORT_HANDOFF: "httpuv_comlink_port"
};

// node_modules/comlink/dist/esm/comlink.mjs
var comlink_exports = {};
__export(comlink_exports, {
  createEndpoint: () => createEndpoint,
  expose: () => expose,
  finalizer: () => finalizer,
  proxy: () => proxy,
  proxyMarker: () => proxyMarker,
  releaseProxy: () => releaseProxy,
  transfer: () => transfer,
  transferHandlers: () => transferHandlers,
  windowEndpoint: () => windowEndpoint,
  wrap: () => wrap
});
var proxyMarker = /* @__PURE__ */ Symbol("Comlink.proxy");
var createEndpoint = /* @__PURE__ */ Symbol("Comlink.endpoint");
var releaseProxy = /* @__PURE__ */ Symbol("Comlink.releaseProxy");
var finalizer = /* @__PURE__ */ Symbol("Comlink.finalizer");
var throwMarker = /* @__PURE__ */ Symbol("Comlink.thrown");
var isObject = (val) => typeof val === "object" && val !== null || typeof val === "function";
var proxyTransferHandler = {
  canHandle: (val) => isObject(val) && val[proxyMarker],
  serialize(obj) {
    const { port1, port2 } = new MessageChannel();
    expose(obj, port1);
    return [port2, [port2]];
  },
  deserialize(port) {
    port.start();
    return wrap(port);
  }
};
var throwTransferHandler = {
  canHandle: (value) => isObject(value) && throwMarker in value,
  serialize({ value }) {
    let serialized;
    if (value instanceof Error) {
      serialized = {
        isError: true,
        value: {
          message: value.message,
          name: value.name,
          stack: value.stack
        }
      };
    } else {
      serialized = { isError: false, value };
    }
    return [serialized, []];
  },
  deserialize(serialized) {
    if (serialized.isError) {
      throw Object.assign(new Error(serialized.value.message), serialized.value);
    }
    throw serialized.value;
  }
};
var transferHandlers = /* @__PURE__ */ new Map([
  ["proxy", proxyTransferHandler],
  ["throw", throwTransferHandler]
]);
function isAllowedOrigin(allowedOrigins, origin) {
  for (const allowedOrigin of allowedOrigins) {
    if (origin === allowedOrigin || allowedOrigin === "*") {
      return true;
    }
    if (allowedOrigin instanceof RegExp && allowedOrigin.test(origin)) {
      return true;
    }
  }
  return false;
}
function expose(obj, ep = globalThis, allowedOrigins = ["*"]) {
  ep.addEventListener("message", function callback(ev) {
    if (!ev || !ev.data) {
      return;
    }
    if (!isAllowedOrigin(allowedOrigins, ev.origin)) {
      console.warn(`Invalid origin '${ev.origin}' for comlink proxy`);
      return;
    }
    const { id, type, path } = Object.assign({ path: [] }, ev.data);
    const argumentList = (ev.data.argumentList || []).map(fromWireValue);
    let returnValue;
    try {
      const parent = path.slice(0, -1).reduce((obj2, prop) => obj2[prop], obj);
      const rawValue = path.reduce((obj2, prop) => obj2[prop], obj);
      switch (type) {
        case "GET":
          {
            returnValue = rawValue;
          }
          break;
        case "SET":
          {
            parent[path.slice(-1)[0]] = fromWireValue(ev.data.value);
            returnValue = true;
          }
          break;
        case "APPLY":
          {
            returnValue = rawValue.apply(parent, argumentList);
          }
          break;
        case "CONSTRUCT":
          {
            const value = new rawValue(...argumentList);
            returnValue = proxy(value);
          }
          break;
        case "ENDPOINT":
          {
            const { port1, port2 } = new MessageChannel();
            expose(obj, port2);
            returnValue = transfer(port1, [port1]);
          }
          break;
        case "RELEASE":
          {
            returnValue = void 0;
          }
          break;
        default:
          return;
      }
    } catch (value) {
      returnValue = { value, [throwMarker]: 0 };
    }
    Promise.resolve(returnValue).catch((value) => {
      return { value, [throwMarker]: 0 };
    }).then((returnValue2) => {
      const [wireValue, transferables] = toWireValue(returnValue2);
      ep.postMessage(Object.assign(Object.assign({}, wireValue), { id }), transferables);
      if (type === "RELEASE") {
        ep.removeEventListener("message", callback);
        closeEndPoint(ep);
        if (finalizer in obj && typeof obj[finalizer] === "function") {
          obj[finalizer]();
        }
      }
    }).catch((error) => {
      const [wireValue, transferables] = toWireValue({
        value: new TypeError("Unserializable return value"),
        [throwMarker]: 0
      });
      ep.postMessage(Object.assign(Object.assign({}, wireValue), { id }), transferables);
    });
  });
  if (ep.start) {
    ep.start();
  }
}
function isMessagePort(endpoint) {
  return endpoint.constructor.name === "MessagePort";
}
function closeEndPoint(endpoint) {
  if (isMessagePort(endpoint))
    endpoint.close();
}
function wrap(ep, target) {
  const pendingListeners = /* @__PURE__ */ new Map();
  ep.addEventListener("message", function handleMessage(ev) {
    const { data } = ev;
    if (!data || !data.id) {
      return;
    }
    const resolver = pendingListeners.get(data.id);
    if (!resolver) {
      return;
    }
    try {
      resolver(data);
    } finally {
      pendingListeners.delete(data.id);
    }
  });
  return createProxy(ep, pendingListeners, [], target);
}
function throwIfProxyReleased(isReleased) {
  if (isReleased) {
    throw new Error("Proxy has been released and is not useable");
  }
}
function releaseEndpoint(ep) {
  return requestResponseMessage(ep, /* @__PURE__ */ new Map(), {
    type: "RELEASE"
  }).then(() => {
    closeEndPoint(ep);
  });
}
var proxyCounter = /* @__PURE__ */ new WeakMap();
var proxyFinalizers = "FinalizationRegistry" in globalThis && new FinalizationRegistry((ep) => {
  const newCount = (proxyCounter.get(ep) || 0) - 1;
  proxyCounter.set(ep, newCount);
  if (newCount === 0) {
    releaseEndpoint(ep);
  }
});
function registerProxy(proxy2, ep) {
  const newCount = (proxyCounter.get(ep) || 0) + 1;
  proxyCounter.set(ep, newCount);
  if (proxyFinalizers) {
    proxyFinalizers.register(proxy2, ep, proxy2);
  }
}
function unregisterProxy(proxy2) {
  if (proxyFinalizers) {
    proxyFinalizers.unregister(proxy2);
  }
}
function createProxy(ep, pendingListeners, path = [], target = function() {
}) {
  let isProxyReleased = false;
  const proxy2 = new Proxy(target, {
    get(_target, prop) {
      throwIfProxyReleased(isProxyReleased);
      if (prop === releaseProxy) {
        return () => {
          unregisterProxy(proxy2);
          releaseEndpoint(ep);
          pendingListeners.clear();
          isProxyReleased = true;
        };
      }
      if (prop === "then") {
        if (path.length === 0) {
          return { then: () => proxy2 };
        }
        const r = requestResponseMessage(ep, pendingListeners, {
          type: "GET",
          path: path.map((p) => p.toString())
        }).then(fromWireValue);
        return r.then.bind(r);
      }
      return createProxy(ep, pendingListeners, [...path, prop]);
    },
    set(_target, prop, rawValue) {
      throwIfProxyReleased(isProxyReleased);
      const [value, transferables] = toWireValue(rawValue);
      return requestResponseMessage(ep, pendingListeners, {
        type: "SET",
        path: [...path, prop].map((p) => p.toString()),
        value
      }, transferables).then(fromWireValue);
    },
    apply(_target, _thisArg, rawArgumentList) {
      throwIfProxyReleased(isProxyReleased);
      const last = path[path.length - 1];
      if (last === createEndpoint) {
        return requestResponseMessage(ep, pendingListeners, {
          type: "ENDPOINT"
        }).then(fromWireValue);
      }
      if (last === "bind") {
        return createProxy(ep, pendingListeners, path.slice(0, -1));
      }
      const [argumentList, transferables] = processArguments(rawArgumentList);
      return requestResponseMessage(ep, pendingListeners, {
        type: "APPLY",
        path: path.map((p) => p.toString()),
        argumentList
      }, transferables).then(fromWireValue);
    },
    construct(_target, rawArgumentList) {
      throwIfProxyReleased(isProxyReleased);
      const [argumentList, transferables] = processArguments(rawArgumentList);
      return requestResponseMessage(ep, pendingListeners, {
        type: "CONSTRUCT",
        path: path.map((p) => p.toString()),
        argumentList
      }, transferables).then(fromWireValue);
    }
  });
  registerProxy(proxy2, ep);
  return proxy2;
}
function myFlat(arr) {
  return Array.prototype.concat.apply([], arr);
}
function processArguments(argumentList) {
  const processed = argumentList.map(toWireValue);
  return [processed.map((v) => v[0]), myFlat(processed.map((v) => v[1]))];
}
var transferCache = /* @__PURE__ */ new WeakMap();
function transfer(obj, transfers) {
  transferCache.set(obj, transfers);
  return obj;
}
function proxy(obj) {
  return Object.assign(obj, { [proxyMarker]: true });
}
function windowEndpoint(w, context = globalThis, targetOrigin = "*") {
  return {
    postMessage: (msg, transferables) => w.postMessage(msg, targetOrigin, transferables),
    addEventListener: context.addEventListener.bind(context),
    removeEventListener: context.removeEventListener.bind(context)
  };
}
function toWireValue(value) {
  for (const [name, handler] of transferHandlers) {
    if (handler.canHandle(value)) {
      const [serializedValue, transferables] = handler.serialize(value);
      return [
        {
          type: "HANDLER",
          name,
          value: serializedValue
        },
        transferables
      ];
    }
  }
  return [
    {
      type: "RAW",
      value
    },
    transferCache.get(value) || []
  ];
}
function fromWireValue(value) {
  switch (value.type) {
    case "HANDLER":
      return transferHandlers.get(value.name).deserialize(value.value);
    case "RAW":
      return value.value;
  }
}
function requestResponseMessage(ep, pendingListeners, msg, transfers) {
  return new Promise((resolve) => {
    const id = generateUUID();
    pendingListeners.set(id, resolve);
    if (ep.start) {
      ep.start();
    }
    ep.postMessage(Object.assign({ id }, msg), transfers);
  });
}
function generateUUID() {
  return new Array(4).fill(0).map(() => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16)).join("-");
}

// src/comlink.ts
function createSwDeliveryApi(deliverOutbound) {
  return {
    deliverHttpResponse(resp) {
      deliverOutbound({
        type: MSG.HTTP_RESPONSE,
        uuid: resp.uuid,
        status: resp.status ?? 500,
        headers: resp.headers ?? {},
        body: resp.body ?? null
      });
    },
    deliverWsPush(msg) {
      deliverOutbound({
        type: MSG.WS_PUSH,
        handle: msg.handle,
        binary: msg.binary ?? false,
        wsType: msg.wsType,
        message: msg.message ?? null
      });
    }
  };
}

// src/debug.ts
function isHttpuvDebug() {
  if (globalThis.__HTTPUV_DEBUG__) {
    return true;
  }
  try {
    if (typeof location !== "undefined") {
      const params = new URLSearchParams(location.search);
      if (params.has("httpuvDebug") || params.get("debug") === "httpuv") {
        return true;
      }
    }
    if (typeof localStorage !== "undefined" && localStorage.getItem("shinyForgeDebug") === "1") {
      return true;
    }
    if (typeof self !== "undefined" && self.location?.href) {
      const params = new URL(self.location.href).searchParams;
      if (params.has("httpuvDebug") || params.get("debug") === "httpuv") {
        return true;
      }
    }
  } catch {
  }
  return false;
}
function httpuvDebugLog(stage, ...args) {
  if (!isHttpuvDebug()) {
    return;
  }
  console.info(`[httpuv-debug:${stage}]`, ...args);
}

// src/prefix.ts
var hostPrefixDir = null;
function normalizeHostPrefixDir(prefix) {
  return prefix.replace(/^\/+|\/+$/g, "");
}
function setHostPrefixDir(prefix) {
  hostPrefixDir = normalizeHostPrefixDir(prefix);
}
function tryGetHostPrefixDir() {
  return hostPrefixDir;
}
function resolveShinyPrefix(fromUrl) {
  const prefix = new URL("shiny/", fromUrl).pathname;
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}
var SESSION_DIR = "__session__";
var HOST_DIR = "__host__";
function normalizeSessionHandle(handle) {
  let s = String(handle ?? "").trim();
  while (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  return s;
}
function resolveSessionPrefix(fromUrl) {
  return `${resolveShinyPrefix(fromUrl)}${SESSION_DIR}/`;
}
function parseSessionAction(urlString, prefix) {
  const url = new URL(urlString);
  const sessionPrefix = `${prefix}${SESSION_DIR}/`;
  if (!url.pathname.startsWith(sessionPrefix)) {
    return null;
  }
  const action = url.pathname.slice(sessionPrefix.length).replace(/\/$/, "");
  if (!["open", "send", "recv", "close"].includes(action)) {
    return null;
  }
  const rawHandle = url.searchParams.get("handle");
  return {
    action,
    handle: rawHandle ? normalizeSessionHandle(rawHandle) : null
  };
}
function isHostPushUrl(urlString, prefix) {
  const url = new URL(urlString);
  return url.pathname === `${prefix}${HOST_DIR}/push`;
}

// src/static-resolve.ts
function rHomeAssetHttpPath(hostPrefixDir2, rHomeRelative) {
  const hostPrefix = hostPrefixDir2.replace(/^\/+|\/+$/g, "");
  const rel = rHomeRelative.replace(/^\/+/, "");
  return `${hostPrefix}${WASM_R_HOME}/${rel}`.replace(/\/+/g, "/").replace(/^\//, "");
}
var WASM_R_HOME_PREFIX = `${WASM_R_HOME}/`;
var SHINY_STATIC_BASES = [
  { match: (p) => p.startsWith("jquery-"), base: "library/shiny/www/shared" },
  { match: (p) => p.startsWith("shiny-css-"), base: "library/shiny/www/shared" },
  { match: (p) => p.startsWith("shiny-javascript-"), base: "library/shiny/www/shared" },
  {
    match: (p) => p.startsWith("shiny-busy-indicators-"),
    base: "library/shiny/www/shared/busy-indicators"
  },
  { match: (p) => p.startsWith("htmltools-fill-"), base: "library/htmltools/fill" },
  { match: (p) => p.startsWith("strftime-"), base: "library/shiny/www/shared/strftime" },
  {
    match: (p) => p.startsWith("ionrangeslider-javascript-"),
    base: "library/shiny/www/shared/ionrangeslider"
  }
];
function resolveKnownAsset(prefix, suffix) {
  if (prefix.startsWith("bootstrap-5")) {
    if (suffix.endsWith(".js")) {
      return `library/bslib/lib/bs5/dist/js/${basename(suffix)}`;
    }
    if (suffix === "bootstrap.min.css") {
      return "library/bslib/css-precompiled/5/bootstrap.min.css";
    }
    return null;
  }
  if (prefix.startsWith("bslib-component-js-")) {
    return `library/bslib/components/dist/${suffix}`;
  }
  if (prefix.startsWith("bslib-component-css-")) {
    return `library/bslib/components/dist/${suffix}`;
  }
  if (prefix.startsWith("bslib-tag-require-")) {
    return "library/bslib/components/tag-require.js";
  }
  if (prefix.startsWith("bs3compat-")) {
    return `library/bslib/bs3compat/js/${suffix}`;
  }
  if (prefix.startsWith("shiny-javascript-")) {
    return "library/shiny/www/shared/shiny.min.js";
  }
  if (prefix.startsWith("jquery-")) {
    return `library/shiny/www/shared/${suffix}`;
  }
  if (prefix.startsWith("selectize-") || prefix.startsWith("ionRangeSlider-") || prefix.startsWith("shiny-sass-")) {
    return null;
  }
  return null;
}
function basename(path) {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}
function resolveShinyStaticRHomePath(prefix, suffix) {
  if (!prefix || !suffix || suffix.includes("..")) {
    return null;
  }
  const known = resolveKnownAsset(prefix, suffix);
  if (known) {
    return known;
  }
  for (const rule of SHINY_STATIC_BASES) {
    if (rule.match(prefix)) {
      return `${rule.base}/${suffix}`.replace(/\/+/g, "/");
    }
  }
  return null;
}
function rHomePathFromVfsDir(vfsDir, suffix) {
  if (!vfsDir || !suffix || suffix.includes("..")) {
    return null;
  }
  const normalized = vfsDir.replace(/\/$/, "");
  if (!normalized.startsWith(WASM_R_HOME_PREFIX)) {
    return null;
  }
  const fetchPath = normalized.slice(WASM_R_HOME_PREFIX.length);
  return `${fetchPath}/${suffix}`.replace(/\/+/g, "/");
}

// src/sw.ts
var swSelf = self;
function initialShinyPrefix() {
  try {
    const own = new URL(swSelf.location.href);
    const declared = own.searchParams.get("shinyPrefix");
    if (declared) {
      return declared.endsWith("/") ? declared : `${declared}/`;
    }
  } catch {
  }
  return resolveShinyPrefix(new URL("/", swSelf.location.href).href);
}
function initialHostPrefixDir() {
  try {
    const own = new URL(swSelf.location.href);
    const declared = own.searchParams.get("hostPrefix");
    if (declared) {
      return declared.replace(/^\/+|\/+$/g, "");
    }
  } catch {
  }
  return null;
}
var declaredHostPrefixDir = initialHostPrefixDir();
if (declaredHostPrefixDir) {
  setHostPrefixDir(declaredHostPrefixDir);
}
var SHINY_PREFIX = initialShinyPrefix();
resolveSessionPrefix(new URL("/", swSelf.location.href).href);
var shinyAppPrefix = SHINY_PREFIX;
var hostClientId = null;
var rwasmHost = null;
var rwasmHostReadyResolve = null;
var rwasmHostReady = new Promise((resolve) => {
  rwasmHostReadyResolve = resolve;
});
async function connectSwToWorker(port) {
  const workerHost = comlink_exports.wrap(port);
  const deliveryChannel = new MessageChannel();
  comlink_exports.expose(
    createSwDeliveryApi((msg) => handleHostOutboundMessage(msg)),
    deliveryChannel.port1
  );
  try {
    await workerHost.registerSwDelivery(
      comlink_exports.transfer(deliveryChannel.port2, [deliveryChannel.port2])
    );
    rwasmHost = workerHost;
    markRwasmHostReady();
    console.info("[httpuv-sw] Comlink: unified session connected");
  } catch (err) {
    console.error("[httpuv-sw] Comlink unified setup failed", err);
    resetRwasmHostWaiter();
  }
}
function markRwasmHostReady() {
  if (rwasmHostReadyResolve) {
    rwasmHostReadyResolve();
    rwasmHostReadyResolve = null;
  }
}
function resetRwasmHostWaiter() {
  rwasmHost = null;
  rwasmHostReady = new Promise((resolve) => {
    rwasmHostReadyResolve = resolve;
  });
}
async function waitForRwasmHost(timeoutMs = REQUEST_TIMEOUT_MS) {
  if (rwasmHost) {
    return rwasmHost;
  }
  let timer;
  const timeout = new Promise((_, reject) => {
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
async function requestComlinkFromHost() {
  const client = await getHostClient();
  client?.postMessage({ type: MSG.REQUEST_COMLINK });
}
var pendingHttp = /* @__PURE__ */ new Map();
var pendingRecv = /* @__PURE__ */ new Map();
var queuedWsPush = /* @__PURE__ */ new Map();
var cachedAppDocument = null;
var shinyResourcePaths = /* @__PURE__ */ new Map();
function isAppDocumentRequest(urlString) {
  const url = new URL(urlString);
  if (!url.pathname.startsWith(shinyAppPrefix)) {
    return false;
  }
  const rest = url.pathname.slice(shinyAppPrefix.length).replace(/\/$/, "");
  return rest === "" || rest === "index.html";
}
function pathUnderShinyPrefix(pathname) {
  return pathname.startsWith(shinyAppPrefix) || pathname.startsWith(SHINY_PREFIX);
}
function clonePendingResponse(resp) {
  let body = resp.body;
  if (body instanceof ArrayBuffer) {
    body = body.slice(0);
  } else if (body instanceof Uint8Array) {
    body = body.slice();
  }
  return {
    status: resp.status,
    headers: { ...resp.headers ?? {} },
    body
  };
}
function clearCachedAppDocument() {
  cachedAppDocument = null;
}
function clearShinyResourcePaths() {
  shinyResourcePaths = /* @__PURE__ */ new Map();
}
function setShinyResourcePaths(paths) {
  shinyResourcePaths = /* @__PURE__ */ new Map();
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
      [...shinyResourcePaths.keys()].join(", ")
    );
  }
}
function mimeForAssetSuffix(suffix) {
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
function siteRootUrl(fallbackOrigin) {
  const scope = swSelf.registration?.scope;
  if (scope) {
    return new URL(scope);
  }
  return new URL("/", fallbackOrigin.origin);
}
async function fetchRHomeAsset(rHomeRelative, requestUrl) {
  const hostPrefixDir2 = tryGetHostPrefixDir();
  if (!hostPrefixDir2) {
    httpuvDebugLog("sw-static-miss", {
      path: rHomeRelative,
      reason: "hostPrefix not configured"
    });
    return null;
  }
  const assetUrl = new URL(rHomeAssetHttpPath(hostPrefixDir2, rHomeRelative), siteRootUrl(requestUrl));
  const assetRes = await fetch(assetUrl, { cache: "force-cache" });
  if (!assetRes.ok) {
    httpuvDebugLog("sw-static-miss", {
      path: rHomeRelative,
      status: assetRes.status,
      url: assetUrl.href
    });
    return null;
  }
  return assetRes;
}
async function tryServeShinyStaticAsset(request) {
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
  const toStaticResponse = (assetRes, source) => {
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
  const fallbackPath = resolveShinyStaticRHomePath(prefix, suffix);
  if (fallbackPath) {
    const assetRes = await fetchRHomeAsset(fallbackPath, url);
    if (assetRes) {
      httpuvDebugLog("sw-static-hit", { prefix, suffix, source: "rhome-fallback", path: fallbackPath });
      return toStaticResponse(assetRes, "rhome-fallback");
    }
  }
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
      try {
        const host = await waitForRwasmHost();
        const body = await host.readVfsFile(localDir, suffix);
        if (body) {
          httpuvDebugLog("sw-static-hit", { prefix, suffix, source: "vfs", path: localDir });
          const headers = new Headers({
            "Content-Type": mimeForAssetSuffix(suffix),
            "X-Httpuv-Static": "vfs"
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
  console.info("[httpuv-sw] installing, shiny prefix:", SHINY_PREFIX);
  event.waitUntil(swSelf.skipWaiting());
});
swSelf.addEventListener("activate", (event) => {
  console.info("[httpuv-sw] activated, shiny prefix:", SHINY_PREFIX);
  resetRwasmHostWaiter();
  event.waitUntil(swSelf.clients.claim());
});
function waitForHttpResponse(uuid, url, method) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHttp.delete(uuid);
      httpuvDebugLog("sw-timeout", { uuid, timeoutMs: REQUEST_TIMEOUT_MS });
      reject(new Error(`httpuv request ${uuid} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    pendingHttp.set(uuid, { resolve, reject, timer, url, method });
  });
}
function maybeCacheAppDocument(resp, url, method) {
  if (url && method === "GET" && isAppDocumentRequest(url) && resp.status === 200) {
    cachedAppDocument = clonePendingResponse(resp);
    console.info("[httpuv-sw] cached app document", url);
  }
}
function toFetchResponse(resp) {
  const headers = new Headers(resp.headers ?? {});
  if (resp.body == null) {
    return new Response(null, { status: resp.status, headers });
  }
  return new Response(resp.body, { status: resp.status, headers });
}
async function headersToObject(request) {
  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}
function messageBodyLength(message) {
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
function deliverWsPush(handle, msg) {
  const key = normalizeSessionHandle(handle);
  const queue = pendingRecv.get(key);
  httpuvDebugLog("sw-ws-push", {
    handle: key,
    wsType: msg.wsType,
    messageLen: messageBodyLength(msg.message),
    recvWaiters: queue?.length ?? 0,
    queuedBefore: queuedWsPush.get(key)?.length ?? 0
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
      new Response(msg.message ?? null, {
        status: 200,
        headers
      })
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
async function handleSessionRecv(event) {
  const url = new URL(event.request.url);
  const handle = normalizeSessionHandle(url.searchParams.get("handle"));
  httpuvDebugLog("sw-recv", { handle, url: url.href });
  if (!handle) {
    return new Response("missing handle query parameter", {
      status: 400,
      headers: { "Content-Type": "text/plain" }
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
    return new Response(msg?.message ?? null, { status: 200, headers });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const waiters2 = pendingRecv.get(handle);
      if (!waiters2) {
        return;
      }
      const idx = waiters2.findIndex((w) => w.timer === timer);
      if (idx !== -1) {
        waiters2.splice(idx, 1);
      }
      if (waiters2.length === 0) {
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
async function getHostClient() {
  if (hostClientId) {
    const client = await swSelf.clients.get(hostClientId);
    if (client) {
      return client;
    }
  }
  const clients = await swSelf.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });
  return clients[0];
}
function handleHostOutboundMessage(msg) {
  switch (msg.type) {
    case MSG.HTTP_RESPONSE: {
      httpuvDebugLog("sw-response", { uuid: msg.uuid, status: msg.status });
      const pending = msg.uuid ? pendingHttp.get(msg.uuid) : void 0;
      if (!pending || !msg.uuid) {
        console.warn("[httpuv-sw] No pending request for", msg.uuid);
        return;
      }
      clearTimeout(pending.timer);
      pendingHttp.delete(msg.uuid);
      const resp = {
        status: msg.status ?? 500,
        headers: msg.headers ?? {},
        body: msg.body ?? null
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
        messageLen: messageBodyLength(msg.message)
      });
      deliverWsPush(normalizeSessionHandle(msg.handle), msg);
      break;
    }
    default:
      console.warn("[httpuv-sw] Ignoring unknown host push message", msg.type);
  }
}
async function handleHostPush(event) {
  try {
    const msg = await event.request.json();
    handleHostOutboundMessage(msg);
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error("[httpuv-sw] host push failed", err);
    return new Response("bad host push payload", { status: 400 });
  }
}
async function handleShinyFetch(event) {
  const request = event.request;
  const uuid = crypto.randomUUID();
  httpuvDebugLog("sw-request", { uuid, method: request.method, url: request.url });
  const bypassAppCache = request.headers.get(WARMUP_REQUEST_HEADER) === "1";
  if (request.method === "GET" && isAppDocumentRequest(request.url) && cachedAppDocument && !bypassAppCache) {
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
      await waitForRwasmHost(6e4);
    } catch (err) {
      console.error("[httpuv-sw] R worker not ready for", request.url, err);
      return new Response("Shiny R worker is not ready", {
        status: 503,
        headers: { "Content-Type": "text/plain" }
      });
    }
  }
  const host = rwasmHost;
  if (!host) {
    return new Response("Shiny R worker is not ready", {
      status: 503,
      headers: { "Content-Type": "text/plain" }
    });
  }
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const responsePromise = waitForHttpResponse(uuid, request.url, request.method);
  const payload = {
    uuid,
    method: request.method,
    url: request.url,
    headers: await headersToObject(request),
    body,
    clientId: event.clientId
  };
  const delivery = host.deliverHttpRequest(body ? comlink_exports.transfer(payload, [body]) : payload).catch((err) => {
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
      headers: { "Content-Type": "text/plain" }
    });
  }
}
swSelf.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!pathUnderShinyPrefix(url.pathname)) {
    return;
  }
  if (isHostPushUrl(event.request.url, shinyAppPrefix) || isHostPushUrl(event.request.url, SHINY_PREFIX)) {
    event.respondWith(handleHostPush(event));
    return;
  }
  const session = parseSessionAction(event.request.url, shinyAppPrefix) ?? parseSessionAction(event.request.url, SHINY_PREFIX);
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
      if (typeof msg.hostPrefix === "string" && msg.hostPrefix) {
        setHostPrefixDir(msg.hostPrefix);
      }
      const source = event.source;
      if (source && "id" in source) {
        hostClientId = source.id;
        console.info("[httpuv-sw] Registered host client", hostClientId);
      }
      break;
    }
    case MSG.HTTP_RESPONSE: {
      handleHostOutboundMessage(msg);
      break;
    }
    case MSG.WS_PUSH: {
      handleHostOutboundMessage(msg);
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
      void rwasmHost.getShinyResourcePaths().then((paths) => {
        setShinyResourcePaths(paths);
      }).catch((err) => {
        console.warn("[httpuv-sw] failed to sync resource paths", err);
      }).finally(finish);
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
        void rwasmHost.stop().catch((err) => {
          console.warn("[httpuv-sw] R worker stop failed", err);
        });
      }
      break;
    }
  }
});
/*! Bundled license information:

comlink/dist/esm/comlink.mjs:
  (**
   * @license
   * Copyright 2019 Google LLC
   * SPDX-License-Identifier: Apache-2.0
   *)
*/
//# sourceMappingURL=httpuv-sw.js.map
//# sourceMappingURL=httpuv-sw.js.map