/**
 * Virtual WebSocket for Shiny in the browser.
 * Loaded as a module in the Shiny app iframe; overrides Shiny.createSocket.
 *
 * Server→client frames arrive on a dedicated MessagePort registered with the
 * httpuv service worker (no recv long-poll). open/send/close still use fetch.
 *
 * After the browser stops the SW while idle, the port is gone but the socket
 * stays logically open: we re-REGISTER_SESSION on send, visibilitychange, and
 * when the SW asks via REQUEST_SESSION_PORT.
 */
/** Minimal WebSocket stand-in using session fetch + MessagePort push delivery. */
declare class VirtualShinySocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState: number;
    binaryType: BinaryType;
    private _handle;
    private _active;
    private _port;
    private _registering;
    onopen: ((event: Event) => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onclose: ((event: CloseEvent) => void) | null;
    onerror: ((event: Event) => void) | null;
    constructor();
    private _connect;
    /**
     * Ensure the SW has a live MessagePort for this session.
     * Safe to call repeatedly after idle SW restarts.
     */
    ensurePort(): Promise<void>;
    /** Hand a MessagePort to the SW and wait for SESSION_ACK. */
    private _registerSessionPort;
    private _onPortMessage;
    private _teardownPort;
    send(data: string | ArrayBuffer | ArrayBufferView): void;
    close(code?: number, reason?: string): void;
    private _finishClose;
}
/** Install VirtualShinySocket as Shiny.createSocket (call before Shiny connects). */
declare function installVirtualShinySocket(): void;

export { VirtualShinySocket, installVirtualShinySocket };
