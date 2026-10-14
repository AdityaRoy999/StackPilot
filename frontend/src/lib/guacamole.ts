// Minimal types for the Apache Guacamole 1.6.0 client vendored in public/vendor.
export interface GuacamoleClient {
  connect(data: string): void;
  disconnect(): void;
  sendSize(width: number, height: number): void;
  sendKeyEvent(pressed: number, keysym: number): void;
  sendMouseState(state: unknown, applyDisplayScale?: boolean): void;
  onstatechange: ((state: number) => void) | null;
  onerror: ((error: { message: string; code: number }) => void) | null;
  getDisplay(): { getElement(): HTMLElement; getWidth(): number; getHeight(): number; scale(value: number): void; onresize: (() => void) | null };
}
interface Pointer {
  onmousedown: ((state: unknown) => void) | null;
  onmouseup: ((state: unknown) => void) | null;
  onmousemove: ((state: unknown) => void) | null;
}
export interface GuacamoleLibrary {
  WebSocketTunnel: new (url: string) => { onerror: ((error: { message: string; code: number }) => void) | null };
  Client: new (tunnel: unknown) => GuacamoleClient;
  Mouse: { new (element: HTMLElement): Pointer; Touchpad: new (element: HTMLElement) => Pointer };
  Keyboard: new (element: HTMLElement) => { onkeydown: ((key: number) => boolean) | null; onkeyup: ((key: number) => void) | null; reset(): void };
}
declare global { interface Window { Guacamole?: GuacamoleLibrary } }
let loading: Promise<GuacamoleLibrary> | undefined;
export function loadGuacamole() {
  if (window.Guacamole) return Promise.resolve(window.Guacamole);
  if (!loading) loading = new Promise<GuacamoleLibrary>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/guacamole-1.6.0.js";
    script.onload = () => window.Guacamole ? resolve(window.Guacamole) : reject(new Error("Desktop viewer could not load."));
    script.onerror = () => { script.remove(); loading = undefined; reject(new Error("Desktop viewer could not load. Try again.")); };
    document.head.appendChild(script);
  });
  return loading;
}
