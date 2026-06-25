#include <R.h>
#include <Rinternals.h>
#include <R_ext/Rdynload.h>
#include <R_ext/Visibility.h>

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

static SEXP httpuv_eval_js(SEXP code) {
  if (!Rf_isString(code) || LENGTH(code) < 1) {
    error("code must be a character vector");
  }
  emscripten_run_script(translateCharUTF8(STRING_ELT(code, 0)));
  return R_NilValue;
}

static SEXP httpuv_channel_has_message(void) {
  int has = EM_ASM_INT({
    if (!Module.httpuv || !Module.httpuv.channel) return 0;
    return Module.httpuv.channel.hasMessage() ? 1 : 0;
  });
  return ScalarLogical(has);
}

static SEXP httpuv_channel_read_json(void) {
  char* json = (char*) EM_ASM_PTR({
    if (!Module.httpuv || !Module.httpuv.channel) return 0;
    var msg = Module.httpuv.channel.read();
    if (!msg) return 0;
    var json = JSON.stringify(msg);
    var len = lengthBytesUTF8(json) + 1;
    var ptr = _malloc(len);
    stringToUTF8(json, ptr, len);
    return ptr;
  });
  if (!json) {
    return R_NilValue;
  }
  SEXP result = mkString(json);
  free(json);
  return result;
}

static SEXP httpuv_channel_write_json(SEXP json) {
  if (!Rf_isString(json) || LENGTH(json) < 1) {
    error("json must be a character vector");
  }
  const char* payload = translateCharUTF8(STRING_ELT(json, 0));
  EM_ASM({
    if (!Module.httpuv || !Module.httpuv.channel) return;
    var payload = UTF8ToString($0);
    var msg = JSON.parse(payload);
    Module.httpuv.channel.write(msg);
  }, payload);
  return R_NilValue;
}

static const R_CallMethodDef callMethods[] = {
  {"httpuv_eval_js_", (DL_FUNC) &httpuv_eval_js, 1},
  {"httpuv_channel_has_message_", (DL_FUNC) &httpuv_channel_has_message, 0},
  {"httpuv_channel_read_json_", (DL_FUNC) &httpuv_channel_read_json, 0},
  {"httpuv_channel_write_json_", (DL_FUNC) &httpuv_channel_write_json, 1},
  {NULL, NULL, 0}
};

attribute_visible void R_init_httpuv(DllInfo* dll) {
  R_registerRoutines(dll, NULL, callMethods, NULL, NULL);
  R_useDynamicSymbols(dll, FALSE);
}
