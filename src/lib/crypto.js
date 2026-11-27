const crypto = require("crypto");

// AES-256-GCM. Formato guardado: "v1:<iv>:<tag>:<datos>" (todo en base64url).
function key(hex) {
  if (!/^[0-9a-fA-F]{64}$/.test(hex || "")) throw new Error("ENCRYPTION_KEY inválida");
  return Buffer.from(hex, "hex");
}

function encrypt(plain, hexKey) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(hexKey), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(":");
}

function decrypt(blob, hexKey) {
  const [v, iv, tag, data] = String(blob).split(":");
  if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("Formato cifrado inválido");
  const d = crypto.createDecipheriv("aes-256-gcm", key(hexKey), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

const isEncrypted = (s) => typeof s === "string" && s.startsWith("v1:");

module.exports = { encrypt, decrypt, isEncrypted };
