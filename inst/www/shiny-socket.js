// src/shiny-socket.ts
function sessionUrl(action, opts = {}) {
  const base = new URL("__session__/", location.href);
  const url = new URL(action.replace(/^\//, ""), base);
  if (opts.handle) {
    url.searchParams.set("handle", opts.handle);
  }
  return url.href;
}
var _VirtualShinySocket = class _VirtualShinySocket {
  constructor() {
    this.readyState = _VirtualShinySocket.CONNECTING;
    this.binaryType = "arraybuffer";
    this._handle = null;
    this._recvActive = false;
    this._recvBootResolve = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    void this._connect();
  }
  async _connect() {
    try {
      const openUrl = sessionUrl("open");
      console.info("[shiny-socket] session open", openUrl);
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
      this._recvActive = true;
      const recvBoot = new Promise((resolve) => {
        this._recvBootResolve = resolve;
      });
      void this._recvLoop();
      await recvBoot;
      this.onopen?.(new Event("open"));
    } catch (err) {
      console.error("[shiny-socket] connect failed", err);
      this.readyState = _VirtualShinySocket.CLOSED;
      this.onerror?.(new Event("error"));
      this.onclose?.(new CloseEvent("close", { code: 1006, wasClean: false }));
    }
  }
  async _recvLoop() {
    while (this._recvActive && this._handle) {
      try {
        const recvUrl = sessionUrl("recv", { handle: this._handle });
        if (this._recvBootResolve) {
          console.info("[shiny-socket] recv start", recvUrl);
          this._recvBootResolve();
          this._recvBootResolve = null;
        }
        const res = await fetch(recvUrl);
        if (!this._recvActive) {
          return;
        }
        if (res.status === 204) {
          continue;
        }
        if (!res.ok) {
          throw new Error(`session recv failed: HTTP ${res.status}`);
        }
        const wsType = res.headers.get("X-Httpuv-WS-Type") ?? "websocket.send";
        if (wsType === "websocket.close") {
          let code = 1e3;
          let reason = "";
          try {
            const text = await res.text();
            if (text) {
              const payload = JSON.parse(text);
              code = Number(payload.code ?? code);
              reason = String(payload.reason ?? "");
            }
          } catch {
          }
          this._finishClose(code, reason, true);
          return;
        }
        const wsBinary = res.headers.get("X-Httpuv-WS-Binary") === "1";
        const data = wsBinary ? await res.arrayBuffer() : await res.text();
        console.info("[shiny-socket] recv message", {
          wsType,
          binary: wsBinary,
          bytes: typeof data === "string" ? data.length : data.byteLength
        });
        this.onmessage?.(new MessageEvent("message", { data }));
      } catch (err) {
        if (!this._recvActive) {
          return;
        }
        console.error("[shiny-socket] recv loop error", err);
        this._finishClose(1006, String(err), false);
        return;
      }
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
    const sendUrl = sessionUrl("send", { handle: this._handle });
    console.info("[shiny-socket] session send", sendUrl, {
      binary: isBinary,
      bytes: byteLen
    });
    void fetch(sendUrl, {
      method: "POST",
      headers: isBinary ? {} : { "Content-Type": "text/plain; charset=UTF-8" },
      body
    }).catch((err) => {
      console.error("[shiny-socket] send failed", err);
    });
  }
  close(code = 1e3, reason = "") {
    if (this.readyState === _VirtualShinySocket.CLOSED || this.readyState === _VirtualShinySocket.CLOSING) {
      return;
    }
    this.readyState = _VirtualShinySocket.CLOSING;
    const handle = this._handle;
    this._recvActive = false;
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
    this._recvActive = false;
    this.readyState = _VirtualShinySocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean }));
  }
};
_VirtualShinySocket.CONNECTING = 0;
_VirtualShinySocket.OPEN = 1;
_VirtualShinySocket.CLOSING = 2;
_VirtualShinySocket.CLOSED = 3;
var VirtualShinySocket = _VirtualShinySocket;
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
  console.info("[shiny-socket] VirtualShinySocket installed");
}
installVirtualShinySocket();

export { VirtualShinySocket, installVirtualShinySocket };
//# sourceMappingURL=shiny-socket.js.map
//# sourceMappingURL=shiny-socket.js.map