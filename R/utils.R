.httpuv_stub <- function(name, ...) {
  args <- list(...)
  if (length(args)) {
    parts <- vapply(
      seq_along(args),
      function(i) {
        paste0(names(args)[i], " = ", paste(deparse(args[[i]], width.cutoff = 60L), collapse = ""))
      },
      character(1)
    )
    arg_str <- paste(parts, collapse = ", ")
  } else {
    arg_str <- ""
  }
  message("[httpuv stub] ", name, "(", arg_str, ")")
}

.httpuv_stub_method <- function(class, method, ...) {
  .httpuv_stub(paste0(class, "$", method), ...)
}

# A memoized wrapper for packageVersion(), because it is a fairly slow function
# which is called often. We can't get the version at build time because the
# package won't have been installed yet. Instead, we'll get it at run time and
# cache it.
httpuv_version <- local({
  version <- NULL

  function() {
    if (is.null(version)) {
      version <<- utils::packageVersion("httpuv")
    }
    version
  }
})

# Given a vector/list, return TRUE if any elements are unnamed, FALSE otherwise.
any_unnamed <- function(x) {
  # Zero-length vector
  if (length(x) == 0) {
    return(FALSE)
  }

  nms <- names(x)

  # List with no name attribute
  if (is.null(nms)) {
    return(TRUE)
  }

  # List with name attribute; check for any ""
  any(!nzchar(nms))
}

# Given a vector with multiple keys with the same name, drop any duplicated
# names. For example, with an input like list(a=1, a=2), returns list(a=1).
drop_duplicate_names <- function(x) {
  if (any_unnamed(x)) {
    stop("All items must be named.")
  }
  x[unique(names(x))]
}


#' Get and set logging level
#'
#' The logging level for httpuv can be set to report differing levels of
#' information. Possible logging levels (from least to most information
#' reported) are: `"OFF"`, `"ERROR"`, `"WARN"`, `"INFO"`, or
#' `"DEBUG"`. The default level is `ERROR`.
#'
#' @param level The logging level. Must be one of `NULL`, `"OFF"`,
#'   `"ERROR"`, `"WARN"`, `"INFO"`, or `"DEBUG"`. If
#'   `NULL` (the default), then this function simply returns the current
#'   logging level.
#'
#' @return If `level=NULL`, then this returns the current logging level. If
#'   `level` is any other value, then this returns the previous logging
#'   level, from before it is set to the new value.
#'
#' @keywords internal
logLevel <- function(level = NULL) {
  if (is.null(level)) {
    level <- ""
    log_level("")
  } else {
    level <- match.arg(level, c("OFF", "ERROR", "WARN", "INFO", "DEBUG"))
    invisible(log_level(level))
  }
}

# Create an empty named list
named_list <- function() {
  list(a = 1)[0]
}

#' Guess a Content-Type from a file path (pure R; no native mime package).
httpuv_guess_mime_type <- function(path) {
  ext <- tolower(sub("^.*\\.", "", basename(path)))
  if (!nzchar(ext) || identical(ext, tolower(basename(path)))) {
    return("application/octet-stream")
  }
  switch(ext,
    js = "application/javascript",
    mjs = "application/javascript",
    css = "text/css",
    html = "text/html",
    htm = "text/html",
    json = "application/json",
    svg = "image/svg+xml",
    png = "image/png",
    jpg = "image/jpeg",
    jpeg = "image/jpeg",
    gif = "image/gif",
    ico = "image/x-icon",
    woff = "font/woff",
    woff2 = "font/woff2",
    ttf = "font/ttf",
    map = "application/json",
    "application/octet-stream"
  )
}
