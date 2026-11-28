// Clientes (CRM). Un cliente NUNCA entra al panel de administración: no tiene contraseña ni rol aquí.
// Se enlaza con sus suscripciones mediante subscription.client_id.
const crypto = require("crypto");
const { LOCALES, normalize } = require("../i18n");

const err = (m) => Object.assign(new Error(m), { code: "VALIDATION" });
const STAGES = ["lead", "contactado", "activo", "riesgo", "inactivo"];
const STATES = ["pendiente", "activo", "suspendido", "bloqueado"];
const SOURCES = ["telegram", "whatsapp", "web", "referido", "directo", "otro"];
const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TAG = /^[a-z0-9_-]{1,24}$/;

function clean(p, { partial = false } = {}) {
  const out = {}; const has = (k) => p[k] !== undefined;
  if (!partial || has("name")) {
    const n = String(p.name || "").trim();
    if (!n || n.length > 100) throw err("name es requerido (máx. 100 caracteres)");
    out.name = n;
  }
  if (has("email")) {
    const e = String(p.email || "").trim().toLowerCase();
    if (e && !EMAIL.test(e)) throw err("email inválido");
    out.email = e;
  }
  if (has("whatsapp")) {
    const w = String(p.whatsapp || "").replace(/[\s()-]/g, "");
    if (w && !E164.test(w)) throw err("whatsapp debe estar en formato internacional, ej. +51987654321");
    out.whatsapp = w;
  }
  if (has("telegram_id")) {
    if (p.telegram_id === null || p.telegram_id === "") out.telegram_id = null;
    else { const t = Number(p.telegram_id); if (!Number.isInteger(t) || t <= 0) throw err("telegram_id debe ser un entero positivo"); out.telegram_id = t; }
  }
  if (has("country")) {
    const c = String(p.country || "").toUpperCase();
    if (c && !/^[A-Z]{2}$/.test(c)) throw err("country debe ser un código de 2 letras (ej. PE, RU)");
    out.country = c;
  }
  if (has("lang")) {
    if (p.lang && !normalize(p.lang)) throw err(`lang debe ser: ${LOCALES.join(", ")}`);
    out.lang = p.lang ? normalize(p.lang) : "";
  }
  if (has("tags")) {
    if (!Array.isArray(p.tags)) throw err("tags debe ser una lista");
    const t = [...new Set(p.tags.map((x) => String(x).trim().toLowerCase()))].filter(Boolean);
    if (t.length > 20 || t.some((x) => !TAG.test(x))) throw err("tags: máx. 20, solo letras minúsculas, números, - y _ (hasta 24)");
    out.tags = t;
  }
  if (has("pipeline_stage")) { if (!STAGES.includes(p.pipeline_stage)) throw err(`pipeline_stage debe ser: ${STAGES.join(", ")}`); out.pipeline_stage = p.pipeline_stage; }
  if (has("source")) { if (p.source && !SOURCES.includes(p.source)) throw err(`source debe ser: ${SOURCES.join(", ")}`); out.source = p.source || ""; }
  if (has("state")) { if (!STATES.includes(p.state)) throw err(`state debe ser: ${STATES.join(", ")}`); out.state = p.state; }
  return out;
}

async function createClient(db, input, actor) {
  const v = clean(input);
  await assertUnique(db, v);
  const now = new Date();
  const doc = { id: crypto.randomUUID(), email: "", whatsapp: "", telegram_id: null, country: "", lang: "", tags: [], pipeline_stage: "lead", source: "", state: "pendiente", ...v, notes: [], createdBy: actor || null, createdAt: now, updatedAt: now };
  await db.collection("clients").insertOne(doc);
  return doc;
}

// Un mismo correo / WhatsApp / Telegram no puede estar en dos clientes.
async function assertUnique(db, v, selfId) {
  for (const k of ["email", "whatsapp", "telegram_id"]) {
    if (!v[k]) continue;
    const dup = await db.collection("clients").findOne({ [k]: v[k] });
    if (dup && dup.id !== selfId) throw err(`Ya existe un cliente con ese ${k}`);
  }
}

async function updateClient(db, id, patch) {
  const cur = await db.collection("clients").findOne({ id });
  if (!cur) throw err("No existe ese cliente");
  const v = clean(patch, { partial: true });
  await assertUnique(db, v, id);
  await db.collection("clients").updateOne({ id }, { $set: { ...v, updatedAt: new Date() } });
  return db.collection("clients").findOne({ id });
}

async function addNote(db, id, text, actor) {
  const t = String(text || "").trim();
  if (!t || t.length > 1000) throw err("La nota es requerida (máx. 1000 caracteres)");
  const cur = await db.collection("clients").findOne({ id });
  if (!cur) throw err("No existe ese cliente");
  const notes = [...(cur.notes || []), { text: t, createdAt: new Date(), createdBy: actor || null }].slice(-200);
  await db.collection("clients").updateOne({ id }, { $set: { notes, updatedAt: new Date() } });
  return db.collection("clients").findOne({ id });
}

// Filtros: ?stage=&tag=&state=&q= (busca en nombre, correo, whatsapp).
async function listClients(db, { stage, tag, state, q } = {}) {
  let rows = await db.collection("clients").find({}).toArray();
  if (stage) rows = rows.filter((c) => c.pipeline_stage === stage);
  if (state) rows = rows.filter((c) => c.state === state);
  if (tag) rows = rows.filter((c) => (c.tags || []).includes(String(tag).toLowerCase()));
  if (q) { const n = String(q).toLowerCase(); rows = rows.filter((c) => [c.name, c.email, c.whatsapp].some((x) => String(x || "").toLowerCase().includes(n))); }
  return rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

const getClient = (db, id) => db.collection("clients").findOne({ id });

// Suscripciones del cliente (sin exponer enlaces completos).
async function clientSubscriptions(db, id) {
  return (await db.collection("subscriptions").find({}).toArray()).filter((s) => s.client_id === id);
}

async function linkSubscription(db, clientId, subId) {
  if (!(await getClient(db, clientId))) throw err("No existe ese cliente");
  const r = await db.collection("subscriptions").updateOne({ id: subId }, { $set: { client_id: clientId } });
  if (!r.matchedCount) throw err("No existe esa suscripción");
  await db.collection("clients").updateOne({ id: clientId }, { $set: { updatedAt: new Date() } });
}

const present = ({ _id, ...c }) => c;

module.exports = { STAGES, STATES, SOURCES, createClient, updateClient, addNote, listClients, getClient, clientSubscriptions, linkSubscription, present };
