#' @include httpuv.R
NULL

Server <- R6Class(
  "Server",
  cloneable = FALSE,
  public = list(
    stop = function() {
      if (!private$running) {
        return(invisible())
      }

      httpuv_unregister_host_handlers()
      httpuv_unregister_app_wrapper()
      private$running <- FALSE
      deregisterServer(self)
      invisible()
    },
    isRunning = function() {
      private$running
    },
    getStaticPaths = function() {
      if (!private$running) {
        return(NULL)
      }

      private$appWrapper$staticPaths
    },
    setStaticPath = function(..., .list = NULL) {
      if (!private$running) {
        return(invisible())
      }

      paths <- c(list(...), .list)
      paths <- normalizeStaticPaths(paths)
      private$appWrapper$staticPaths <- c(
        private$appWrapper$staticPaths,
        paths
      )
      invisible()
    },
    removeStaticPath = function(path) {
      if (!private$running) {
        return(invisible())
      }

      path <- as.character(path)
      private$appWrapper$staticPaths[[path]] <- NULL
      invisible()
    },
    getStaticPathOptions = function() {
      if (!private$running) {
        return(NULL)
      }

      private$appWrapper$staticPathOptions
    },
    setStaticPathOption = function(..., .list = NULL) {
      if (!private$running) {
        return(invisible())
      }

      opts <- c(list(...), .list)
      opts <- drop_duplicate_names(opts)
      opts <- normalizeStaticPathOptions(opts)

      unknown_opt_idx <- !(names(opts) %in% names(formals(staticPathOptions)))
      if (any(unknown_opt_idx)) {
        stop("Unknown options: ", paste(names(opts)[unknown_opt_idx], collapse = ", "))
      }

      for (name in names(opts)) {
        private$appWrapper$staticPathOptions[[name]] <- opts[[name]]
      }
      invisible()
    }
  ),
  private = list(
    appWrapper = NULL,
    running = FALSE
  )
)

WebServer <- R6Class(
  "WebServer",
  cloneable = FALSE,
  inherit = Server,
  public = list(
    initialize = function(host, port, app, quiet = FALSE) {
      private$host <- host
      private$port <- port
      private$appWrapper <- AppWrapper$new(app)

      httpuv_register_app_wrapper(private$appWrapper)
      httpuv_register_host_handlers(private$appWrapper)
      private$running <- TRUE
      registerServer(self)

      if (!quiet) {
        message(
          "httpuv browser server listening on ",
          host,
          ":",
          port,
          " (virtual)"
        )
      }
    },
    getHost = function() {
      private$host
    },
    getPort = function() {
      private$port
    }
  ),
  private = list(
    host = NULL,
    port = NULL
  )
)

#' @export
stopServer <- function(server) {
  if (!inherits(server, "Server")) {
    stop("Object must be an object of class Server.")
  }
  server$stop()
}

#' @export
stopAllServers <- function() {
  lapply(.globals$servers, function(server) {
    server$stop()
  })
  invisible()
}

.globals$servers <- list()

#' @export
listServers <- function() {
  .globals$servers
}

registerServer <- function(server) {
  .globals$servers[[length(.globals$servers) + 1]] <- server
}

deregisterServer <- function(server) {
  for (i in seq_along(.globals$servers)) {
    if (identical(server, .globals$servers[[i]])) {
      .globals$servers[[i]] <- NULL
      return()
    }
  }

  warning(
    "Unable to deregister server: server not found in list of running servers."
  )
}

#' @export
stopDaemonizedServer <- stopServer
