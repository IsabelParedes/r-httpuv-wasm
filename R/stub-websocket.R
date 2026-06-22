#' @export
WebSocket <- R6::R6Class(
  "WebSocket",
  public = list(
    initialize = function(handle, req) {
      .httpuv_stub("WebSocket$initialize", handle = handle, req = req)
      self$handle <- handle
      self$request <- req
    },
    onMessage = function(func) {
      .httpuv_stub_method("WebSocket", "onMessage", func = func)
      self$messageCallbacks <- c(self$messageCallbacks, func)
    },
    onClose = function(func) {
      .httpuv_stub_method("WebSocket", "onClose", func = func)
      self$closeCallbacks <- c(self$closeCallbacks, func)
    },
    send = function(message) {
      .httpuv_stub_method("WebSocket", "send", message = message)
      invisible()
    },
    close = function(code = 1000L, reason = "") {
      .httpuv_stub_method("WebSocket", "close", code = code, reason = reason)
      self$handle <- NULL
      invisible()
    },
    handle = NULL,
    messageCallbacks = list(),
    closeCallbacks = list(),
    request = NULL
  )
)
