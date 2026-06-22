.httpuv_server <- function(label, host, port, app, quiet = FALSE) {
  .httpuv_stub(label, host = host, port = port, app = app, quiet = quiet)
  structure(
    list(
      host = host,
      port = port,
      stop = function() {
        .httpuv_stub_method("Server", "stop")
        invisible()
      },
      isRunning = function() {
        .httpuv_stub_method("Server", "isRunning")
        TRUE
      },
      getHost = function() {
        .httpuv_stub_method("WebServer", "getHost")
        host
      },
      getPort = function() {
        .httpuv_stub_method("WebServer", "getPort")
        port
      }
    ),
    class = c("WebServer", "Server")
  )
}

#' @export
startServer <- function(host, port, app, quiet = FALSE) {
  .httpuv_server("startServer", host = host, port = port, app = app, quiet = quiet)
}

#' @export
startPipeServer <- function(name, mask, app, quiet = FALSE) {
  .httpuv_server("startPipeServer", host = name, port = mask, app = app, quiet = quiet)
}

#' @export
stopServer <- function(server) {
  .httpuv_stub("stopServer", server = server)
  if (!inherits(server, "Server")) {
    stop("Object must be an object of class Server.")
  }
  server$stop()
}

#' @export
service <- function(timeoutMs = ifelse(interactive(), 100, 1000)) {
  .httpuv_stub("service", timeoutMs = timeoutMs)
  TRUE
}

#' @export
interrupt <- function() {
  .httpuv_stub("interrupt")
  invisible()
}

#' @export
ipFamily <- function(ip) {
  .httpuv_stub("ipFamily", ip = ip)
  4L
}

#' Apply the value of `.Random.seed` to R's internal RNG state
#'
#' Shiny calls this after restoring a saved `.Random.seed` during private-seed
#' management. In the libuv build, this wraps R's C API `GetRNGstate()`. Here, a
#' zero-length [stats::runif()] call loads the seed into R's internal RNG without
#' advancing the stream.
#'
#' @keywords internal
#' @importFrom stats runif
#' @export
getRNGState <- function() {
  runif(0)
  invisible()
}

#' @export
rawToBase64 <- function(x) {
  .httpuv_stub("rawToBase64", x = x)
  ""
}
