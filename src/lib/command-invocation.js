function parseCommandLine(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("runtime command is empty");
  const parts = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\") {
      const next = value[index + 1];
      const escapable = next && (next === "\\" || next === quote || (!quote && (/\s/.test(next) || next === "'" || next === "\"")));
      if (quote !== "'" && escapable) {
        current += next;
        index++;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("runtime command contains an unclosed quote");
  if (current) parts.push(current);
  if (!parts.length) throw new Error("runtime command is empty");
  return parts;
}

function commandInvocation(command, { remove = [] } = {}) {
  const [file, ...rawArgs] = parseCommandLine(command);
  const removals = new Set(remove);
  return { file, args: rawArgs.filter(arg => !removals.has(arg)) };
}

function appendOption(args, flag, value) {
  if (!flag || value === undefined || value === null || value === "") return;
  args.push(...parseCommandLine(flag), String(value));
}

module.exports = { parseCommandLine, commandInvocation, appendOption };
