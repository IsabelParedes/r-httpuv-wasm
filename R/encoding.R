# Percent-encoding helpers for the WASM/browser build.
# Stock httpuv implements these in C; the previous stubs were no-ops, which
# left keys like columns%5B0%5D undecoded so Shiny parseQueryString(nested=TRUE)
# never built q$columns (DT server-side ajax then returned zero rows).

.percent_decode_one <- function(string) {
  string <- enc2utf8(as.character(string)[[1]])
  if (!nzchar(string) || !grepl("%", string, fixed = TRUE)) {
    return(string)
  }
  chars <- strsplit(string, "", fixed = TRUE)[[1]]
  bytes <- raw(length(chars))
  n_out <- 0L
  i <- 1L
  n <- length(chars)
  while (i <= n) {
    if (
      chars[[i]] == "%" &&
        i + 2L <= n &&
        grepl("^[0-9A-Fa-f]{2}$", paste0(chars[[i + 1L]], chars[[i + 2L]]))
    ) {
      n_out <- n_out + 1L
      bytes[[n_out]] <- as.raw(strtoi(paste0(chars[[i + 1L]], chars[[i + 2L]]), 16L))
      i <- i + 3L
    } else {
      raw_ch <- charToRaw(enc2utf8(chars[[i]]))
      for (b in raw_ch) {
        n_out <- n_out + 1L
        bytes[[n_out]] <- b
      }
      i <- i + 1L
    }
  }
  if (n_out == 0L) {
    return("")
  }
  rawToChar(bytes[seq_len(n_out)], multiple = FALSE)
}

.percent_decode <- function(value) {
  if (length(value) == 0) {
    return(value)
  }
  vapply(as.character(value), .percent_decode_one, character(1), USE.NAMES = FALSE)
}

.percent_encode_one <- function(string, component = TRUE) {
  string <- enc2utf8(as.character(string)[[1]])
  bytes <- charToRaw(string)
  # unreserved: ALPHA / DIGIT / "-" / "." / "_" / "~"
  # encodeURI also leaves ;,/?:@&=+$#
  ok <- if (isTRUE(component)) {
    function(b) {
      (b >= 0x41 && b <= 0x5a) ||
        (b >= 0x61 && b <= 0x7a) ||
        (b >= 0x30 && b <= 0x39) ||
        b %in% as.raw(c(0x2d, 0x2e, 0x5f, 0x7e))
    }
  } else {
    function(b) {
      (b >= 0x41 && b <= 0x5a) ||
        (b >= 0x61 && b <= 0x7a) ||
        (b >= 0x30 && b <= 0x39) ||
        b %in% as.raw(c(
          0x2d, 0x2e, 0x5f, 0x7e, 0x3b, 0x2c, 0x2f, 0x3f, 0x3a,
          0x40, 0x26, 0x3d, 0x2b, 0x24, 0x23
        ))
    }
  }
  parts <- vapply(as.integer(bytes), function(b) {
    rb <- as.raw(b)
    if (ok(rb)) {
      rawToChar(rb)
    } else {
      sprintf("%%%02X", b)
    }
  }, character(1))
  paste(parts, collapse = "")
}

.percent_encode <- function(value, component = TRUE) {
  if (length(value) == 0) {
    return(value)
  }
  vapply(
    as.character(value),
    function(s) .percent_encode_one(s, component = component),
    character(1),
    USE.NAMES = FALSE
  )
}

#' @export
encodeURI <- function(value) {
  .percent_encode(value, component = FALSE)
}

#' @export
encodeURIComponent <- function(value) {
  .percent_encode(value, component = TRUE)
}

#' @export
decodeURI <- function(value) {
  .percent_decode(value)
}

#' @export
decodeURIComponent <- function(value) {
  .percent_decode(value)
}
