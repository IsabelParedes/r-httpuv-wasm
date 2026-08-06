#' @include httpuv.R server.R
NULL

.httpuv_channel_types <- c(
  "httpuv_http_request",
  "httpuv_ws_open",
  "httpuv_ws_message",
  "httpuv_ws_close"
)

httpuv_eval_js <- function(code) {
  invisible(.Call(httpuv_eval_js_, code, PACKAGE = "httpuv"))
}

httpuv_channel_has_message <- function() {
  isTRUE(.Call(httpuv_channel_has_message_, PACKAGE = "httpuv"))
}

httpuv_channel_read_json <- function() {
  .Call(httpuv_channel_read_json_, PACKAGE = "httpuv")
}

httpuv_channel_write_json <- function(json) {
  invisible(.Call(httpuv_channel_write_json_, json, PACKAGE = "httpuv"))
}

httpuv_drain_channel <- function() {
  while (httpuv_channel_has_message()) {
    json <- httpuv_channel_read_json()
    if (is.null(json) || !nzchar(json)) {
      next
    }
    msg <- jsonlite::fromJSON(json, simplifyVector = FALSE)
    if (identical(msg$type, "stdin")) {
      next
    }
    httpuv_dispatch_message(msg)
  }
  invisible(NULL)
}

httpuv_write_tcp_response <- function(uuid, resp) {
  payload <- list(
    type = "httpuv_tcp_response",
    uuid = as.character(uuid),
    data = httpuv_format_tcp_response(resp)
  )
  httpuv_channel_write_json(jsonlite::toJSON(payload, auto_unbox = TRUE, null = "null"))
}

httpuv_write_ws_response <- function(handle, binary, message, ws_type = "websocket.send") {
  payload <- list(
    type = "httpuv_ws_response",
    data = list(
      handle = as.character(handle),
      binary = isTRUE(binary),
      type = ws_type,
      message = if (isTRUE(binary)) {
        if (is.raw(message)) as.list(message) else message
      } else {
        as.character(message)
      }
    )
  )
  httpuv_channel_write_json(jsonlite::toJSON(payload, auto_unbox = TRUE, null = "null"))
}

httpuv_format_tcp_response <- function(resp) {
  if (is.null(resp) || length(resp) == 0) {
    return(list(status = 500L, headers = list(), body = list()))
  }

  status <- as.integer(resp$status %||% 500L)
  headers <- resp$headers %||% list()
  if (length(headers) == 0 && is.null(names(headers))) {
    headers <- named_list()
  }
  headers <- lapply(headers, as.character)

  body <- resp$body
  if (!is.null(resp$bodyFile)) {
    body <- readBin(resp$bodyFile, "raw", file.info(resp$bodyFile)$size)
    if (isTRUE(resp$bodyFileOwned)) {
      unlink(resp$bodyFile)
    }
  }

  if (is.raw(body)) {
    # Integer-array JSON for raw bodies blows up in WASM (jquery/shiny.min.js).
    # jsonlite::base64_enc() already returns a character string — do not wrap
    # with rawToChar() (that errors: "argument 'x' must be a raw vector").
    body <- list(
      httpuvRaw = "base64",
      data = jsonlite::base64_enc(body)
    )
  } else if (is.null(body)) {
    body <- list()
  }

  list(status = status, headers = headers, body = body)
}

`%||%` <- function(x, y) {
  if (is.null(x)) y else x
}

httpuv_bytes_to_raw <- function(bytes) {
  if (is.null(bytes) || length(bytes) == 0) {
    return(raw())
  }
  as.raw(unlist(bytes, use.names = FALSE))
}

httpuv_build_req <- function(msg) {
  url <- strsplit(as.character(msg$url), "?", fixed = TRUE)[[1]]
  path_and_host <- url[[1]]
  query_string <- if (length(url) > 1) url[[2]] else ""

  parsed <- httpuv_parse_url(path_and_host)
  path_info <- parsed$path_info

  headers <- msg$headers %||% list()
  if (is.data.frame(headers)) {
    headers <- as.list(headers)
  }

  req <- list(
    UUID = as.character(msg$uuid),
    REQUEST_METHOD = as.character(msg$method %||% "GET"),
    SCRIPT_NAME = parsed$script_name,
    PATH_INFO = path_info,
    QUERY_STRING = query_string,
    `rook.version` = "1.1-0",
    `rook.url_scheme` = parsed$scheme,
    SERVER_NAME = parsed$hostname,
    SERVER_PORT = parsed$port,
    REMOTE_ADDR = "127.0.0.1",
    REMOTE_PORT = "0",
    HEADERS = headers
  )

  for (name in names(headers)) {
    req[[paste0("HTTP_", toupper(gsub("-", "_", name)))]] <- headers[[name]]
  }

  body <- httpuv_bytes_to_raw(msg$body)
  if (length(body) > 0) {
    req$.bodyData <- file(open = "w+b")
    writeBin(body, req$.bodyData)
    seek(req$.bodyData, 0)
    req$CONTENT_LENGTH <- as.character(length(body))
    if (!is.null(req$HTTP_CONTENT_TYPE)) {
      req$CONTENT_TYPE <- req$HTTP_CONTENT_TYPE
    }
  }

  req
}

httpuv_parse_url <- function(url) {
  scheme <- "http"
  rest <- url
  if (grepl("^https?://", url)) {
    scheme <- sub(":.*$", "", url)
    rest <- sub("^https?://", "", url)
  }

  slash_idx <- regexpr("/", rest, fixed = TRUE)[1]
  if (slash_idx < 0) {
    hostport <- rest
    path <- "/"
  } else {
    hostport <- substr(rest, 1, slash_idx - 1)
    path <- substr(rest, slash_idx, nchar(rest))
  }

  host <- sub(":.*$", "", hostport)
  port <- sub("^.*:", "", hostport)
  if (identical(port, host)) {
    port <- if (scheme == "https") "443" else "80"
  }

  shiny_match <- regexpr("/shiny/", path, fixed = TRUE)[1]
  if (shiny_match > 0) {
    shiny_prefix <- substr(path, 1, shiny_match + 6)
    path_info <- substr(path, shiny_match + 7, nchar(path))
    if (!nzchar(path_info)) {
      path_info <- "/"
    } else if (!startsWith(path_info, "/")) {
      path_info <- paste0("/", path_info)
    }
    return(list(
      scheme = scheme,
      hostname = host,
      port = port,
      script_name = sub("/$", "", shiny_prefix),
      path_info = path_info
    ))
  }

  list(
    scheme = scheme,
    hostname = host,
    port = port,
    script_name = "",
    path_info = path
  )
}

httpuv_try_serve_static <- function(app_wrapper, req) {
  static_paths <- app_wrapper$staticPaths
  if (length(static_paths) == 0) {
    return(NULL)
  }

  path_info <- req$PATH_INFO %||% "/"
  for (name in names(static_paths)) {
    mount <- name
    if (!startsWith(mount, "/")) {
      mount <- paste0("/", mount)
    }
    if (!startsWith(path_info, mount)) {
      next
    }

    entry <- static_paths[[name]]
    if (inherits(entry, "staticPath") && isTRUE(entry$exclude)) {
      next
    }

    local_path <- if (inherits(entry, "staticPath")) {
      entry$path
    } else {
      as.character(entry)
    }

    suffix <- substr(path_info, nchar(mount) + 1, nchar(path_info))
    suffix <- sub("^/+", "", suffix)
    file_path <- if (nzchar(suffix)) {
      file.path(local_path, suffix)
    } else {
      local_path
    }

    if (dir.exists(file_path)) {
      indexhtml <- if (inherits(entry, "staticPath") && !is.null(entry$indexhtml)) {
        entry$indexhtml
      } else {
        app_wrapper$staticPathOptions$indexhtml %||% TRUE
      }
      if (!isTRUE(indexhtml)) {
        next
      }
      file_path <- file.path(file_path, "index.html")
    }

    if (!file.exists(file_path) || file.access(file_path, 4) != 0) {
      next
    }

    static_resp <- tryCatch(
      {
        body <- readBin(file_path, "raw", file.info(file_path)$size)
        mime <- httpuv_guess_mime_type(file_path)
        list(
          status = 200L,
          headers = list(`Content-Type` = mime),
          body = body
        )
      },
      error = function(e) {
        message("[httpuv] static read failed: ", file_path, " (", conditionMessage(e), ")")
        NULL
      }
    )
    if (!is.null(static_resp)) {
      return(static_resp)
    }
  }

  NULL
}

httpuv_sync_shiny_resource_paths <- function(app_wrapper) {
  if (is.null(app_wrapper) || !requireNamespace("shiny", quietly = TRUE)) {
    return(invisible(FALSE))
  }

  paths <- tryCatch(shiny::resourcePaths(), error = function(e) NULL)
  if (is.null(paths) || length(paths) == 0) {
    return(invisible(FALSE))
  }

  normalized <- normalizeStaticPaths(stats::setNames(as.list(paths), names(paths)))
  app_wrapper$staticPaths <- c(app_wrapper$staticPaths, normalized)
  invisible(TRUE)
}

httpuv_try_serve_shiny_resource <- function(req) {
  if (!requireNamespace("shiny", quietly = TRUE)) {
    return(NULL)
  }
  if (!identical(req$REQUEST_METHOD, "GET")) {
    return(NULL)
  }

  path <- req$PATH_INFO %||% ""
  match <- regexpr("^/([^/]+)/", path, perl = TRUE)
  if (match == -1) {
    return(NULL)
  }

  len <- attr(match, "capture.length")
  prefix <- substr(path, 2, 2 + len - 1)
  shiny_globals <- get(".globals", envir = asNamespace("shiny"))
  res_info <- shiny_globals$resources[[prefix]]
  if (is.null(res_info)) {
    return(NULL)
  }

  suffix <- substr(path, 2 + len, nchar(path))
  subreq <- as.environment(as.list(req, all.names = TRUE))
  subreq$PATH_INFO <- suffix
  subreq$SCRIPT_NAME <- paste(subreq$SCRIPT_NAME, substr(path, 1, 2 + len), sep = "")

  response <- res_info$func(subreq)
  if (is.null(response)) {
    return(NULL)
  }

  if (inherits(response, "httpResponse")) {
    headers <- as.list(response$headers)
    headers[["Content-Type"]] <- response$content_type
    return(list(
      status = response$status,
      headers = headers,
      body = response$content
    ))
  }

  response
}

.httpuv_host_option_names <- c(
  "httpuv_onRequest",
  "httpuv_onWSOpen",
  "httpuv_onWSMessage",
  "httpuv_onWSClose"
)

httpuv_serve_rook_request <- function(app_wrapper, req) {
  uuid <- req$UUID

  httpuv_sync_shiny_resource_paths(app_wrapper)

  static_resp <- httpuv_try_serve_static(app_wrapper, req)
  if (is.null(static_resp)) {
    static_resp <- httpuv_try_serve_shiny_resource(req)
  }
  if (!is.null(static_resp)) {
    httpuv_write_tcp_response(uuid, static_resp)
    return(invisible(TRUE))
  }

  if (isTRUE(app_wrapper$hasOnHeaders())) {
    headers_resp <- app_wrapper$onHeaders(req)
    if (!is.null(headers_resp) && length(headers_resp) > 0) {
      httpuv_write_tcp_response(uuid, headers_resp)
      return(invisible(TRUE))
    }
  }

  response_callback <- function(resp) {
    httpuv_write_tcp_response(uuid, resp)
  }

  app_wrapper$call(req, response_callback)
  invisible(TRUE)
}

httpuv_handle_http_request <- function(app_wrapper, msg) {
  req <- httpuv_build_req(msg)
  httpuv_serve_rook_request(app_wrapper, req)
}

httpuv_register_host_handlers <- function(app_wrapper) {
  options(
    httpuv_onRequest = function(req) {
      httpuv_serve_rook_request(app_wrapper, req)
    },
    httpuv_onWSOpen = function(handle, req) {
      app_wrapper$onWSOpen(handle, httpuv_js_req_to_rook(req))
    },
    httpuv_onWSMessage = function(handle, binary, message) {
      app_wrapper$onWSMessage(
        handle,
        isTRUE(binary),
        if (isTRUE(binary)) httpuv_bytes_to_raw(message) else as.character(message)
      )
    },
    httpuv_onWSClose = function(handle) {
      app_wrapper$onWSClose(handle)
    }
  )
  invisible(NULL)
}

httpuv_unregister_host_handlers <- function() {
  args <- stats::setNames(rep(list(NULL), length(.httpuv_host_option_names)), .httpuv_host_option_names)
  do.call(options, args)
  invisible(NULL)
}

#' Invoke a registered httpuv host handler by option name.
#'
#' Used by the JavaScript bridge when pushing HTTP/WebSocket events into R.
#' @param option_name One of \code{httpuv_onRequest}, \code{httpuv_onWSOpen},
#'   \code{httpuv_onWSMessage}, or \code{httpuv_onWSClose}.
#' @param ... Arguments passed to the registered handler.
#' @return \code{TRUE} if a handler was found and invoked, \code{FALSE} otherwise.
#' @keywords internal
httpuv_invoke_host_option <- function(option_name, ...) {
  fn <- getOption(as.character(option_name), default = NULL)
  if (is.null(fn)) {
    return(FALSE)
  }
  do.call(fn, list(...))
  TRUE
}

#' Run work immediately on the WASM host (no later event loop).
#'
#' Historically this scheduled on \pkg{later}; the browser build must not
#' depend on later's JS timers (unreliable in Chromium workers).
#' @param fn Zero-argument function.
#' @keywords internal
httpuv_push_on_later <- function(fn) {
  force(fn)
  fn()
  invisible(TRUE)
}

#' Push an HTTP request from the JavaScript host.
#'
#' Runs the handler immediately in the current evalR (no later event loop).
#'
#' @param msg A channel message list with \code{uuid}, \code{method}, \code{url},
#'   \code{headers}, and optional \code{body}.
#' @export
httpuv_push_http_request <- function(msg) {
  app_wrapper <- .globals$active_app_wrapper
  if (is.null(app_wrapper)) {
    if (!is.null(msg$uuid)) {
      httpuv_write_tcp_response(
        msg$uuid,
        list(
          status = 503L,
          headers = list(`Content-Type` = "text/plain"),
          body = "httpuv: no server running"
        )
      )
    }
    return(invisible(FALSE))
  }

  wrapper <- app_wrapper
  msg_local <- msg
  httpuv_push_on_later(function() {
    httpuv_handle_http_request(wrapper, msg_local)
  })
  invisible(TRUE)
}

#' Push a WebSocket open event from the JavaScript host.
#'
#' @param handle WebSocket connection handle.
#' @param req Optional request object for the connection.
#' @export
httpuv_push_ws_open <- function(handle, req = NULL) {
  app_wrapper <- .globals$active_app_wrapper
  if (is.null(app_wrapper)) {
    return(invisible(FALSE))
  }

  wrapper <- app_wrapper
  handle_local <- handle
  req_local <- req
  httpuv_push_on_later(function() {
    wrapper$onWSOpen(handle_local, httpuv_js_req_to_rook(req_local))
  })
}

#' Push a WebSocket message from the JavaScript host.
#'
#' @param handle WebSocket connection handle.
#' @param binary Whether \code{message} is binary.
#' @param message Message payload.
#' @export
httpuv_push_ws_message <- function(handle, binary, message) {
  app_wrapper <- .globals$active_app_wrapper
  if (is.null(app_wrapper)) {
    return(invisible(FALSE))
  }

  wrapper <- app_wrapper
  handle_local <- handle
  binary_local <- binary
  message_local <- message
  httpuv_push_on_later(function() {
    wrapper$onWSMessage(
      handle_local,
      isTRUE(binary_local),
      if (isTRUE(binary_local)) httpuv_bytes_to_raw(message_local) else as.character(message_local)
    )
  })
}

#' Push a WebSocket close event from the JavaScript host.
#'
#' @param handle WebSocket connection handle.
#' @export
httpuv_push_ws_close <- function(handle) {
  app_wrapper <- .globals$active_app_wrapper
  if (is.null(app_wrapper)) {
    return(invisible(FALSE))
  }

  wrapper <- app_wrapper
  handle_local <- handle
  httpuv_push_on_later(function() {
    wrapper$onWSClose(handle_local)
  })
}

httpuv_js_req_to_rook <- function(req) {
  if (!is.list(req)) {
    return(req)
  }

  out <- req
  if (!is.null(out$body)) {
    out$.bodyData <- file(open = "w+b")
    writeBin(httpuv_bytes_to_raw(out$body), out$.bodyData)
    seek(out$.bodyData, 0)
  }
  out
}

httpuv_dispatch_message <- function(msg) {
  app_wrapper <- .globals$active_app_wrapper
  if (is.null(app_wrapper)) {
    if (identical(msg$type, "httpuv_http_request")) {
      httpuv_write_tcp_response(
        msg$uuid,
        list(
          status = 503L,
          headers = list(`Content-Type` = "text/plain"),
          body = "httpuv: no server running"
        )
      )
    }
    return(invisible(NULL))
  }

  switch(msg$type,
    "httpuv_http_request" = httpuv_handle_http_request(app_wrapper, msg),
    "httpuv_ws_open" = {
      req <- if (!is.null(msg$req)) httpuv_js_req_to_rook(msg$req) else httpuv_build_req(msg)
      app_wrapper$onWSOpen(msg$handle, req)
    },
    "httpuv_ws_message" = app_wrapper$onWSMessage(
      msg$handle,
      isTRUE(msg$binary),
      if (isTRUE(msg$binary)) httpuv_bytes_to_raw(msg$message) else as.character(msg$message)
    ),
    "httpuv_ws_close" = app_wrapper$onWSClose(msg$handle),
    invisible(NULL)
  )
}

httpuv_register_app_wrapper <- function(app_wrapper) {
  .globals$active_app_wrapper <- app_wrapper
  invisible(NULL)
}

httpuv_unregister_app_wrapper <- function() {
  .globals$active_app_wrapper <- NULL
  invisible(NULL)
}

wsconn_address <- function(handle) {
  if (inherits(handle, "externalptr")) {
    as.character(handle)
  } else {
    as.character(handle)
  }
}

invokeResponseCallback <- function(data, callback) {
  if (is.function(callback)) {
    callback(data)
  } else if (inherits(callback, "externalptr")) {
    stop("Native httpuv callbacks are not supported in the browser build.")
  } else {
    invisible(NULL)
  }
}

sendWSMessage <- function(conn, binary, message) {
  httpuv_write_ws_response(conn, binary, message, "websocket.send")
}

closeWS <- function(conn, code = 1000L, reason = "") {
  httpuv_write_ws_response(
    conn,
    FALSE,
    jsonlite::toJSON(list(code = as.integer(code), reason = as.character(reason)), auto_unbox = TRUE),
    "websocket.close"
  )
}

#' Non-blocking httpuv service tick for the WASM host.
#'
#' Retained for API compatibility. Inbound I/O uses the JavaScript push path
#' (\code{httpuv_push_*}); there is no later loop to advance.
#' @export
httpuv_pump <- function() {
  invisible(TRUE)
}
