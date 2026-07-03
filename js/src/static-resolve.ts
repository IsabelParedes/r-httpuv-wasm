/**
 * Map Shiny addResourcePath URL prefixes to paths under the served R_HOME tree.
 *
 * Shiny serves deps at /shiny/{name}-{version}/{file} while files live under
 * package trees like library/shiny/www/shared/. This table matches stock Shiny
 * 1.14.x layout so the SW can serve assets without calling R.
 */
interface StaticBaseRule {
  match: (prefix: string) => boolean;
  base: string;
}

const SHINY_STATIC_BASES: StaticBaseRule[] = [
  { match: (p) => p.startsWith("jquery-"), base: "library/shiny/www/shared" },
  { match: (p) => p.startsWith("shiny-css-"), base: "library/shiny/www/shared" },
  { match: (p) => p.startsWith("shiny-javascript-"), base: "library/shiny/www/shared" },
  {
    match: (p) => p.startsWith("shiny-busy-indicators-"),
    base: "library/shiny/www/shared/busy-indicators",
  },
  { match: (p) => p.startsWith("bootstrap-"), base: "library/shiny/www/shared/bootstrap" },
  { match: (p) => p.startsWith("htmltools-fill-"), base: "library/htmltools/fill" },
];

/**
 * @param prefix e.g. jquery-3.7.1
 * @param suffix e.g. jquery.min.js
 * @returns path relative to R_HOME/ (no leading slash)
 */
export function resolveShinyStaticRHomePath(prefix: string, suffix: string): string | null {
  if (!prefix || !suffix || suffix.includes("..")) {
    return null;
  }

  for (const rule of SHINY_STATIC_BASES) {
    if (rule.match(prefix)) {
      return `${rule.base}/${suffix}`.replace(/\/+/g, "/");
    }
  }

  return null;
}

/**
 * @param vfsDir absolute VFS path from shiny::resourcePaths()
 * @param suffix file path under the resource prefix
 */
export function rHomePathFromVfsDir(vfsDir: string, suffix: string): string | null {
  if (!vfsDir || !suffix || suffix.includes("..")) {
    return null;
  }
  const normalized = vfsDir.replace(/\/$/, "");
  const fetchPath = normalized.startsWith("/R_HOME/")
    ? normalized.slice("/R_HOME/".length)
    : normalized.replace(/^\//, "");
  return `${fetchPath}/${suffix}`.replace(/\/+/g, "/");
}
