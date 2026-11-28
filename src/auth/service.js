// Usuarios y sesiones sobre MongoDB. Las sesiones son tokens opacos: en la base solo se guarda su hash,
// así una copia de la base no permite entrar y cada sesión se puede revocar.
const crypto = require("crypto");
const { hashPassword, verifyPassword, verifyDummy, MIN_PASSWORD } = require("../lib/password");
const { roleExists } = require("./roles");
const { LOCALES, normalize } = require("../i18n");

const err = (m, code = "VALIDATION") => Object.assign(new Error(m), { code });
const normEmail = (e) => String(e || "").trim().toLowerCase();
const isEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e) && e.length <= 254;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function publicUser(u) {
  if (!u) return null;
  const { password_hash, _id, ...rest } = u;
  return rest;
}

async function createUser(db, { email, password, role = "client", language, name = "" }) {
  const e = normEmail(email);
  if (!isEmail(e)) throw err("correo inválido");
  if (!(await roleExists(db, role))) throw err(`El rol "${role}" no existe`);
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw err(`la contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
  if (language && !normalize(language)) throw err(`language debe ser: ${LOCALES.join(", ")}`);
  if (await db.collection("users").findOne({ email: e })) throw err("Ya existe un usuario con ese correo");
  const doc = {
    id: crypto.randomUUID(), email: e, name: String(name).slice(0, 100), role, status: "active",
    password_hash: await hashPassword(password), createdAt: new Date(),
  };
  if (language) doc.language = normalize(language);
  await db.collection("users").insertOne(doc);
  return publicUser(doc);
}

async function authenticate(db, email, password) {
  const u = await db.collection("users").findOne({ email: normEmail(email) });
  if (!u) { await verifyDummy(password); return null; }
  const ok = await verifyPassword(password, u.password_hash);
  return ok && u.status === "active" ? u : null;
}

async function createSession(db, user, { ttlHours = 12, meta = {} } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires_at = new Date(Date.now() + ttlHours * 36e5);
  await db.collection("sessions").insertOne({ token_hash: sha256(token), user_id: user.id, expires_at, createdAt: new Date(), ...meta });
  return { token, expires_at };
}

async function userFromToken(db, token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const s = await db.collection("sessions").findOne({ token_hash: sha256(token) });
  if (!s || new Date(s.expires_at) <= new Date()) return null;
  const u = await db.collection("users").findOne({ id: s.user_id });
  return u && u.status === "active" ? u : null;
}

const revokeSession = (db, token) => db.collection("sessions").deleteOne({ token_hash: sha256(String(token)) });

async function setPassword(db, email, password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw err(`la contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
  const u = await db.collection("users").findOne({ email: normEmail(email) });
  if (!u) throw err("No existe ese usuario");
  await db.collection("users").updateOne({ id: u.id }, { $set: { password_hash: await hashPassword(password) } });
  await db.collection("sessions").deleteMany({ user_id: u.id }); // cerrar todas las sesiones
  return true;
}

async function setLanguage(db, userId, language) {
  const l = normalize(language);
  if (!l) throw err(`language debe ser: ${LOCALES.join(", ")}`);
  await db.collection("users").updateOne({ id: userId }, { $set: { language: l } });
  return l;
}

const listUsers = async (db) => (await db.collection("users").find({}).toArray()).map(publicUser);

module.exports = { createUser, authenticate, createSession, userFromToken, revokeSession, setPassword, setLanguage, listUsers, publicUser, normEmail };
