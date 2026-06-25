#' HTTP and WebSocket server (browser build)
#'
#' Browser-native httpuv for Shiny-Forge (Emscripten/WASM only). HTTP and WebSocket I/O is handled by a
#' service worker and JavaScript channel; this package implements the R-side
#' server logic (AppWrapper, Rook handlers, virtual WebSockets).
#'
#' @name httpuv-package
#' @aliases httpuv
#' @docType package
#' @keywords package
#' @useDynLib httpuv, .registration = TRUE
#' @importFrom R6 R6Class
#' @importFrom promises promise then finally is.promise %...>% %...!%
#' @importFrom stats runif
#' @importFrom jsonlite fromJSON toJSON
#' @importFrom later run_now
"_PACKAGE"
