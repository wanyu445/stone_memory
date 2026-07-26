function sanitizeDiagnostic(value) {
  const secretName = "[A-Za-z0-9_-]*(?:token|key|secret|password|authorization)[A-Za-z0-9_-]*";
  return String(value ?? "")
    .replace(
      new RegExp(`(\\bAuthorization\\s*:\\s*Bearer\\s+)([^\\s,;]+)`, "giu"),
      "$1[REDACTED]",
    )
    .replace(
      new RegExp(`(--${secretName}(?:=|\\s+))("[^"]*"|'[^']*'|[^\\s,;]+)`, "giu"),
      "$1[REDACTED]",
    )
    .replace(
      new RegExp(`(["']?${secretName}["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;]+)`, "giu"),
      "$1[REDACTED]",
    )
    .replace(/(\bBearer\s+)[^\s,;]+/giu, "$1[REDACTED]");
}

module.exports = { sanitizeDiagnostic };
