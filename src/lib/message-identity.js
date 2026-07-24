const crypto = require("crypto");

function messageIdentity(timestamp, role, text) {
  return crypto.createHash("sha256")
    .update(`${timestamp || ""}\0${role || ""}\0${text || ""}`)
    .digest("hex")
    .slice(0, 24);
}

module.exports = { messageIdentity };
