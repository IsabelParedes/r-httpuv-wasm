import { defineConfig } from "tsup";

// Each entry is emitted as a standalone browser asset into the R package's
// inst/www directory, which is installed to R_HOME/library/httpuv/www and
// served over HTTP for the transport layer.
export default defineConfig({
  entry: {
    "httpuv-web": "src/index.ts",
    "httpuv-sw": "src/sw.ts",
    "shiny-socket": "src/shiny-socket.ts",
  },
  outDir: "../inst/www",
  format: ["esm"],
  target: "es2020",
  platform: "browser",
  dts: true,
  sourcemap: true,
  clean: true,
  // Service worker and injected scripts must be self-contained, so avoid
  // shared chunks between entries.
  splitting: false,
  treeshake: true,
});
