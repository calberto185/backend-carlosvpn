// Contraseñas con scrypt (incluido en Node, sin dependencias). Formato: scrypt$N$r$p$salt$hash (base64url).
const crypto = require("crypto");
const N = 16384, R = 8, P = 1, KEYLEN = 64;
const derive = (pw, salt, n, r, p) => new Promise((res, rej) => crypto.scrypt(pw, salt, KEYLEN, { N: n, r, p }, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await derive(String(pw), salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

async function verifyPassword(pw, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  const got = await derive(String(pw), Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// Gasta el mismo tiempo cuando el usuario no existe, para no revelar qué correos están registrados.
let dummy;
async function verifyDummy(pw) {
  dummy = dummy || (await hashPassword("no-existe"));
  await verifyPassword(pw, dummy);
  return false;
}

const generatePassword = () => crypto.randomBytes(18).toString("base64url"); // 24 caracteres
const MIN_PASSWORD = 10;

module.exports = { hashPassword, verifyPassword, verifyDummy, generatePassword, MIN_PASSWORD };
