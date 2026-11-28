const express = require("express");
const ops = require("../admin/ops");
const plans = require("../admin/plans");
const { createUser, listUsers } = require("../auth/service");
const { generatePassword } = require("../lib/password");
const { makeGuard } = require("../auth/middleware");
const roles = require("../auth/roles");
const { audit } = require("../lib/audit");
const remna = require("../admin/remna");
const clients = require("../admin/clients");

// Operaciones que otorgan poder (crear usuarios del panel, editar roles): solo el rol admin, aunque otro rol tenga el permiso marcado.
const adminOnly = (req, res, next) => (req.user && req.user.role === "admin" ? next() : res.status(403).json({ error: "forbidden", message: "Solo un administrador puede hacer esto" }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function managementRouter({ db, cfg, fetchImpl }) {
  const r = express.Router();
  const requirePerm = makeGuard(db);
  const pres = (s, full) => ops.presentSubscription(s, { publicBaseUrl: cfg.publicBaseUrl, full });

  // --- Planes ---
  // ?country=PE añade display_price: el precio de ese país, o el base si no hay uno específico.
  r.get("/api/plans", requirePerm("settings/plans", "view"), wrap(async (req, res) => {
    const list = await plans.listPlans(db);
    const c = req.query.country;
    res.json({ plans: (c ? list.map((p) => ({ ...p, display_price: plans.priceFor(p, c) })) : list).map(({ _id, ...p }) => p) });
  }));
  r.post("/api/plans", requirePerm("settings/plans", "create"), wrap(async (req, res) => {
    const p = await plans.createPlan(db, req.body || {});
    await audit(db, req, "plan_create", p.id);
    res.status(201).json({ plan: p });
  }));
  r.patch("/api/plans/:id", requirePerm("settings/plans", "update"), wrap(async (req, res) => {
    const p = await plans.updatePlan(db, req.params.id, req.body || {});
    await audit(db, req, "plan_update", p.id, { fields: Object.keys(req.body || {}) });
    res.json({ plan: p });
  }));

  // --- Paneles (solo lectura; el alta sigue siendo por CLI hasta tener el proveedor completo) ---
  r.get("/api/panels", requirePerm("settings/servers", "view"), wrap(async (_req, res) => {
    res.json({ panels: (await ops.listPanels(db)).map(remna.publicPanel) });
  }));

  // --- Suscripciones ---
  r.get("/api/subscriptions", requirePerm("subscriptions", "view"), wrap(async (_req, res) => {
    res.json({ subscriptions: (await ops.listSubscriptions(db)).map((s) => pres(s, false)) });
  }));
  r.get("/api/subscriptions/:id", requirePerm("subscriptions", "view"), wrap(async (req, res) => {
    const s = await ops.getSubscriptionById(db, req.params.id);
    if (!s) return res.status(404).json({ error: "not_found" });
    await audit(db, req, "subscription_view_link", s.id); // ver el enlace completo queda registrado
    res.json({ subscription: pres(s, true) });
  }));
  r.post("/api/subscriptions", requirePerm("subscriptions", "create"), wrap(async (req, res) => {
    const b = req.body || {};
    const out = await ops.addSubscription(db, { panel_id: b.panel_id, short_uuid: b.short_uuid, days: b.days, language: b.language, label: b.label, plan_id: b.plan_id }, { publicBaseUrl: cfg.publicBaseUrl });
    await audit(db, req, "subscription_create", out.doc.id);
    res.status(201).json({ subscription: pres(out.doc, true) });
  }));
  // Primero se aplica aquí (el agregador deja de servir al instante) y luego se propaga al panel.
  for (const [path, status, action] of [["suspend", "suspended", "subscription_suspend"], ["resume", "active", "subscription_resume"]]) {
    r.post(`/api/subscriptions/:id/${path}`, requirePerm("subscriptions", "update"), wrap(async (req, res) => {
      const s = await ops.setStatusById(db, req.params.id, status);
      const panel_sync = await remna.propagate(db, cfg, s, path, {}, { fetchImpl });
      await audit(db, req, action, s.id, { panel_sync });
      res.json({ subscription: pres(s, false), panel_sync });
    }));
  }
  r.post("/api/subscriptions/:id/extend", requirePerm("subscriptions", "update"), wrap(async (req, res) => {
    const s = await ops.extendSubscription(db, req.params.id, (req.body || {}).days);
    const panel_sync = await remna.propagate(db, cfg, s, "extend", { days: Number(req.body.days) }, { fetchImpl });
    await audit(db, req, "subscription_extend", s.id, { days: Number(req.body.days), panel_sync });
    res.json({ subscription: pres(s, false), panel_sync });
  }));

  // --- Usuarios (solo admin). La contraseña se genera y se muestra una única vez. ---
  r.get("/api/users", requirePerm("users", "view"), wrap(async (_req, res) => res.json({ users: await listUsers(db) })));
  r.post("/api/users", requirePerm("users", "create"), adminOnly, wrap(async (req, res) => {
    const b = req.body || {};
    const password = generatePassword();
    const user = await createUser(db, { email: b.email, password, role: b.role, language: b.language, name: b.name });
    await audit(db, req, "user_create", user.id, { role: user.role });
    res.status(201).json({ user, temporary_password: password });
  }));

  // --- Clientes (CRM). Nunca tienen acceso al panel. ---
  const cid = (req) => req.user && req.user.id;
  r.get("/api/clients", requirePerm("clients", "view"), wrap(async (req, res) => {
    const { stage, tag, state, q } = req.query;
    res.json({ clients: (await clients.listClients(db, { stage, tag, state, q })).map(clients.present) });
  }));
  r.get("/api/clients/:id", requirePerm("clients", "view"), wrap(async (req, res) => {
    const c = await clients.getClient(db, req.params.id);
    if (!c) return res.status(404).json({ error: "not_found" });
    res.json({ client: clients.present(c), subscriptions: (await clients.clientSubscriptions(db, c.id)).map((s) => pres(s, false)) });
  }));
  r.post("/api/clients", requirePerm("clients", "create"), wrap(async (req, res) => {
    const c = await clients.createClient(db, req.body || {}, cid(req));
    await audit(db, req, "client_create", c.id);
    res.status(201).json({ client: clients.present(c) });
  }));
  r.patch("/api/clients/:id", requirePerm("clients", "update"), wrap(async (req, res) => {
    const c = await clients.updateClient(db, req.params.id, req.body || {});
    await audit(db, req, "client_update", c.id, { fields: Object.keys(req.body || {}) });
    res.json({ client: clients.present(c) });
  }));
  r.post("/api/clients/:id/notes", requirePerm("clients", "update"), wrap(async (req, res) => {
    const c = await clients.addNote(db, req.params.id, (req.body || {}).text, cid(req));
    await audit(db, req, "client_note", c.id); // el texto de la nota no se copia a la bitácora
    res.status(201).json({ client: clients.present(c) });
  }));
  r.post("/api/clients/:id/subscriptions/:subId", requirePerm("clients", "update"), wrap(async (req, res) => {
    await clients.linkSubscription(db, req.params.id, req.params.subId);
    await audit(db, req, "client_link_subscription", req.params.id, { subscription: req.params.subId });
    res.json({ ok: true });
  }));

  // --- Bitácora ---
  r.get("/api/audit", requirePerm("activity", "view"), wrap(async (_req, res) => {
    res.json({ entries: (await db.collection("audit_log").find({}).sort({ at: -1 }).limit(100).toArray()).map(({ _id, ...e }) => e) });
  }));

  // --- Roles y permisos por pantalla y acción ---
  r.get("/api/roles", requirePerm("roles", "view"), wrap(async (_req, res) => res.json({ roles: await roles.listRoles(db) })));
  r.get("/api/roles/:name", requirePerm(), wrap(async (req, res) => {
    const role = await roles.getRole(db, req.params.name);
    if (!role) return res.status(404).json({ error: "not_found" });
    res.json({ role });
  }));
  r.post("/api/roles", requirePerm("roles", "create"), adminOnly, wrap(async (req, res) => {
    const { _id, ...role } = await roles.createRole(db, req.body || {});
    await audit(db, req, "role_create", role.name);
    res.status(201).json({ role });
  }));
  r.post("/api/roles/sync-routes", requirePerm("roles", "update"), adminOnly, wrap(async (req, res) => {
    const updated = await roles.syncRoutes(db);
    await audit(db, req, "role_sync_routes", "", { updated });
    res.json({ updated });
  }));
  r.patch("/api/roles/:id", requirePerm("roles", "update"), adminOnly, wrap(async (req, res) => {
    const role = await roles.updateRole(db, req.params.id, req.body || {});
    await audit(db, req, "role_update", role.name, { fields: Object.keys(req.body || {}) });
    res.json({ role });
  }));
  r.delete("/api/roles/:id", requirePerm("roles", "delete"), adminOnly, wrap(async (req, res) => {
    await roles.deleteRole(db, req.params.id);
    await audit(db, req, "role_delete", req.params.id);
    res.json({ ok: true });
  }));
  return r;
}
module.exports = { managementRouter };
