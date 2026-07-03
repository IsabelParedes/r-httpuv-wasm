/**
 * Virtual WebSocket for Shiny in the browser (fetch + service worker long-poll).
 * Loaded as a module in the Shiny app iframe; overrides Shiny.createSocket.
 */

/** Build an absolute session URL under the Shiny app prefix. */
function sessionUrl(action: string, opts: { handle?: string } = {}): string {
  const base = new URL("__session__/", location.href);
  const url = new URL(action.replace(/^\//, ""), base);
  if (opts.handle) {
    url.searchParams.set("handle", opts.handle);
  }
  return url.href;
}

/** Minimal WebSocket stand-in using the httpuv session fetch API. */
export class VirtualShinySocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = VirtualShinySocket.CONNECTING;
  binaryType: BinaryType = "arraybuffer";

  private _handle: string | null = null;
  private _recvActive = false;
  private _recvBootResolve: (() => void) | null = null;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor() {
    void this._connect();
  }

  private async _connect(): Promise<void> {
    try {
      const openUrl = sessionUrl("open");
      console.info("[shiny-socket] session open", openUrl);
      const res = await fetch(openUrl, { method: "POST" });
      if (!res.ok) {
        throw new Error(`session open failed: HTTP ${res.status}`);
      }
      const { handle } = (await res.json()) as { handle?: string };
      if (!handle) {
        throw new Error("session open response missing handle");
      }
      this._handle = String(handle);
      this.readyState = VirtualShinySocket.OPEN;
      this._recvActive = true;

      const recvBoot = new Promise<void>((resolve) => {
        this._recvBootResolve = resolve;
      });
      void this._recvLoop();
      await recvBoot;

      this.onopen?.(new Event("open"));
    } catch (err) {
      console.error("[shiny-socket] connect failed", err);
      this.readyState = VirtualShinySocket.CLOSED;
      this.onerror?.(new Event("error"));
      this.onclose?.(new CloseEvent("close", { code: 1006, wasClean: false }));
    }
  }

  private async _recvLoop(): Promise<void> {
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
          let code = 1000;
          let reason = "";
          try {
            const text = await res.text();
            if (text) {
              const payload = JSON.parse(text) as { code?: number; reason?: string };
              code = Number(payload.code ?? code);
              reason = String(payload.reason ?? "");
            }
          } catch {
            // ignore malformed close payloads
          }
          this._finishClose(code, reason, true);
          return;
        }

        const wsBinary = res.headers.get("X-Httpuv-WS-Binary") === "1";
        const data: string | ArrayBuffer = wsBinary ? await res.arrayBuffer() : await res.text();
        console.info("[shiny-socket] recv message", {
          wsType,
          binary: wsBinary,
          bytes: typeof data === "string" ? data.length : data.byteLength,
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

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== VirtualShinySocket.OPEN || !this._handle) {
      throw new Error("WebSocket is not open");
    }

    let body: string | ArrayBuffer;
    let byteLen: number;
    let isBinary: boolean;
    if (typeof data === "string") {
      body = data;
      byteLen = data.length;
      isBinary = false;
    } else if (data instanceof ArrayBuffer) {
      body = data;
      byteLen = data.byteLength;
      isBinary = true;
    } else {
      body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      byteLen = data.byteLength;
      isBinary = true;
    }

    const sendUrl = sessionUrl("send", { handle: this._handle });
    console.info("[shiny-socket] session send", sendUrl, {
      binary: isBinary,
      bytes: byteLen,
    });
    void fetch(sendUrl, {
      method: "POST",
      headers: isBinary ? {} : { "Content-Type": "text/plain; charset=UTF-8" },
      body,
    }).catch((err) => {
      console.error("[shiny-socket] send failed", err);
    });
  }

  close(code = 1000, reason = ""): void {
    if (
      this.readyState === VirtualShinySocket.CLOSED ||
      this.readyState === VirtualShinySocket.CLOSING
    ) {
      return;
    }
    this.readyState = VirtualShinySocket.CLOSING;
    const handle = this._handle;
    this._recvActive = false;
    if (handle) {
      const closeUrl = sessionUrl("close", { handle });
      void fetch(closeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, reason }),
      }).catch((err) => {
        console.error("[shiny-socket] close failed", err);
      });
    }
    this._finishClose(code, reason, true);
  }

  private _finishClose(code: number, reason: string, wasClean: boolean): void {
    this._recvActive = false;
    this.readyState = VirtualShinySocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean }));
  }
}

/** Install VirtualShinySocket as Shiny.createSocket (call before Shiny connects). */
export function installVirtualShinySocket(): void {
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
