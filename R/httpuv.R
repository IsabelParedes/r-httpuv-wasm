# Implementation of Rook input stream
InputStream <- R6Class(
  "InputStream",
  public = list(
    initialize = function(conn, length) {
      private$conn <- conn
      private$length <- length
      seek(private$conn, 0)
    },
    read_lines = function(n = -1L) {
      readLines(private$conn, n, warn = FALSE)
    },
    read = function(l = -1L) {
      if (l < 0) {
        l <- private$length - seek(private$conn)
      }

      if (l == 0) {
        return(raw())
      }

      readBin(private$conn, raw(), l)
    },
    rewind = function() {
      seek(private$conn, 0)
    }
  ),
  private = list(
    conn = NULL,
    length = NULL
  ),
  cloneable = FALSE
)

NullInputStream <- R6Class(
  "NullInputStream",
  public = list(
    read_lines = function(n = -1L) {
      character()
    },
    read = function(l = -1L) {
      raw()
    },
    rewind = function() invisible(),
    close = function() invisible()
  ),
  cloneable = FALSE
)
nullInputStream <- NullInputStream$new()

ErrorStream <- R6Class(
  "ErrorStream",
  public = list(
    cat = function(..., sep = " ", fill = FALSE, labels = NULL) {
      base::cat(..., sep = sep, fill = fill, labels = labels, file = stderr())
    },
    flush = function() {
      base::flush(stderr())
    }
  ),
  cloneable = FALSE
)
stdErrStream <- ErrorStream$new()

rookCall <- function(func, req, data = NULL, dataLength = -1) {
  compute <- function() {
    inputStream <- if (is.null(data)) {
      nullInputStream
    } else {
      InputStream$new(data, dataLength)
    }

    req$rook.input <- inputStream
    req$rook.errors <- stdErrStream
    req$httpuv.version <- httpuv_version()

    if (!is.null(req$HTTP_CONTENT_TYPE)) {
      req$CONTENT_TYPE <- req$HTTP_CONTENT_TYPE
    }
    if (!is.null(req$HTTP_CONTENT_LENGTH)) {
      req$CONTENT_LENGTH <- req$HTTP_CONTENT_LENGTH
    }

    func(req)
  }

  prepare_response <- function(resp) {
    if (is.null(resp) || length(resp) == 0) {
      return(NULL)
    }

    if (
      is.null(resp$headers) ||
        (length(resp$headers) == 0 && is.null(names(resp$headers)))
    ) {
      resp$headers <- named_list()
    }

    resp$headers <- lapply(resp$headers, paste)

    if ("file" %in% names(resp$body)) {
      filename <- resp$body[["file"]]
      owned <- FALSE
      if ("owned" %in% names(resp$body)) {
        owned <- as.logical(resp$body$owned)
      }

      resp$body <- NULL
      resp$bodyFile <- filename
      resp$bodyFileOwned <- owned
    }
    resp
  }

  on_error <- function(e) {
    list(
      status = 500L,
      headers = list(
        "Content-Type" = "text/plain; charset=UTF-8"
      ),
      body = charToRaw(enc2utf8(
        paste("ERROR:", conditionMessage(e), collapse = "\n")
      ))
    )
  }

  compute_error <- NULL
  response <- tryCatch(
    compute(),
    error = function(e) compute_error <<- e
  )
  if (!is.null(compute_error)) {
    return(on_error(compute_error))
  }

  if (promises::is.promise(response)) {
    response %...>% prepare_response %...!% on_error
  } else {
    tryCatch(prepare_response(response), error = on_error)
  }
}

AppWrapper <- R6Class(
  "AppWrapper",
  private = list(
    app = NULL,
    wsconns = NULL,
    supportsOnHeaders = NULL
  ),
  public = list(
    initialize = function(app) {
      if (is.function(app)) {
        private$app <- list(call = app)
      } else {
        private$app <- app
      }

      private$supportsOnHeaders <- isTRUE(try(
        !is.null(private$app$onHeaders),
        silent = TRUE
      ))

      try_obj_class <- class(try(private$app$staticPaths, silent = TRUE))
      if (try_obj_class == "try-error" || is.null(private$app$staticPaths)) {
        self$staticPaths <- list()
      } else {
        self$staticPaths <- normalizeStaticPaths(private$app$staticPaths)
      }

      try_obj_class <- class(try(private$app$staticPathOptions, silent = TRUE))
      if (
        try_obj_class == "try-error" || is.null(private$app$staticPathOptions)
      ) {
        self$staticPathOptions <- staticPathOptions()
      } else if (inherits(private$app$staticPathOptions, "staticPathOptions")) {
        self$staticPathOptions <- normalizeStaticPathOptions(
          private$app$staticPathOptions
        )
      } else {
        stop("staticPathOptions must be an object of class staticPathOptions.")
      }

      private$wsconns <- new.env(parent = emptyenv())
    },
    hasOnHeaders = function() {
      private$supportsOnHeaders
    },
    onHeaders = function(req) {
      if (!private$supportsOnHeaders) {
        return(NULL)
      }

      rookCall(private$app$onHeaders, req)
    },
    onBodyData = function(req, bytes) {
      if (is.null(req$.bodyData)) {
        req$.bodyData <- file(open = "w+b", encoding = "UTF-8")
      }
      writeBin(bytes, req$.bodyData)
    },
    call = function(req, response_callback) {
      resp <- if (is.null(private$app$call)) {
        list(
          status = 404L,
          headers = list(
            "Content-Type" = "text/plain"
          ),
          body = "404 Not Found\n"
        )
      } else {
        body_len <- if (is.null(req$.bodyData)) {
          0L
        } else {
          seek(req$.bodyData)
        }
        rookCall(private$app$call, req, req$.bodyData, body_len)
      }

      clean_up <- function() {
        if (!is.null(req$.bodyData)) {
          close(req$.bodyData)
        }
        req$.bodyData <- NULL
      }

      if (promises::is.promise(resp)) {
        resp <- resp %...>% invokeResponseCallback(., response_callback)
        promises::finally(resp, clean_up)
      } else {
        on.exit(clean_up())
        invokeResponseCallback(resp, response_callback)
      }

      invisible()
    },
    onWSOpen = function(handle, req) {
      ws <- WebSocket$new(handle, req)
      private$wsconns[[wsconn_address(handle)]] <- ws
      result <- try(private$app$onWSOpen(ws))

      if (inherits(result, "try-error")) {
        ws$close(1011, "Error in onWSOpen")
      }
    },
    onWSMessage = function(handle, binary, message) {
      ws_key <- wsconn_address(handle)
      if (!exists(ws_key, envir = private$wsconns, inherits = FALSE)) {
        return()
      }

      for (handler in private$wsconns[[ws_key]]$messageCallbacks) {
        result <- try(handler(binary, message))
        if (inherits(result, "try-error")) {
          private$wsconns[[ws_key]]$close(
            1011,
            "Error executing onWSMessage"
          )
          return()
        }
      }
    },
    onWSClose = function(handle) {
      ws_key <- wsconn_address(handle)
      if (!exists(ws_key, envir = private$wsconns, inherits = FALSE)) {
        return()
      }

      ws <- private$wsconns[[ws_key]]
      ws$handle <- NULL
      rm(list = ws_key, envir = private$wsconns)

      for (handler in ws$closeCallbacks) {
        handler()
      }
    },

    staticPaths = NULL,
    staticPathOptions = NULL
  )
)

#' @export
WebSocket <- R6Class(
  "WebSocket",
  public = list(
    initialize = function(handle, req) {
      self$handle <- handle
      self$request <- req
    },
    onMessage = function(func) {
      self$messageCallbacks <- c(self$messageCallbacks, func)
    },
    onClose = function(func) {
      self$closeCallbacks <- c(self$closeCallbacks, func)
    },
    send = function(message) {
      if (is.null(self$handle)) {
        return()
      }

      if (is.raw(message)) {
        sendWSMessage(self$handle, TRUE, message)
      } else {
        sendWSMessage(self$handle, FALSE, as.character(message))
      }
    },
    close = function(code = 1000L, reason = "") {
      if (is.null(self$handle)) {
        return()
      }

      code <- as.integer(code)
      if (code < 0 || code > 2^16 - 1) {
        warning("Invalid websocket error code: ", code)
        code <- 1001L
      }
      reason <- iconv(reason, to = "UTF-8")

      closeWS(self$handle, code, reason)
      self$handle <- NULL
    },

    handle = NULL,
    messageCallbacks = list(),
    closeCallbacks = list(),
    request = NULL
  )
)

#' @export
startServer <- function(host, port, app, quiet = FALSE) {
  WebServer$new(host, port, app, quiet)
}

#' @rdname startServer
#' @export
startPipeServer <- function(name, mask, app, quiet = FALSE) {
  stop("Pipe servers are not supported in the browser build of httpuv.")
}

#' Process requests
#'
#' Runs due \code{\link[later:later]{later::later()}} callbacks. In the browser
#' build, inbound HTTP/WebSocket I/O is pushed from JavaScript via
#' \code{httpuv_push_*}; this function advances the R event loop (promise
#' handlers, timers, and Shiny's \code{service()} integration).
#'
#' @param timeoutMs Approximate number of milliseconds to run before returning.
#'   If \code{0} or \code{Inf}, continually process until \code{\link{interrupt}()}
#'   is called. If \code{NA}, performs a single non-blocking tick
#'   (\code{later::run_now(0, all = FALSE)}).
#' @export
service <- function(timeoutMs = ifelse(interactive(), 100, 1000)) {
  # Always use all = FALSE so the host event loop can interleave housekeeping
  # between httpuv-related callbacks (see r-httpuv-libuv #176).
  if (is.na(timeoutMs)) {
    run_now(0, all = FALSE)
  } else if (timeoutMs == 0 || timeoutMs == Inf) {
    .globals$paused <- FALSE
    check_time <- if (interactive()) 0.1 else Inf
    while (!.globals$paused) {
      run_now(check_time, all = FALSE)
    }
  } else {
    run_now(timeoutMs / 1000, all = FALSE)
  }

  TRUE
}

#' @export
runServer <- function(host, port, app, interruptIntervalMs = NULL) {
  server <- startServer(host, port, app)
  on.exit(stopServer(server))
  service(0)
}

#' @export
interrupt <- function() {
  .globals$paused <- TRUE
}

#' @export
getRNGState <- function() {
  stats::runif(0)
  invisible()
}

#' @export
ipFamily <- function(ip) {
  if (grepl(":", ip, fixed = TRUE)) {
    6L
  } else if (grepl("^[0-9.]+$", ip)) {
    4L
  } else {
    -1L
  }
}

#' @export
rawToBase64 <- function(x) {
  .httpuv_stub("rawToBase64", x = x)
  ""
}

.globals <- new.env(parent = emptyenv())
.globals$paused <- FALSE
.globals$active_app_wrapper <- NULL

#' @export
startDaemonizedServer <- startServer
