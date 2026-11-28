// Planes: lo que se vende. Los precios y límites viven en la base de datos, nunca en el código.
const { LOCALES, normalize } = require("../i18n");

const err = (m) => Object.assign(new Error(m), { code: "VALIDATION" });
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const CURRENCIES = ["USD", "EUR", "RUB", "PEN", "USDT"];

// Nombres por idioma: { es: "Mensual", en: "Monthly", ... }. Se exige al menos uno; el resto cae a inglés/español.
function cleanNames(names) {
  const out = {};
  for (const [k, v] of Object.entries(names || {})) {
    const l = normalize(k);
    if (!l) throw err(`names: idioma desconocido "${k}" (usa ${LOCALES.join(", ")})`);
    const s = String(v || "").trim();
    if (s) out[l] = s.slice(0, 60);
  }
  if (!Object.keys(out).length) throw err("names debe tener al menos un idioma con texto");
  return out;
}

// Textos por idioma: { es: "texto", en: "text" }.
function cleanTexts(obj, field, max) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const l = normalize(k);
    if (!l) throw err(`${field}: idioma desconocido "${k}" (usa ${LOCALES.join(", ")})`);
    const t = String(v || "").trim();
    if (t) out[l] = t.slice(0, max);
  }
  return out;
}

// Características por idioma: { es: ["3 dispositivos", ...] } (máx. 12 por idioma).
function cleanFeatures(obj) {
  const out = {};
  for (const [k, list] of Object.entries(obj || {})) {
    const l = normalize(k);
    if (!l) throw err(`features: idioma desconocido "${k}" (usa ${LOCALES.join(", ")})`);
    if (!Array.isArray(list)) throw err(`features.${k} debe ser una lista`);
    const items = list.map((x) => String(x || "").trim().slice(0, 80)).filter(Boolean).slice(0, 12);
    if (items.length) out[l] = items;
  }
  return out;
}

// Precio distinto por país (ISO-3166 alfa-2). Si no hay precio para el país, se usa el precio base.
function cleanCountryPrices(list) {
  if (!Array.isArray(list)) throw err("country_prices debe ser una lista");
  const seen = new Set(), out = [];
  for (const c of list) {
    const country = String((c && c.country) || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw err("country_prices[].country debe ser un código de 2 letras (ej. PE, RU)");
    if (seen.has(country)) throw err(`country_prices: país repetido (${country})`);
    seen.add(country);
    const amount = Number(c.amount), currency = String(c.currency || "").toUpperCase();
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e6) throw err(`country_prices[${country}].amount inválido`);
    if (!CURRENCIES.includes(currency)) throw err(`country_prices[${country}].currency debe ser: ${CURRENCIES.join(", ")}`);
    out.push({ country, amount: Math.round(amount * 100) / 100, currency });
  }
  return out;
}

// Precio que ve un cliente: el de su país si existe, o el base.
function priceFor(plan, country) {
  const c = String(country || "").toUpperCase();
  const hit = (plan.country_prices || []).find((x) => x.country === c);
  return hit ? { amount: hit.amount, currency: hit.currency } : plan.price;
}

function validatePlan(p, { partial = false } = {}) {
  const out = {};
  const has = (k) => p[k] !== undefined;
  if (!partial || has("id")) {
    if (!ID_RE.test(String(p.id || ""))) throw err("id inválido (2-32 caracteres: letras minúsculas, números, - y _)");
    out.id = p.id;
  }
  if (!partial || has("names")) out.names = cleanNames(p.names);
  if (!partial || has("price")) {
    const amount = Number(p.price && p.price.amount), currency = String((p.price && p.price.currency) || "").toUpperCase();
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e6) throw err("price.amount debe ser un número entre 0 y 1000000");
    if (!CURRENCIES.includes(currency)) throw err(`price.currency debe ser: ${CURRENCIES.join(", ")}`);
    out.price = { amount: Math.round(amount * 100) / 100, currency };
  }
  if (!partial || has("duration_days")) {
    const d = Number(p.duration_days);
    if (!Number.isInteger(d) || d < 1 || d > 3650) throw err("duration_days debe ser un entero entre 1 y 3650");
    out.duration_days = d;
  }
  if (!partial || has("traffic")) {
    const mode = p.traffic && p.traffic.mode;
    if (mode === "unlimited") out.traffic = { mode };
    else if (mode === "quota") {
      const gb = Number(p.traffic.gb);
      if (!Number.isFinite(gb) || gb <= 0 || gb > 100000) throw err("traffic.gb debe ser mayor que 0 con modo quota");
      out.traffic = { mode, gb };
    } else throw err("traffic.mode debe ser unlimited o quota");
  }
  if (!partial || has("hwid_limit")) {
    const h = Number(p.hwid_limit);
    if (!Number.isInteger(h) || h < 1 || h > 50) throw err("hwid_limit debe ser un entero entre 1 y 50");
    out.hwid_limit = h;
  }
  if (!partial || has("panel_ids")) {
    if (!Array.isArray(p.panel_ids)) throw err("panel_ids debe ser una lista de ids de panel");
    out.panel_ids = [...new Set(p.panel_ids.map(String))];
  }
  if (has("descriptions")) out.descriptions = cleanTexts(p.descriptions, "descriptions", 300);
  if (has("features")) out.features = cleanFeatures(p.features);
  if (has("country_prices")) out.country_prices = cleanCountryPrices(p.country_prices);
  if (has("visible")) out.visible = !!p.visible;
  if (has("main")) out.main = !!p.main;
  if (has("active")) out.active = !!p.active;
  if (has("sort")) { const s = Number(p.sort); if (!Number.isInteger(s)) throw err("sort debe ser entero"); out.sort = s; }
  return out;
}

async function checkPanels(db, ids) {
  for (const id of ids || []) if (!(await db.collection("panels").findOne({ id }))) throw err(`No existe el panel "${id}"`);
}

async function createPlan(db, input) {
  const v = validatePlan(input);
  if (await db.collection("plans").findOne({ id: v.id })) throw err(`Ya existe el plan "${v.id}"`);
  await checkPanels(db, v.panel_ids);
  const doc = { active: false, visible: false, main: false, descriptions: {}, features: {}, country_prices: [], sort: 0, ...v, createdAt: new Date(), updatedAt: new Date() };
  await db.collection("plans").insertOne(doc);
  return doc;
}

async function updatePlan(db, id, patch) {
  const cur = await db.collection("plans").findOne({ id });
  if (!cur) throw err("No existe ese plan");
  if (patch.id !== undefined && patch.id !== id) throw err("el id del plan no se puede cambiar");
  const { id: _omit, ...rest } = patch;
  const v = validatePlan(rest, { partial: true });
  if (v.panel_ids) await checkPanels(db, v.panel_ids);
  await db.collection("plans").updateOne({ id }, { $set: { ...v, updatedAt: new Date() } });
  return db.collection("plans").findOne({ id });
}

async function listPlans(db, { activeOnly = false } = {}) {
  const all = await db.collection("plans").find(activeOnly ? { active: true } : {}).toArray();
  return all.sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.id.localeCompare(b.id));
}

const getPlan = (db, id) => db.collection("plans").findOne({ id });

// Tres planes de ejemplo. Nacen INACTIVOS y con precio 0: no se pueden vender hasta que se fijen los precios reales.
const EXAMPLES = [
  { id: "mensual", days: 30, names: { es: "Mensual", en: "Monthly", ru: "Месяц" }, sort: 1 },
  { id: "trimestral", days: 90, names: { es: "Trimestral", en: "Quarterly", ru: "3 месяца" }, sort: 2 },
  { id: "anual", days: 365, names: { es: "Anual", en: "Yearly", ru: "Год" }, sort: 3 },
];
async function seedExamplePlans(db, { panel_ids = [] } = {}) {
  const created = [];
  for (const e of EXAMPLES) {
    if (await db.collection("plans").findOne({ id: e.id })) continue;
    created.push(await createPlan(db, {
      id: e.id, names: e.names, price: { amount: 0, currency: "USD" }, duration_days: e.days,
      traffic: { mode: "unlimited" }, hwid_limit: 3, panel_ids, active: false, sort: e.sort,
    }));
  }
  return created;
}

module.exports = { priceFor, validatePlan, createPlan, updatePlan, listPlans, getPlan, seedExamplePlans, CURRENCIES };
