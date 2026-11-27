// Operaciones de administración sobre MongoDB. Las usa la CLI hoy y el panel de gestión mañana.
const crypto = require("crypto");
const { generateSubToken, isValidSubToken } = require("../lib/token");
const { LOCALES, normalize } = require("../i18n");

const PROVIDERS = ["remnawave", "pasarguard"];
const err = (m) => Object.assign(new Error(m), { code: "VALIDATION" });
const isHttpUrl = (u) => /^https?:\/\/[^\s/]+/i.test(String(u || ""));

async function addPanel(db, { id, provider = "remnawave", name = "", sub_url }) {
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/i.test(String(id || ""))) throw err("id inválido (2-32 caracteres: letras, números, - y _)");
  if (!PROVIDERS.includes(provider)) throw err(`provider debe ser: ${PROVIDERS.join(" | ")}`);
  if (!isHttpUrl(sub_url)) throw err("sub_url debe empezar por http:// o https://");
  if (await db.collection("panels").findOne({ id })) throw err(`Ya existe un panel con id "${id}"`);
  const doc = { id, provider, name: name || id, sub_url: String(sub_url).replace(/\/+$/, ""), createdAt: new Date() };
  await db.collection("panels").insertOne(doc);
  return doc;
}

async function listPanels(db) {
  return db.collection("panels").find({}).toArray();
}

async function addSubscription(db, { panel_id, short_uuid, days = 30, language, label = "" }, { publicBaseUrl }) {
  const panel = await db.collection("panels").findOne({ id: panel_id });
  if (!panel) throw err(`No existe el panel "${panel_id}" (usa panel:add primero)`);
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(short_uuid || ""))) throw err("short_uuid inválido");
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 3650) throw err("days debe ser un entero entre 1 y 3650");
  if (language && !normalize(language)) throw err(`language debe ser: ${LOCALES.join(", ")}`);
  const sub_token = generateSubToken();
  const doc = {
    id: crypto.randomUUID(),
    sub_token,
    label,
    status: "active",
    language: language ? normalize(language) : undefined,
    expires_at: new Date(Date.now() + d * 864e5).toISOString(),
    accounts: [{ panel_id, short_uuid, status: "active" }],
    createdAt: new Date(),
  };
  if (!doc.language) delete doc.language;
  await db.collection("subscriptions").insertOne(doc);
  return { doc, url: `${publicBaseUrl}/s/${sub_token}` };
}

async function listSubscriptions(db) {
  return db.collection("subscriptions").find({}).toArray();
}

async function setSubscriptionStatus(db, token, status) {
  if (!isValidSubToken(token)) throw err("token inválido");
  if (!["active", "suspended"].includes(status)) throw err("estado inválido");
  const r = await db.collection("subscriptions").updateOne({ sub_token: token }, { $set: { status } });
  if (!r.matchedCount) throw err("No existe esa suscripción");
  return true;
}

module.exports = { addPanel, listPanels, addSubscription, listSubscriptions, setSubscriptionStatus };
