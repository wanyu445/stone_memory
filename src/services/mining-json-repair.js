// Repair only content values; leave structural ambiguity to explicit failure.
function repairMiningJson(text) {
  try { JSON.parse(text); return text; } catch {}
  const fence = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const src = fence ? fence[1] : text;
  let out = '', i = 0;
  while (i < src.length) {
    const match = src.slice(i).match(/^"content"\s*:\s*"/);
    if (match) {
      out += match[0]; i += match[0].length;
      let closed = false;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '\\') { out += ch + (src[++i] || ''); continue; }
        if (ch === '"') {
          // A content value ends before an object end or a following key.
          if (/^\s*(?:}|,\s*"[^"\\]+"\s*:)/.test(src.slice(i + 1))) {
            out += ch; i++; closed = true; break;
          }
          out += '\\"'; continue;
        }
        out += ch.charCodeAt(0) < 32 ? JSON.stringify(ch).slice(1, -1) : ch;
      }
      if (!closed) return text;
    } else if (src[i] === '"') {
      // Skip all other strings intact, including escaped quotes and key-like text.
      out += src[i++];
      while (i < src.length) {
        const ch = src[i++]; out += ch;
        if (ch === '\\' && i < src.length) out += src[i++];
        else if (ch === '"') break;
      }
    } else out += src[i++];
  }
  try { JSON.parse(out); return out; } catch { return text; }
}
module.exports = { repairMiningJson };
