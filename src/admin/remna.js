// Operaciones sobre los paneles Remnawave: credenciales, comprobación, aprovisionamiento por plan
// y propagación de suspender/reanudar/extender al panel (si no, el enlace directo del panel seguiría funcionando).
const crypto = require("crypto");
const { encrypt, decrypt } = require("../lib/crypto");
const { createRwClient, RwError } = require("../providers/remnawaveClient");
const { generateSubToken } = require("../lib/token");
const { getPlan } = require("./plans");

const err = (m) => Object.assign(new Error(m), { code: "VALIDATION" });
const isHttpUrl = (u) => /^https?:\/\/[^\s/]+/i.test(String(u || ""));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GB = 1024 ** 3;

// Quita secretos antes de mostrar un panel por API o CLI.
function publicPanel(p) {
  const { _id, api_token, caddy_key, ...rest } = p;
  return { ...rest, has_token: !!api_token };
}

async function setPanelCredentials(db, cfg, panelId, { api_url, api_token, caddy_key, squad_uuids }) {
  const panel = await db.collection("panels").findOne({ id: panelId });
  if (!panel) throw err(`No existe el panel "${panelId}"`);
  const set = { api_ok: null, api_checked_at: null };
  if (api_url !== undefined) {
    if (!isHttpUrl(api_url)) throw err("api_url debe empezar por http:// o https://");
    set.api_url = String(api_url).replace(/\/+$/, "");
  }
  if (api_token !== undefined) {
    if (String(api_token).length < 16) throw err("El token de API parece demasiado corto");
    set.api_token = encrypt(String(api_token).trim(), cfg.encryptionKey);
  }
  if (caddy_key !== undefined) set.caddy_key = caddy_key ? encrypt(String(caddy_key).trim(), cfg.encryptionKey) : "";
  if (squad_uuids !== undefined) {
    const l = [].concat(squad_uuids).map(String).filter(Boolean);
    if (l.some((u) => !UUID_RE.test(u))) throw err("squad_uuids debe contener UUID válidos");
    set.squad_uuids = l;
  }
  await db.collection("panels").updateOne({ id: panelId }, { $set: set });
  return publicPanel(await db.collection("panels").findOne({ id: panelId }));
}

async function clientFor(db, cfg, panelId, { fetchImpl } = {}) {
  const panel = await db.collection("panels").findOne({ id: panelId });
  if (!panel) throw err(`No existe el panel "${panelId}"`);
  if (panel.provider !== "remnawave") throw err(`El panel "${panelId}" no es Remnawave`);
  if (!panel.api_url || !panel.api_token) throw err(`El panel "${panelId}" no tiene api_url/token (usa panel:set-token)`);
  const rw = createRwClient({
    baseUrl: panel.api_url,
    token: decrypt(panel.api_token, cfg.encryptionKey),
    caddyKey: panel.caddy_key ? decrypt(panel.caddy_key, cfg.encryptionKey) : undefined,
    fetchImpl,
  });
  return { rw, panel };
}

// Comprobación de solo lectura: no crea ni modifica nada en el panel.
async function checkPanel(db, cfg, panelId, opts = {}) {
  const { rw } = await clientFor(db, cfg, panelId, opts);
  const out = { panel_id: panelId, ok: false, checks: {} };
  for (const [name, fn] of [["health", () => rw.health()], ["stats", () => rw.stats()], ["nodes", async () => (await rw.nodes()).length], ["squads", async () => { const s = await rw.squads(); return (s.internalSquads || s || []).length; }]]) {
    try { out.checks[name] = { ok: true, value: await fn() }; } catch (e) { out.checks[name] = { ok: false, error: e.message, status: e.status || 0 }; }
  }
  out.ok = Object.values(out.checks).every((c) => c.ok);
  await db.collection("panels").updateOne({ id: panelId }, { $set: { api_ok: out.ok, api_checked_at: new Date() } });
  return out;
}

// Busca al usuario en el panel con el dato que tengamos de la cuenta.
async function resolveRwUser(rw, account) {
  const r = account.rw_username ? await rw.getByUsername(account.rw_username) : await rw.getByShortUuid(account.short_uuid);
  const user = Array.isArray(r) ? r[0] : r; // algunas versiones devuelven lista
  if (!user) throw new RwError("Usuario no encontrado en el panel", { status: 404, code: "RW_NOT_FOUND" });
  return user;
}

// Crea la suscripción y sus usuarios en cada panel del plan. Si algún panel falla, deshace los ya creados.
async function provisionFromPlan(db, cfg, input, { fetchImpl, publicBaseUrl }) {
  const plan = await getPlan(db, input.plan_id);
  if (!plan) throw err("No existe ese plan");
  if (!plan.panel_ids || !plan.panel_ids.length) throw err("El plan no tiene paneles asignados");
  const now = Date.now();
  const expires_at = new Date(now + plan.duration_days * 864e5).toISOString();
  const created = []; // { rw, user, panel_id }
  const accounts = [];
  try {
    for (const panelId of plan.panel_ids) {
      const { rw, panel } = await clientFor(db, cfg, panelId, { fetchImpl });
      const username = `cv-${crypto.randomBytes(6).toString("hex")}`;
      const body = {
        username,
        expireAt: expires_at,
        trafficLimitBytes: plan.traffic.mode === "quota" ? Math.round(plan.traffic.gb * GB) : 0,
        hwidDeviceLimit: plan.hwid_limit,
        description: String(input.label || "").slice(0, 120) || undefined,
      };
      if (plan.traffic.mode === "quota") body.trafficLimitStrategy = "NO_RESET";
      if (panel.squad_uuids && panel.squad_uuids.length) body.activeInternalSquads = panel.squad_uuids;
      if (input.email) body.email = String(input.email).slice(0, 200);
      if (input.telegram_id) body.telegramId = Number(input.telegram_id);
      const user = await rw.createUser(body);
      created.push({ rw, user });
      if (!user || !user.shortUuid) throw new RwError("El panel no devolvió shortUuid", { code: "RW_ERROR" });
      accounts.push({ panel_id: panelId, short_uuid: user.shortUuid, rw_username: user.username || username, status: "active" });
    }
  } catch (e) {
    for (const c of created) { try { await c.rw.deleteUser(c.user); } catch { /* mejor esfuerzo */ } }
    throw e;
  }
  const doc = {
    id: crypto.randomUUID(), sub_token: generateSubToken(), label: input.label || "", status: "active",
    language: input.language || undefined, expires_at, plan_id: plan.id, accounts, createdAt: new Date(),
  };
  if (!doc.language) delete doc.language;
  await db.collection("subscriptions").insertOne(doc);
  return { doc, url: `${publicBaseUrl}/s/${doc.sub_token}` };
}

const ACTIONS = {
  suspend: (rw, u) => rw.disable(u),
  resume: (rw, u) => rw.enable(u),
  extend: (rw, u, arg) => rw.extend(u, arg.days),
  reset_traffic: (rw, u) => rw.resetTraffic(u),
};

// Aplica la acción en todos los paneles de la suscripción. Nunca lanza: devuelve el resultado por panel.
async function propagate(db, cfg, sub, action, arg = {}, { fetchImpl } = {}) {
  const fn = ACTIONS[action];
  if (!fn) throw err(`acción desconocida: ${action}`);
  const results = [];
  for (const acc of sub.accounts || []) {
    try {
      const panel = await db.collection("panels").findOne({ id: acc.panel_id });
      if (!panel || !panel.api_token) { results.push({ panel_id: acc.panel_id, ok: false, skipped: true, error: "panel sin token de API" }); continue; }
      const { rw } = await clientFor(db, cfg, acc.panel_id, { fetchImpl });
      const user = await resolveRwUser(rw, acc);
      await fn(rw, user, arg);
      results.push({ panel_id: acc.panel_id, ok: true });
    } catch (e) {
      results.push({ panel_id: acc.panel_id, ok: false, error: e.message });
    }
  }
  return results;
}

// Revoca el enlace del panel: genera nuevo shortUuid y lo guarda. El enlace público /s/<token> NO cambia.
async function revokeAccounts(db, cfg, sub, { fetchImpl } = {}) {
  const results = [];
  const accounts = [...(sub.accounts || [])];
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    try {
      const { rw } = await clientFor(db, cfg, acc.panel_id, { fetchImpl });
      const user = await resolveRwUser(rw, acc);
      const updated = await rw.revoke(user);
      if (updated && updated.shortUuid) accounts[i] = { ...acc, short_uuid: updated.shortUuid };
      results.push({ panel_id: acc.panel_id, ok: true });
    } catch (e) { results.push({ panel_id: acc.panel_id, ok: false, error: e.message }); }
  }
  await db.collection("subscriptions").updateOne({ id: sub.id }, { $set: { accounts } });
  return results;
}

// Dispositivos (HWID) de la suscripción, agrupados por panel.
async function listHwid(db, cfg, sub, { fetchImpl } = {}) {
  const out = [];
  for (const acc of sub.accounts || []) {
    try {
      const { rw } = await clientFor(db, cfg, acc.panel_id, { fetchImpl });
      const user = await resolveRwUser(rw, acc);
      const r = await rw.hwidList(user);
      out.push({ panel_id: acc.panel_id, total: r.total ?? (r.devices || []).length, devices: (r.devices || []).map((d) => ({ hwid: d.hwid, platform: d.platform, os_version: d.osVersion, model: d.deviceModel, created_at: d.createdAt })) });
    } catch (e) { out.push({ panel_id: acc.panel_id, error: e.message }); }
  }
  return out;
}

async function removeHwid(db, cfg, sub, panelId, hwid, { fetchImpl } = {}) {
  const acc = (sub.accounts || []).find((a) => a.panel_id === panelId);
  if (!acc) throw err("Esa suscripción no tiene ese panel");
  const { rw } = await clientFor(db, cfg, panelId, { fetchImpl });
  await rw.hwidDelete(await resolveRwUser(rw, acc), String(hwid));
  return true;
}

module.exports = { publicPanel, setPanelCredentials, clientFor, checkPanel, provisionFromPlan, propagate, revokeAccounts, listHwid, removeHwid };
