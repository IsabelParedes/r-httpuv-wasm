/**
 * Virtual WebSocket for Shiny in the browser (fetch + service worker long-poll).
 * Loaded as a module in the Shiny app iframe; overrides Shiny.createSocket.
 */
/** Minimal WebSocket stand-in using the httpuv session fetch API. */
declare class VirtualShinySocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState: number;
    binaryType: BinaryType;
    private _handle;
    private _recvActive;
    private _recvBootResolve;
    onopen: ((event: Event) => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onclose: ((event: CloseEvent) => void) | null;
    onerror: ((event: Event) => void) | null;
    constructor();
    private _connect;
    private _recvLoop;
    send(data: string | ArrayBuffer | ArrayBufferView): void;
    close(code?: number, reason?: string): void;
    private _finishClose;
}
/** Install VirtualShinySocket as Shiny.createSocket (call before Shiny connects). */
declare function installVirtualShinySocket(): void;

export { VirtualShinySocket, installVirtualShinySocket };
