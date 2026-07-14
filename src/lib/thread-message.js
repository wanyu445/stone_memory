function normalizeThreadMessage(msg) {
  if (!msg || !msg.timestamp || msg.type === "system") return null;

  let role = msg.type;
  let content = msg.message?.content;
  if (msg.type === "response_item" && msg.payload?.type === "message") {
    if (msg.payload.role === "developer") return null;
    role = msg.payload.role === "user" ? "user" : "assistant";
    content = msg.payload.content;
  }

  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter(block => block.type === "text" || block.type === "input_text" || block.type === "output_text")
      .map(block => block.text || "").join(" ").trim();
  }
  if (!text && msg.text) text = typeof msg.text === "string" ? msg.text : JSON.stringify(msg.text);
  if (!text) return null;
  return { timestamp: msg.timestamp, type: role || "user", text: text.slice(0, 2000) };
}

module.exports = { normalizeThreadMessage };
