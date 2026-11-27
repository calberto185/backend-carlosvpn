const crypto = require("crypto");

// Token de suscripción: 24 bytes aleatorios en base64url = 32 caracteres.
function generateSubToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function isValidSubToken(t) {
  return typeof t === "string" && /^[A-Za-z0-9_-]{32}$/.test(t);
}

module.exports = { generateSubToken, isValidSubToken };
