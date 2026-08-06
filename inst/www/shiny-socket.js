// src/constants.ts
var WS_FRAME = {
  SEND: "websocket.send",
  CLOSE: "websocket.close"
};
var MSG = {
  WS_PUSH: "httpuv_ws_push",
  /** Iframe → SW: transfer a MessagePort for session WS push delivery. */
  REGISTER_SESSION: "httpuv_register_session",
  /** SW → iframe (on session port): registration accepted. */
  SESSION_ACK: "httpuv_session_ack",
  /** SW → iframe client: session MessagePort was lost (e.g. SW idle restart); re-REGISTER_SESSION. */
  REQUEST_SESSION_PORT: "httpuv_request_session_port"
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

// src/shiny-socket.ts
var SESSION_REGISTER_TIMEOUT_MS = 5e3;
function sessionUrl(action, opts = {}) {
  const base = new URL("__session__/", location.href);
  const url = new URL(action.replace(/^\//, ""), base);
  if (opts.handle) {
    url.searchParams.set("handle", opts.handle);
  }
  return url.href;
}
var socketsByHandle = /* @__PURE__ */ new Map();
var _VirtualShinySocket = class _VirtualShinySocket {
  constructor() {
    this.readyState = _VirtualShinySocket.CONNECTING;
    this.binaryType = "arraybuffer";
    this._handle = null;
    this._active = false;
    this._port = null;
    this._registering = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    void this._connect();
  }
  async _connect() {
    try {
      const openUrl = sessionUrl("open");
      httpuvDebugLog("socket-open", openUrl);
      const res = await fetch(openUrl, { method: "POST" });
      if (!res.ok) {
        throw new Error(`session open failed: HTTP ${res.status}`);
      }
      const { handle } = await res.json();
      if (!handle) {
        throw new Error("session open response missing handle");
      }
      this._handle = String(handle);
      this.readyState = _VirtualShinySocket.OPEN;
      this._active = true;
      socketsByHandle.set(this._handle, this);
      await this.ensurePort();
      this.onopen?.(new Event("open"));
    } catch (err) {
      console.error("[shiny-socket] connect failed", err);
      this._teardownPort();
      this.readyState = _VirtualShinySocket.CLOSED;
      this.onerror?.(new Event("error"));
      this.onclose?.(new CloseEvent("close", { code: 1006, wasClean: false }));
    }
  }
  /**
   * Ensure the SW has a live MessagePort for this session.
   * Safe to call repeatedly after idle SW restarts.
   */
  ensurePort() {
    if (!this._active || !this._handle) {
      return Promise.resolve();
    }
    if (this._registering) {
      return this._registering;
    }
    this._registering = this._registerSessionPort(this._handle).finally(() => {
      this._registering = null;
    });
    return this._registering;
  }
  /** Hand a MessagePort to the SW and wait for SESSION_ACK. */
  async _registerSessionPort(handle) {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) {
      throw new Error("no service worker controller for session port");
    }
    if (this._port) {
      try {
        this._port.close();
      } catch {
      }
      this._port = null;
    }
    const channel = new MessageChannel();
    this._port = channel.port1;
    const acked = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("session port registration timed out"));
      }, SESSION_REGISTER_TIMEOUT_MS);
      this._port.onmessage = (event) => {
        const data = event.data;
        if (data?.type === MSG.SESSION_ACK) {
          clearTimeout(timer);
          this._port.onmessage = (ev) => this._onPortMessage(ev);
          resolve();
          return;
        }
        this._onPortMessage(event);
      };
      this._port.onmessageerror = () => {
        clearTimeout(timer);
        reject(new Error("session port messageerror"));
      };
    });
    httpuvDebugLog("socket-register-session", { handle });
    controller.postMessage({ type: MSG.REGISTER_SESSION, handle }, [channel.port2]);
    await acked;
  }
  _onPortMessage(event) {
    if (!this._active) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== "object") {
      return;
    }
    if (data.type !== MSG.WS_PUSH && data.wsType == null && data.message === void 0) {
      return;
    }
    const wsType = data.wsType ?? WS_FRAME.SEND;
    if (wsType === WS_FRAME.CLOSE) {
      let code = 1e3;
      let reason = "";
      try {
        const raw = data.message;
        if (typeof raw === "string" && raw) {
          const payload2 = JSON.parse(raw);
          code = Number(payload2.code ?? code);
          reason = String(payload2.reason ?? "");
        }
      } catch {
      }
      this._finishClose(code, reason, true);
      return;
    }
    const binary = Boolean(data.binary);
    let payload;
    if (binary) {
      if (data.message instanceof ArrayBuffer) {
        payload = data.message;
      } else if (ArrayBuffer.isView(data.message)) {
        const view = data.message;
        payload = view.buffer.slice(
          view.byteOffset,
          view.byteOffset + view.byteLength
        );
      } else if (typeof data.message === "string") {
        payload = data.message;
      } else {
        payload = new ArrayBuffer(0);
      }
    } else if (typeof data.message === "string") {
      payload = data.message;
    } else if (data.message instanceof ArrayBuffer) {
      payload = new TextDecoder().decode(data.message);
    } else if (ArrayBuffer.isView(data.message)) {
      payload = new TextDecoder().decode(data.message);
    } else {
      payload = String(data.message ?? "");
    }
    httpuvDebugLog("socket-recv", {
      wsType,
      binary,
      bytes: typeof payload === "string" ? payload.length : payload.byteLength
    });
    this.onmessage?.(new MessageEvent("message", { data: payload }));
  }
  _teardownPort() {
    this._active = false;
    if (this._handle) {
      socketsByHandle.delete(this._handle);
    }
    if (this._port) {
      try {
        this._port.close();
      } catch {
      }
      this._port = null;
    }
  }
  send(data) {
    if (this.readyState !== _VirtualShinySocket.OPEN || !this._handle) {
      throw new Error("WebSocket is not open");
    }
    let body;
    let byteLen;
    let isBinary;
    if (typeof data === "string") {
      body = data;
      byteLen = data.length;
      isBinary = false;
    } else if (data instanceof ArrayBuffer) {
      body = data;
      byteLen = data.byteLength;
      isBinary = true;
    } else {
      body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      byteLen = data.byteLength;
      isBinary = true;
    }
    const handle = this._handle;
    const sendUrl = sessionUrl("send", { handle });
    httpuvDebugLog("socket-send", sendUrl, {
      binary: isBinary,
      bytes: byteLen
    });
    void this.ensurePort().catch((err) => {
      console.warn("[shiny-socket] ensurePort before send failed", err);
    }).then(
      () => fetch(sendUrl, {
        method: "POST",
        headers: isBinary ? {} : { "Content-Type": "text/plain; charset=UTF-8" },
        body
      })
    ).catch((err) => {
      console.error("[shiny-socket] send failed", err);
    });
  }
  close(code = 1e3, reason = "") {
    if (this.readyState === _VirtualShinySocket.CLOSED || this.readyState === _VirtualShinySocket.CLOSING) {
      return;
    }
    this.readyState = _VirtualShinySocket.CLOSING;
    const handle = this._handle;
    this._active = false;
    if (handle) {
      const closeUrl = sessionUrl("close", { handle });
      void fetch(closeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, reason })
      }).catch((err) => {
        console.error("[shiny-socket] close failed", err);
      });
    }
    this._finishClose(code, reason, true);
  }
  _finishClose(code, reason, wasClean) {
    if (this.readyState === _VirtualShinySocket.CLOSED) {
      return;
    }
    this._teardownPort();
    this.readyState = _VirtualShinySocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean }));
  }
};
_VirtualShinySocket.CONNECTING = 0;
_VirtualShinySocket.OPEN = 1;
_VirtualShinySocket.CLOSING = 2;
_VirtualShinySocket.CLOSED = 3;
var VirtualShinySocket = _VirtualShinySocket;
function reregisterAllSockets() {
  for (const sock of socketsByHandle.values()) {
    void sock.ensurePort().catch((err) => {
      console.warn("[shiny-socket] ensurePort failed", err);
    });
  }
}
function installSessionPortRecovery() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) {
    return;
  }
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== MSG.REQUEST_SESSION_PORT) {
      return;
    }
    const handle = data.handle ? String(data.handle) : "";
    const sock = handle ? socketsByHandle.get(handle) : void 0;
    if (sock) {
      void sock.ensurePort().catch((err) => {
        console.warn("[shiny-socket] REQUEST_SESSION_PORT ensurePort failed", err);
      });
      return;
    }
    reregisterAllSockets();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      reregisterAllSockets();
    }
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    reregisterAllSockets();
  });
}
function installVirtualShinySocket() {
  const factory = () => new VirtualShinySocket();
  const apply = () => {
    if (typeof globalThis.Shiny === "object" && globalThis.Shiny !== null) {
      globalThis.Shiny.createSocket = factory;
    } else {
      globalThis.Shiny = { createSocket: factory };
    }
  };
  apply();
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  installSessionPortRecovery();
  httpuvDebugLog("shiny-socket-installed");
}
installVirtualShinySocket();

export { VirtualShinySocket, installVirtualShinySocket };
//# sourceMappingURL=shiny-socket.js.map
//# sourceMappingURL=shiny-socket.js.map