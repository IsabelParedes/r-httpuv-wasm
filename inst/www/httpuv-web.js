// src/constants.ts
var WS_FRAME = {
  SEND: "websocket.send",
  CLOSE: "websocket.close"
};
var WASM_R_HOME = "/lib/R";
var REQUEST_TIMEOUT_MS = 18e4;
var SESSION_RECV_TIMEOUT_MS = 25e3;
var MSG = {
  REGISTER_HOST: "httpuv_register_host",
  HTTP_REQUEST: "httpuv_http_request",
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
var CHANNEL = {
  HTTP_REQUEST: "httpuv_http_request",
  TCP_RESPONSE: "httpuv_tcp_response",
  WS_OPEN: "httpuv_ws_open",
  WS_MESSAGE: "httpuv_ws_message",
  WS_CLOSE: "httpuv_ws_close",
  WS_RESPONSE: "httpuv_ws_response",
  STDIN: "stdin"
};
var HTTPUV_OPTIONS = {
  ON_REQUEST: "httpuv_onRequest",
  ON_WS_OPEN: "httpuv_onWSOpen",
  ON_WS_MESSAGE: "httpuv_onWSMessage",
  ON_WS_CLOSE: "httpuv_onWSClose"
};
var COMLINK = {
  PORT_HANDOFF: "httpuv_comlink_port"
};

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
function enableHttpuvDebug() {
  globalThis.__HTTPUV_DEBUG__ = true;
  try {
    localStorage.setItem("shinyForgeDebug", "1");
  } catch {
  }
  console.info(
    "[httpuv-debug] enabled - reload or run shinyForge.enableHttpuvDebug() then re-run app"
  );
}

// src/prefix.ts
var shinyPrefix = null;
var hostPrefixDir = null;
function normalizeHostPrefixDir(prefix) {
  return prefix.replace(/^\/+|\/+$/g, "");
}
function setHostPrefixDir(prefix) {
  hostPrefixDir = normalizeHostPrefixDir(prefix);
}
function getHostPrefixDir() {
  if (!hostPrefixDir) {
    throw new Error("Host prefix directory not initialized");
  }
  return hostPrefixDir;
}
function tryGetHostPrefixDir() {
  return hostPrefixDir;
}
function resolveShinyPrefix(fromUrl) {
  const prefix = new URL("shiny/", fromUrl).pathname;
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}
function setShinyPrefix(prefix) {
  shinyPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
}
function getShinyPrefix() {
  if (!shinyPrefix) {
    throw new Error("Shiny prefix not initialized");
  }
  return shinyPrefix;
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
function getSessionPrefix() {
  return `${getShinyPrefix()}${SESSION_DIR}/`;
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
function isSessionHttpRequest(urlString, prefix) {
  if (prefix) {
    const session = parseSessionAction(urlString, prefix);
    return session !== null && session.action !== "recv";
  }
  return /\/__session__\/(open|send|close)(?:\?|$|\/)/.test(urlString);
}
function isHostPushUrl(urlString, prefix) {
  const url = new URL(urlString);
  return url.pathname === `${prefix}${HOST_DIR}/push`;
}
function shinyAppUrl(subpath = "", fromUrl = import.meta.url) {
  const base = new URL("shiny/", fromUrl);
  return new URL(subpath.replace(/^\//, ""), base).href;
}

// src/bridge.ts
var invokeROption = null;
var pushToR = null;
function decodeBase64Body(data) {
  const text = String(data ?? "");
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
function encodeResponseBody(body) {
  if (body == null) {
    return null;
  }
  if (typeof body === "object" && !Array.isArray(body) && body.httpuvRaw === "base64") {
    return decodeBase64Body(body.data);
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  }
  if (Array.isArray(body)) {
    return new Uint8Array(body).buffer;
  }
  return String(body);
}
function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object") {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) {
      out[key] = String(value);
    }
  }
  return out;
}
function shinyPathInfo(pathname) {
  const shinyPrefix2 = getShinyPrefix();
  if (!pathname.startsWith(shinyPrefix2)) {
    return pathname || "/";
  }
  const rest = pathname.slice(shinyPrefix2.length).replace(/^\/+/, "");
  return rest ? `/${rest}` : "/";
}
function buildReq(msg) {
  const url = new URL(msg.url);
  const pathInfo = shinyPathInfo(url.pathname);
  const queryString = url.search.length > 1 ? url.search.slice(1) : "";
  const shinyPrefix2 = getShinyPrefix();
  const req = {
    UUID: msg.uuid,
    REQUEST_METHOD: msg.method,
    SCRIPT_NAME: shinyPrefix2.replace(/\/$/, ""),
    PATH_INFO: pathInfo,
    QUERY_STRING: queryString,
    "rook.version": "1.1-0",
    "rook.url_scheme": url.protocol === "https:" ? "https" : "http",
    SERVER_NAME: url.hostname,
    SERVER_PORT: url.port || (url.protocol === "https:" ? "443" : "80"),
    REMOTE_ADDR: "127.0.0.1",
    REMOTE_PORT: "0",
    HEADERS: { ...msg.headers ?? {} }
  };
  for (const [key, value] of Object.entries(msg.headers ?? {})) {
    req[`HTTP_${key.toUpperCase().replace(/-/g, "_")}`] = value;
  }
  if (msg.body) {
    req.body = msg.body;
    req.CONTENT_LENGTH = String(msg.body.byteLength);
  }
  return req;
}
function shinySocketScriptUrl() {
  return new URL("./shiny-socket.js", import.meta.url).pathname;
}
function injectShinySocketBootstrap(html) {
  const prefix = getShinyPrefix();
  const baseTag = html.includes("<base") ? "" : `<base href="${prefix}">`;
  const tag = `<script type="module" src="${shinySocketScriptUrl()}"><\/script>`;
  const injection = [baseTag, tag].filter(Boolean).join("\n  ");
  if (html.includes("<head")) {
    return html.replace(/<head([^>]*)>/, `<head$1>
  ${injection}`);
  }
  if (html.includes("<body")) {
    return html.replace(/<body([^>]*)>/, `<body$1>
  ${tag}`);
  }
  return `${tag}
${html}`;
}
function bodyToText(body) {
  if (body == null) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  if (Array.isArray(body)) {
    return new TextDecoder().decode(new Uint8Array(body));
  }
  return String(body);
}
function maybeInjectShinySocketBootstrap(body, headers) {
  const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
  if (!contentType.includes("text/html")) {
    return encodeResponseBody(body);
  }
  const html = bodyToText(body);
  if (!html) {
    return encodeResponseBody(body);
  }
  return injectShinySocketBootstrap(html);
}
function sessionMessageFromBody(body) {
  if (!body || body.byteLength === 0) {
    return { binary: false, message: "" };
  }
  const bytes = new Uint8Array(body);
  const isText = bytes.every((b) => b === 9 || b === 10 || b === 13 || b >= 32 && b <= 126);
  if (isText) {
    return { binary: false, message: new TextDecoder().decode(body) };
  }
  return { binary: true, message: body };
}
function handleSessionHttp(msg, session) {
  switch (session.action) {
    case "open": {
      const handle = normalizeSessionHandle(crypto.randomUUID());
      const req = buildReq(msg);
      pushInboundChannelMessage({ type: CHANNEL.WS_OPEN, handle, req });
      sendTcpResponse(
        msg.uuid ?? "",
        200,
        { "Content-Type": "application/json" },
        JSON.stringify({ handle })
      );
      break;
    }
    case "send": {
      if (!session.handle) {
        sendTcpResponse(msg.uuid ?? "", 400, { "Content-Type": "text/plain" }, "missing handle");
        return;
      }
      const { binary, message } = sessionMessageFromBody(msg.body);
      pushInboundChannelMessage({
        type: CHANNEL.WS_MESSAGE,
        handle: normalizeSessionHandle(session.handle),
        binary,
        message
      });
      sendTcpResponse(msg.uuid ?? "", 204, {}, null);
      break;
    }
    case "close": {
      if (!session.handle) {
        sendTcpResponse(msg.uuid ?? "", 400, { "Content-Type": "text/plain" }, "missing handle");
        return;
      }
      pushInboundChannelMessage({
        type: CHANNEL.WS_CLOSE,
        handle: normalizeSessionHandle(session.handle)
      });
      sendTcpResponse(msg.uuid ?? "", 204, {}, null);
      break;
    }
    default:
      sendTcpResponse(
        msg.uuid ?? "",
        404,
        { "Content-Type": "text/plain" },
        "unknown session action"
      );
  }
}
function sendTcpResponse(uuid, status, headers, body) {
  getChannel().write({
    type: CHANNEL.TCP_RESPONSE,
    uuid,
    data: {
      status,
      headers,
      body
    }
  });
}
function getServiceWorkerController() {
  return navigator.serviceWorker.controller;
}
function serializeBodyForChannel(body) {
  if (!body) {
    return null;
  }
  return Array.from(new Uint8Array(body));
}
function formatOutboundForHost(msg, deliver) {
  if (msg.type === CHANNEL.TCP_RESPONSE) {
    const headers = normalizeHeaders(msg.data?.headers);
    let body2;
    try {
      body2 = maybeInjectShinySocketBootstrap(msg.data?.body, headers);
    } catch (err) {
      console.warn("[httpuv-bridge] shiny socket bootstrap injection failed", err);
      body2 = encodeResponseBody(msg.data?.body);
    }
    const transfer2 = body2 instanceof ArrayBuffer ? [body2] : [];
    deliver(
      {
        type: MSG.HTTP_RESPONSE,
        uuid: msg.uuid,
        status: msg.data?.status ?? 500,
        headers,
        body: body2
      },
      transfer2
    );
    return;
  }
  const body = encodeResponseBody(msg.data?.message);
  const transfer = body instanceof ArrayBuffer ? [body] : [];
  if (msg.type === CHANNEL.WS_RESPONSE) {
    deliver(
      {
        type: MSG.WS_PUSH,
        handle: normalizeSessionHandle(msg.data?.handle),
        binary: msg.data?.binary ?? false,
        wsType: msg.data?.type ?? WS_FRAME.SEND,
        message: body
      },
      transfer
    );
  }
}
async function postToServiceWorker(msg) {
  const controller = getServiceWorkerController();
  formatOutboundForHost(msg, (outbound, transfer = []) => {
    if (msg.type === CHANNEL.TCP_RESPONSE) {
      if (controller) {
        controller.postMessage(outbound, transfer);
        return;
      }
      void fetch(shinyAppUrl("__host__/push"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(outbound)
      });
      return;
    }
    if (msg.type === CHANNEL.WS_RESPONSE) {
      if (controller) {
        controller.postMessage(outbound, transfer);
        return;
      }
      const outboundMsg = outbound;
      void fetch(shinyAppUrl("__host__/push"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...outbound,
          message: typeof outboundMsg.message === "string" ? outboundMsg.message : void 0
        })
      });
    }
  });
}
var postOutbound = null;
var deferredOutbound = [];
function flushDeferredOutbound() {
  if (deferredOutbound.length === 0) {
    return;
  }
  const batch = deferredOutbound.splice(0, deferredOutbound.length);
  for (const msg of batch) {
    postOutboundSync(msg);
  }
}
function postOutboundMaybeDefer(msg) {
  const depth = globalThis.Module?._rWasmEvalDepth ?? 0;
  if (depth > 0) {
    deferredOutbound.push(msg);
    if (msg.type === CHANNEL.TCP_RESPONSE) {
      httpuvDebugLog("channel-tcp-response-deferred", {
        uuid: msg.uuid,
        status: msg.data?.status,
        depth
      });
    }
    return;
  }
  if (msg.type === CHANNEL.TCP_RESPONSE) {
    httpuvDebugLog("channel-tcp-response", {
      uuid: msg.uuid,
      status: msg.data?.status
    });
  }
  postOutboundSync(msg);
}
function postOutboundSync(msg) {
  if (postOutbound) {
    formatOutboundForHost(msg, (outbound, transfer = []) => {
      postOutbound?.(outbound, transfer);
    });
    return;
  }
  void postToServiceWorker(msg);
}
function createChannel() {
  const inbox = [];
  return {
    inbox,
    hasMessage() {
      return inbox.length > 0;
    },
    read() {
      return inbox.shift() ?? { type: CHANNEL.STDIN };
    },
    write(msg) {
      if (msg.type === CHANNEL.TCP_RESPONSE || msg.type === CHANNEL.WS_RESPONSE) {
        postOutboundMaybeDefer(msg);
        return;
      }
      console.warn(
        "[httpuv-bridge] inbound channel.write is deprecated; use pushInboundChannelMessage",
        msg.type
      );
      pushInboundChannelMessage(msg);
    }
  };
}
function dispatch(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
    return;
  }
  switch (msg.type) {
    case CHANNEL.HTTP_REQUEST: {
      const req = buildReq(msg);
      const handled = invokeROption?.(HTTPUV_OPTIONS.ON_REQUEST, req) ?? false;
      if (!handled) {
        sendTcpResponse(
          msg.uuid ?? "",
          503,
          { "Content-Type": "text/plain" },
          "httpuv: no R handler registered"
        );
      }
      break;
    }
    case CHANNEL.WS_OPEN: {
      const handled = invokeROption?.(HTTPUV_OPTIONS.ON_WS_OPEN, msg.handle, msg.req) ?? false;
      if (!handled) {
        httpuvDebugLog("bridge-ws-open-no-handler", msg.handle);
      }
      break;
    }
    case CHANNEL.WS_MESSAGE: {
      const handled = invokeROption?.(
        HTTPUV_OPTIONS.ON_WS_MESSAGE,
        msg.handle,
        msg.binary,
        msg.message
      ) ?? false;
      if (!handled) {
        httpuvDebugLog("bridge-ws-message-no-handler", msg.handle);
        getChannel().write({
          type: CHANNEL.WS_RESPONSE,
          data: {
            handle: msg.handle,
            binary: msg.binary,
            type: WS_FRAME.SEND,
            message: msg.message
          }
        });
      }
      break;
    }
    case CHANNEL.WS_CLOSE: {
      invokeROption?.(HTTPUV_OPTIONS.ON_WS_CLOSE, msg.handle);
      break;
    }
    default:
      console.warn("[httpuv-bridge] unhandled channel message", msg.type);
  }
}
function drainInboundChannel() {
  const channel = getChannel();
  while (channel.hasMessage()) {
    const msg = channel.read();
    if (msg.type === CHANNEL.STDIN) {
      continue;
    }
    dispatch(msg);
  }
}
function getChannel() {
  const httpuv = ensureModuleHttpuv();
  if (!httpuv.channel) {
    httpuv.channel = createChannel();
  }
  return httpuv.channel;
}
function ensureModuleHttpuv() {
  globalThis.Module = globalThis.Module ?? {};
  globalThis.Module.httpuv = globalThis.Module.httpuv ?? {};
  return globalThis.Module.httpuv;
}
function pushInboundChannelMessage(msg) {
  if (!pushToR) {
    console.warn("[httpuv-bridge] pushToR not configured");
    return false;
  }
  pushToR(msg);
  return true;
}
function pushInboundHostMessage(msg) {
  if (!msg || typeof msg !== "object") {
    return;
  }
  switch (msg.type) {
    case MSG.HTTP_REQUEST: {
      const session = parseSessionAction(msg.url ?? "", getShinyPrefix());
      if (session && session.action !== "recv") {
        httpuvDebugLog("bridge-inbound-session", {
          uuid: msg.uuid,
          action: session.action,
          handle: session.handle
        });
        handleSessionHttp(msg, session);
        break;
      }
      httpuvDebugLog("bridge-push-http", {
        uuid: msg.uuid,
        method: msg.method,
        url: msg.url
      });
      pushInboundChannelMessage({
        type: CHANNEL.HTTP_REQUEST,
        uuid: msg.uuid,
        method: msg.method,
        url: msg.url,
        headers: msg.headers ?? {},
        body: serializeBodyForChannel(msg.body),
        clientId: msg.clientId
      });
      break;
    }
    case MSG.STOP:
      break;
  }
}
function handleInboundHostMessage(msg) {
  pushInboundHostMessage(msg);
}
function installServiceWorkerListener() {
  navigator.serviceWorker.addEventListener("message", (event) => {
    handleInboundHostMessage(event.data);
  });
}
function installHttpuvBridge(options = {}) {
  if (options.postOutbound) {
    postOutbound = options.postOutbound;
  }
  if (options.pushToR) {
    pushToR = options.pushToR;
  }
  const httpuv = ensureModuleHttpuv();
  if (!httpuv.channel) {
    httpuv.channel = createChannel();
  }
  httpuv.dispatch = dispatch;
  httpuv.drainInboundChannel = drainInboundChannel;
  httpuv.pushInboundChannelMessage = pushInboundChannelMessage;
  httpuv.pushInboundHostMessage = pushInboundHostMessage;
  httpuv.buildReq = buildReq;
  httpuv.injectShinySocketBootstrap = injectShinySocketBootstrap;
  httpuv.shinySocketScriptUrl = shinySocketScriptUrl;
  httpuv.shinyPrefix = getShinyPrefix();
  httpuv.pushWsMessage = (handle, message, opts = {}) => {
    getChannel().write({
      type: CHANNEL.WS_RESPONSE,
      data: {
        handle,
        binary: opts.binary ?? false,
        type: opts.wsType ?? WS_FRAME.SEND,
        message
      }
    });
  };
  httpuv.bindInvokeROption = (fn) => {
    invokeROption = fn;
  };
  const installSwListener = options.installSwListener ?? true;
  if (installSwListener && !httpuv._swListenerInstalled) {
    installServiceWorkerListener();
    httpuv._swListenerInstalled = true;
  }
  console.info("[httpuv-bridge] installed");
  return httpuv;
}
function setInvokeROption(fn) {
  invokeROption = fn;
}
function setPushToR(fn) {
  pushToR = fn;
}

// src/r-push.ts
function jsonForR(value) {
  return JSON.stringify(JSON.stringify(value));
}
function serializeReqForR(req) {
  const out = { ...req };
  const body = out.body;
  if (body instanceof ArrayBuffer) {
    out.body = Array.from(new Uint8Array(body));
  } else if (ArrayBuffer.isView(body)) {
    out.body = Array.from(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    );
  }
  return out;
}
function encodeWsPayloadBytes(message, binary) {
  if (binary) {
    if (message instanceof ArrayBuffer) {
      return Array.from(new Uint8Array(message));
    }
    if (ArrayBuffer.isView(message)) {
      return Array.from(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
    }
    if (Array.isArray(message)) {
      return message;
    }
  }
  return Array.from(new TextEncoder().encode(String(message ?? "")));
}
function isLikelyStaticAsset(url) {
  return /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)(\?|$)/i.test(url) || /\/shiny\/(shared|jquery|bootstrap|htmltools|shiny-)/i.test(url);
}
function channelMessageToRExpr(msg) {
  switch (msg.type) {
    case CHANNEL.HTTP_REQUEST: {
      const payload = {
        uuid: msg.uuid,
        method: msg.method,
        url: msg.url,
        headers: msg.headers ?? {},
        body: msg.body ?? null
      };
      const msgJson = jsonForR(payload);
      if (isLikelyStaticAsset(msg.url ?? "")) {
        return `local({
  msg <- jsonlite::fromJSON(${msgJson}, simplifyVector=FALSE)
  wrapper <- get("active_app_wrapper", envir=httpuv:::.globals)
  if (is.null(wrapper)) {
    if (!is.null(msg$uuid)) {
      httpuv:::httpuv_write_tcp_response(
        msg$uuid,
        list(
          status = 503L,
          headers = list(\`Content-Type\` = "text/plain"),
          body = "httpuv: no server running"
        )
      )
    }
  } else {
    httpuv:::httpuv_handle_http_request(wrapper, msg)
  }
  invisible(TRUE)
})`;
      }
      return `local({
  msg <- jsonlite::fromJSON(${msgJson}, simplifyVector=FALSE)
  wrapper <- get("active_app_wrapper", envir=httpuv:::.globals)
  later::later(function() {
    if (is.null(wrapper)) {
      if (!is.null(msg$uuid)) {
        httpuv:::httpuv_write_tcp_response(
          msg$uuid,
          list(
            status = 503L,
            headers = list(\`Content-Type\` = "text/plain"),
            body = "httpuv: no server running"
          )
        )
      }
    } else {
      httpuv:::httpuv_handle_http_request(wrapper, msg)
    }
  }, delay = 0)
  invisible(TRUE)
})`;
    }
    case CHANNEL.WS_OPEN: {
      const reqPart = msg.req ? `jsonlite::fromJSON(${jsonForR(serializeReqForR(msg.req))}, simplifyVector=FALSE)` : "NULL";
      return `local({
  wrapper <- get("active_app_wrapper", envir=httpuv:::.globals)
  if (!is.null(wrapper)) {
    req <- ${reqPart}
    wrapper$onWSOpen(${jsonForR(msg.handle)}, httpuv:::httpuv_js_req_to_rook(req))
  }
  invisible(TRUE)
})`;
    }
    case CHANNEL.WS_MESSAGE: {
      const bytesJson = jsonForR(encodeWsPayloadBytes(msg.message, Boolean(msg.binary)));
      return `later::later(function() {
  wrapper <- get("active_app_wrapper", envir=httpuv:::.globals)
  if (!is.null(wrapper)) {
    msg_raw <- httpuv:::httpuv_bytes_to_raw(
      jsonlite::fromJSON(${bytesJson}, simplifyVector=FALSE)
    )
    wrapper$onWSMessage(${jsonForR(msg.handle)}, TRUE, msg_raw)
  }
}, delay = 0)
invisible(TRUE)`;
    }
    case CHANNEL.WS_CLOSE:
      return `local({
  wrapper <- get("active_app_wrapper", envir=httpuv:::.globals)
  if (!is.null(wrapper)) {
    wrapper$onWSClose(${jsonForR(msg.handle)})
  }
  invisible(TRUE)
})`;
    default:
      throw new Error(`unsupported inbound channel message type: ${msg.type}`);
  }
}

// src/index.ts
var HTTPUV_TRANSPORT_VERSION = "0.0.0";

export { CHANNEL, COMLINK, HOST_DIR, HTTPUV_OPTIONS, HTTPUV_TRANSPORT_VERSION, MSG, REQUEST_TIMEOUT_MS, SESSION_DIR, SESSION_RECV_TIMEOUT_MS, WARMUP_REQUEST_HEADER, WASM_R_HOME, WS_FRAME, buildReq, channelMessageToRExpr, dispatch, drainInboundChannel, enableHttpuvDebug, flushDeferredOutbound, getHostPrefixDir, getSessionPrefix, getShinyPrefix, handleInboundHostMessage, httpuvDebugLog, injectShinySocketBootstrap, installHttpuvBridge, isHostPushUrl, isHttpuvDebug, isLikelyStaticAsset, isSessionHttpRequest, jsonForR, normalizeSessionHandle, parseSessionAction, pushInboundChannelMessage, pushInboundHostMessage, resolveSessionPrefix, resolveShinyPrefix, serializeReqForR, setHostPrefixDir, setInvokeROption, setPushToR, setShinyPrefix, shinyAppUrl, shinySocketScriptUrl, tryGetHostPrefixDir };
//# sourceMappingURL=httpuv-web.js.map
//# sourceMappingURL=httpuv-web.js.map