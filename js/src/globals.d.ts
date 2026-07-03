import type { HttpuvModule } from "./types";

export {};

interface EmscriptenModuleLike {
  httpuv?: HttpuvModule;
  _rWasmEvalDepth?: number;
  [key: string]: unknown;
}

interface ShinyGlobal {
  createSocket?: () => unknown;
  [key: string]: unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var Module: EmscriptenModuleLike | undefined;
  // eslint-disable-next-line no-var
  var Shiny: ShinyGlobal | undefined;
  // eslint-disable-next-line no-var
  var __HTTPUV_DEBUG__: boolean | undefined;
}
