const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeDiagnostic } = require("../src/lib/sanitize-diagnostic");

test("automatic lifecycle diagnostics redact common command secrets", () => {
  const sanitized = sanitizeDiagnostic(
    "failed --token abc token=def api_key:ghi Authorization: Bearer jkl "
      + "OPENAI_API_KEY=sk-secret --access-token mno access_token=pqr",
  );

  for (const secret of ["abc", "def", "ghi", "jkl", "sk-secret", "mno", "pqr"]) {
    assert.doesNotMatch(sanitized, new RegExp(secret));
  }
  assert.match(sanitized, /\[REDACTED\]/);
});
