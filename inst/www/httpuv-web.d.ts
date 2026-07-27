type HeaderMap = Record<string, string>;
/** A message on Module.httpuv.channel (the R <-> JS bridge). */
interface ChannelMessage {
    type: string;
    uuid?: string;
    handle?: string;
    binary?: boolean;
    message?: unknown;
    method?: string;
    url?: string;
    headers?: HeaderMap;
    body?: ArrayBuffer | number[] | null;
    req?: unknown;
    clientId?: string | null;
    data?: ChannelMessageData;
}
interface ChannelMessageData {
    status?: number;
    headers?: HeaderMap;
    body?: unknown;
    handle?: string;
    binary?: boolean;
    type?: string;
    message?: unknown;
}
/** Request env fields buildReq needs from an inbound HTTP message. */
interface HttpRequestInput {
    uuid: string;
    method: string;
    url: string;
    headers?: HeaderMap;
    body?: ArrayBuffer | null;
}
/** Response payload buffered/forwarded between the R worker and service worker. */
interface PendingResponse {
    status: number;
    headers: HeaderMap;
    body: ArrayBuffer | Uint8Array | string | null;
}
/** Callback R registers so the bridge can invoke httpuv option handlers. */
type InvokeROption = (optionName: string, ...args: unknown[]) => boolean;
/** Deliver an outbound host message (main page -> service worker). */
type OutboundDeliver = (msg: object, transfer?: Transferable[]) => void;
interface HttpuvChannel {
    inbox: ChannelMessage[];
    hasMessage(): boolean;
    read(): ChannelMessage;
    write(msg: ChannelMessage): void;
}
interface HttpuvModule {
    channel?: HttpuvChannel;
    dispatch?: (msg: ChannelMessage) => void;
    drainInboundChannel?: () => void;
    pushInboundChannelMessage?: (msg: ChannelMessage) => boolean;
    pushInboundHostMessage?: (msg: HostInboundMessage) => void;
    buildReq?: (msg: HttpRequestInput) => Record<string, unknown>;
    injectShinySocketBootstrap?: (html: string) => string;
    shinySocketScriptUrl?: () => string;
    shinyPrefix?: string;
    pushWsMessage?: (handle: string, message: unknown, opts?: {
        binary?: boolean;
        wsType?: string;
    }) => void;
    bindInvokeROption?: (fn: InvokeROption) => void;
    /** Shiny host mode: request an immediate host service wake. */
    requestHostService?: () => void;
    /** Shiny host mode: wake after delayMs (setTimeout → rAF). */
    scheduleHostDelay?: (delayMs: number) => void;
    _swListenerInstalled?: boolean;
    [key: string]: unknown;
}
/** Inbound message from the service worker (or a host proxy) to the R worker. */
interface HostInboundMessage {
    type: string;
    uuid?: string;
    method?: string;
    url?: string;
    headers?: HeaderMap;
    body?: ArrayBuffer | null;
    clientId?: string | null;
}

/** Build a rook-like request env object for httpuv handlers. */
declare function buildReq(msg: HttpRequestInput): Record<string, unknown>;
/** Absolute pathname for shiny-socket.js (served next to httpuv-web.js). */
declare function shinySocketScriptUrl(): string;
/** Inject the virtual Shiny socket bootstrap into an HTML document. */
declare function injectShinySocketBootstrap(html: string): string;
/**
 * Deliver responses queued while evalR is active (Comlink must not run inside WASM eval).
 */
declare function flushDeferredOutbound(): void;
declare function dispatch(msg: ChannelMessage): void;
/** Drain inbound channel messages until empty or only stdin placeholders remain. */
declare function drainInboundChannel(): void;
/** Push a channel message into R immediately (worker push path). */
declare function pushInboundChannelMessage(msg: ChannelMessage): boolean;
/** Push an inbound host message from the service worker into R. */
declare function pushInboundHostMessage(msg: HostInboundMessage): void;
/** Handle an inbound message from the service worker (or a host proxy). */
declare function handleInboundHostMessage(msg: HostInboundMessage): void;
interface HttpuvBridgeOptions {
    /** Deliver HTTP/WS responses to the host (main page -> service worker). */
    postOutbound?: OutboundDeliver;
    /** Listen for service worker messages in this context (false in the R worker). */
    installSwListener?: boolean;
    /** Push inbound HTTP/WebSocket channel messages into R (R worker only). */
    pushToR?: (msg: ChannelMessage) => void;
    /** Shiny host mode: immediate wake (NEED_SERVICE). */
    requestHostService?: () => void;
    /** Shiny host mode: delayed wake (SCHEDULE_DELAY). */
    scheduleHostDelay?: (delayMs: number) => void;
}
/**
 * Install Module.httpuv (channel + dispatch) and optionally wire the service
 * worker listener. Call before WASM R starts.
 */
declare function installHttpuvBridge(options?: HttpuvBridgeOptions): HttpuvModule;
declare function setInvokeROption(fn: InvokeROption | null): void;
declare function setPushToR(fn: ((msg: ChannelMessage) => void) | null): void;

/** Double-encode a value as a JSON string literal safe to embed in R source. */
declare function jsonForR(value: unknown): string;
declare function serializeReqForR(req: Record<string, unknown>): Record<string, unknown>;
declare function isLikelyStaticAsset(url: string): boolean;
/** Build an R expression that pushes a channel message into httpuv handlers. */
declare function channelMessageToRExpr(msg: ChannelMessage): string;

/** WebSocket frame types used by httpuv (mirrors native httpuv). */
declare const WS_FRAME: {
    readonly SEND: "websocket.send";
    readonly CLOSE: "websocket.close";
};
/** R_HOME inside the mounted wasm prefix (VFS root is /). */
declare const WASM_R_HOME = "/lib/R";
/** Max time the service worker waits for the R worker to answer a request. */
declare const REQUEST_TIMEOUT_MS = 180000;
/** Max time a session recv long-poll waits before returning 204. */
declare const SESSION_RECV_TIMEOUT_MS = 25000;
/** Message types exchanged between the service worker and the main page. */
declare const MSG: {
    readonly REGISTER_HOST: "httpuv_register_host";
    readonly HTTP_REQUEST: "httpuv_http_request";
    readonly HTTP_RESPONSE: "httpuv_http_response";
    readonly WS_PUSH: "httpuv_ws_push";
    readonly STOP: "httpuv_stop";
    /** Drop cached GET /shiny/ without tearing down the R worker (app restart). */
    readonly CLEAR_APP_CACHE: "httpuv_clear_app_cache";
    /** Ask the SW to refresh shiny::resourcePaths() from the R worker. */
    readonly SYNC_RESOURCE_PATHS: "httpuv_sync_resource_paths";
    /** R worker -> SW mapping of addResourcePath prefixes to VFS directories. */
    readonly REGISTER_RESOURCE_PATHS: "httpuv_register_resource_paths";
    /** SW -> host: Comlink to the R worker was lost (e.g. after SW update). */
    readonly REQUEST_COMLINK: "httpuv_request_comlink";
};
/** Bypass SW app-document cache (warmup must hit R so deps register). */
declare const WARMUP_REQUEST_HEADER = "X-Shiny-Forge-Warmup";
/** Message types on Module.httpuv.channel (R <-> JS bridge). */
declare const CHANNEL: {
    readonly HTTP_REQUEST: "httpuv_http_request";
    readonly TCP_RESPONSE: "httpuv_tcp_response";
    readonly WS_OPEN: "httpuv_ws_open";
    readonly WS_MESSAGE: "httpuv_ws_message";
    readonly WS_CLOSE: "httpuv_ws_close";
    readonly WS_RESPONSE: "httpuv_ws_response";
    readonly STDIN: "stdin";
};
/** R option names registered by httpuv::startServer(). */
declare const HTTPUV_OPTIONS: {
    readonly ON_REQUEST: "httpuv_onRequest";
    readonly ON_WS_OPEN: "httpuv_onWSOpen";
    readonly ON_WS_MESSAGE: "httpuv_onWSMessage";
    readonly ON_WS_CLOSE: "httpuv_onWSClose";
};
/** Comlink MessagePort handshake between host page, service worker, and R worker. */
declare const COMLINK: {
    readonly PORT_HANDOFF: "httpuv_comlink_port";
};

/**
 * Host directory name under the site root where the wasm prefix tree is served
 * (e.g. `_env-wasm` → `/_env-wasm/...` over HTTP). Configured by the host app.
 */
declare function setHostPrefixDir(prefix: string): void;
declare function getHostPrefixDir(): string;
declare function tryGetHostPrefixDir(): string | null;
/**
 * Resolve the virtual Shiny app prefix from a module script URL.
 * e.g. /site/runApp.js -> /site/shiny/
 */
declare function resolveShinyPrefix(fromUrl: string | URL): string;
declare function setShinyPrefix(prefix: string): void;
declare function getShinyPrefix(): string;
/** Session directory name under the Shiny virtual app prefix. */
declare const SESSION_DIR = "__session__";
/** Host -> SW outbound path (fetch fallback when controller.postMessage unavailable). */
declare const HOST_DIR = "__host__";
interface SessionAction {
    action: string;
    handle: string | null;
}
/**
 * Strip accidental JSON quoting from session handles (R/Comlink sometimes
 * double-encode UUID strings).
 */
declare function normalizeSessionHandle(handle: unknown): string;
declare function resolveSessionPrefix(fromUrl: string | URL): string;
declare function getSessionPrefix(): string;
declare function parseSessionAction(urlString: string, prefix: string): SessionAction | null;
/** Session HTTP actions handled by the R worker (not SW long-poll recv). */
declare function isSessionHttpRequest(urlString: string, prefix?: string): boolean;
declare function isHostPushUrl(urlString: string, prefix: string): boolean;
/**
 * Build a same-origin URL under the Shiny virtual app prefix.
 * @param fromUrl defaults to this module's location when called from the main page
 */
declare function shinyAppUrl(subpath?: string, fromUrl?: string | URL): string;

/**
 * Opt-in tracing for the httpuv / Shiny-Forge request pipeline.
 *
 * Enable with either:
 *   - URL query: ?httpuvDebug=1
 *   - localStorage: localStorage.shinyForgeDebug = "1"
 *   - console: shinyForge.enableHttpuvDebug()
 */
declare function isHttpuvDebug(): boolean;
declare function httpuvDebugLog(stage: string, ...args: unknown[]): void;
declare function enableHttpuvDebug(): void;

interface HttpResponsePayload {
    uuid: string;
    status?: number;
    headers?: HeaderMap;
    body?: ArrayBuffer | Uint8Array | string | null;
}
interface WsPushPayload {
    handle: string;
    binary?: boolean;
    wsType?: string;
    message?: unknown;
}
/** API the service worker exposes to the R worker for outbound httpuv traffic. */
interface SwDeliveryApi {
    deliverHttpResponse(resp: HttpResponsePayload): void;
    deliverWsPush(msg: WsPushPayload): void;
}
/** API the R worker exposes to the service worker for inbound httpuv traffic. */
interface RHostApi {
    registerSwDelivery(port: MessagePort): void | Promise<void>;
    deliverHttpRequest(req: unknown): Promise<void>;
    getShinyResourcePaths(): Promise<Record<string, string>>;
    readVfsFile(vfsDir: string, suffix: string): Promise<ArrayBuffer | null>;
    stop(): void | Promise<void>;
}

declare const HTTPUV_TRANSPORT_VERSION = "0.0.0";

export { CHANNEL, COMLINK, type ChannelMessage, type ChannelMessageData, HOST_DIR, HTTPUV_OPTIONS, HTTPUV_TRANSPORT_VERSION, type HeaderMap, type HostInboundMessage, type HttpRequestInput, type HttpResponsePayload, type HttpuvBridgeOptions, type HttpuvChannel, type HttpuvModule, type InvokeROption, MSG, type OutboundDeliver, type PendingResponse, REQUEST_TIMEOUT_MS, type RHostApi, SESSION_DIR, SESSION_RECV_TIMEOUT_MS, type SessionAction, type SwDeliveryApi, WARMUP_REQUEST_HEADER, WASM_R_HOME, WS_FRAME, type WsPushPayload, buildReq, channelMessageToRExpr, dispatch, drainInboundChannel, enableHttpuvDebug, flushDeferredOutbound, getHostPrefixDir, getSessionPrefix, getShinyPrefix, handleInboundHostMessage, httpuvDebugLog, injectShinySocketBootstrap, installHttpuvBridge, isHostPushUrl, isHttpuvDebug, isLikelyStaticAsset, isSessionHttpRequest, jsonForR, normalizeSessionHandle, parseSessionAction, pushInboundChannelMessage, pushInboundHostMessage, resolveSessionPrefix, resolveShinyPrefix, serializeReqForR, setHostPrefixDir, setInvokeROption, setPushToR, setShinyPrefix, shinyAppUrl, shinySocketScriptUrl, tryGetHostPrefixDir };
