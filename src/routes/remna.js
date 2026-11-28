// Administración de Remnawave desde el panel. Pantalla "remnawave" para infraestructura;
// "subscriptions" para lo que afecta a un cliente concreto.
const express = require("express");
const remna = require("../admin/remna");
const ops = require("../admin/ops");
const { makeGuard } = require("../auth/middleware");
const { audit } = require("../lib/audit");
const clients = require("../admin/clients");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const NODE_ACTIONS = ["enable", "disable", "restart"];
// Errores del panel remoto → 502 con mensaje útil; el resto sigue su camino normal.
const rwFail = (res, e) => res.status(e && e.name === "RwError" ? 502 : 500).json({ error: "panel_error", message: e.message, status: e.status || 0 });
const guarded = (fn) => wrap(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && (e.name === "RwError")) return rwFail(res, e); throw e; } });

function remnaRouter({ db, cfg, fetchImpl }) {
  const r = express.Router();
  const requirePerm = makeGuard(db);
  const opts = { fetchImpl };
  const panelOf = (req) => { const id = String(req.query.panel || ""); if (!id) throw Object.assign(new Error("falta ?panel=<id>"), { code: "VALIDATION" }); return id; };
  const sub = async (req, res) => { const s = await ops.getSubscriptionById(db, req.params.id); if (!s) { res.status(404).json({ error: "not_found" }); return null; } return s; };

  r.get("/api/remna/check", requirePerm("remnawave", "view"), guarded(async (req, res) => {
    res.json(await remna.checkPanel(db, cfg, panelOf(req), opts));
  }));
  r.get("/api/remna/nodes", requirePerm("remnawave", "view"), guarded(async (req, res) => {
    const { rw } = await remna.clientFor(db, cfg, panelOf(req), opts);
    res.json({ nodes: await rw.nodes() });
  }));
  r.get("/api/remna/hosts", requirePerm("remnawave", "view"), guarded(async (req, res) => {
    const { rw } = await remna.clientFor(db, cfg, panelOf(req), opts);
    res.json({ hosts: await rw.hosts() });
  }));
  r.get("/api/remna/squads", requirePerm("remnawave", "view"), guarded(async (req, res) => {
    const { rw } = await remna.clientFor(db, cfg, panelOf(req), opts);
    res.json({ squads: await rw.squads() });
  }));
  r.get("/api/remna/stats", requirePerm("remnawave", "view"), guarded(async (req, res) => {
    const { rw } = await remna.clientFor(db, cfg, panelOf(req), opts);
    res.json({ stats: await rw.stats() });
  }));
  r.post("/api/remna/nodes/:uuid/:action", requirePerm("remnawave", "update"), guarded(async (req, res) => {
    if (!NODE_ACTIONS.includes(req.params.action)) return res.status(400).json({ error: "validation", message: `acción debe ser: ${NODE_ACTIONS.join(", ")}` });
    const { rw } = await remna.clientFor(db, cfg, panelOf(req), opts);
    await rw.nodeAction(req.params.uuid, req.params.action);
    await audit(db, req, `node_${req.params.action}`, req.params.uuid, { panel: req.query.panel });
    res.json({ ok: true });
  }));

  // Alta de cliente a partir de un plan: crea el usuario en cada panel del plan y la suscripción.
  r.post("/api/subscriptions/provision", requirePerm("subscriptions", "create"), guarded(async (req, res) => {
    const b = req.body || {};
    if (b.client_id && !(await clients.getClient(db, b.client_id))) return res.status(400).json({ error: "validation", message: "No existe ese cliente" });
    const out = await remna.provisionFromPlan(db, cfg, { plan_id: b.plan_id, label: b.label, language: b.language, email: b.email, telegram_id: b.telegram_id }, { fetchImpl, publicBaseUrl: cfg.publicBaseUrl });
    if (b.client_id) await clients.linkSubscription(db, b.client_id, out.doc.id);
    await audit(db, req, "subscription_provision", out.doc.id, { plan_id: b.plan_id, client_id: b.client_id || null });
    res.status(201).json({ subscription: ops.presentSubscription(out.doc, { publicBaseUrl: cfg.publicBaseUrl, full: true }) });
  }));

  r.post("/api/subscriptions/:id/reset-traffic", requirePerm("subscriptions", "update"), guarded(async (req, res) => {
    const s = await sub(req, res); if (!s) return;
    const panel_sync = await remna.propagate(db, cfg, s, "reset_traffic", {}, opts);
    await audit(db, req, "subscription_reset_traffic", s.id, { panel_sync });
    res.json({ panel_sync });
  }));
  r.post("/api/subscriptions/:id/revoke", requirePerm("subscriptions", "update"), guarded(async (req, res) => {
    const s = await sub(req, res); if (!s) return;
    const panel_sync = await remna.revokeAccounts(db, cfg, s, opts);
    await audit(db, req, "subscription_revoke", s.id, { panel_sync });
    res.json({ panel_sync });
  }));
  r.get("/api/subscriptions/:id/hwid", requirePerm("subscriptions", "view"), guarded(async (req, res) => {
    const s = await sub(req, res); if (!s) return;
    res.json({ panels: await remna.listHwid(db, cfg, s, opts) });
  }));
  r.delete("/api/subscriptions/:id/hwid/:panel/:hwid", requirePerm("subscriptions", "update"), guarded(async (req, res) => {
    const s = await sub(req, res); if (!s) return;
    await remna.removeHwid(db, cfg, s, req.params.panel, req.params.hwid, opts);
    await audit(db, req, "subscription_hwid_remove", s.id, { panel: req.params.panel });
    res.json({ ok: true });
  }));
  return r;
}
module.exports = { remnaRouter };
