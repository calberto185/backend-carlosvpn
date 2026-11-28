const express = require("express");
const ops = require("../admin/ops");
const plans = require("../admin/plans");
const { createUser, listUsers } = require("../auth/service");
const { generatePassword } = require("../lib/password");
const { makeGuard } = require("../auth/middleware");
const roles = require("../auth/roles");
const { audit } = require("../lib/audit");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function managementRouter({ db, cfg }) {
  const r = express.Router();
  const requirePerm = makeGuard(db);
  const pres = (s, full) => ops.presentSubscription(s, { publicBaseUrl: cfg.publicBaseUrl, full });

  // --- Planes ---
  r.get("/api/plans", requirePerm("settings/plans", "view"), wrap(async (_req, res) => res.json({ plans: await plans.listPlans(db) })));
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
    res.json({ panels: (await ops.listPanels(db)).map(({ _id, ...p }) => p) });
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
  for (const [path, status, action] of [["suspend", "suspended", "subscription_suspend"], ["resume", "active", "subscription_resume"]]) {
    r.post(`/api/subscriptions/:id/${path}`, requirePerm("subscriptions", "update"), wrap(async (req, res) => {
      const s = await ops.setStatusById(db, req.params.id, status);
      await audit(db, req, action, s.id);
      res.json({ subscription: pres(s, false) });
    }));
  }
  r.post("/api/subscriptions/:id/extend", requirePerm("subscriptions", "update"), wrap(async (req, res) => {
    const s = await ops.extendSubscription(db, req.params.id, (req.body || {}).days);
    await audit(db, req, "subscription_extend", s.id, { days: Number(req.body.days) });
    res.json({ subscription: pres(s, false) });
  }));

  // --- Usuarios (solo admin). La contraseña se genera y se muestra una única vez. ---
  r.get("/api/users", requirePerm("users", "view"), wrap(async (_req, res) => res.json({ users: await listUsers(db) })));
  r.post("/api/users", requirePerm("users", "create"), wrap(async (req, res) => {
    const b = req.body || {};
    const password = generatePassword();
    const user = await createUser(db, { email: b.email, password, role: b.role, language: b.language, name: b.name });
    await audit(db, req, "user_create", user.id, { role: user.role });
    res.status(201).json({ user, temporary_password: password });
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
  r.post("/api/roles", requirePerm("roles", "create"), wrap(async (req, res) => {
    const { _id, ...role } = await roles.createRole(db, req.body || {});
    await audit(db, req, "role_create", role.name);
    res.status(201).json({ role });
  }));
  r.post("/api/roles/sync-routes", requirePerm("roles", "update"), wrap(async (req, res) => {
    const updated = await roles.syncRoutes(db);
    await audit(db, req, "role_sync_routes", "", { updated });
    res.json({ updated });
  }));
  r.patch("/api/roles/:id", requirePerm("roles", "update"), wrap(async (req, res) => {
    const role = await roles.updateRole(db, req.params.id, req.body || {});
    await audit(db, req, "role_update", role.name, { fields: Object.keys(req.body || {}) });
    res.json({ role });
  }));
  r.delete("/api/roles/:id", requirePerm("roles", "delete"), wrap(async (req, res) => {
    await roles.deleteRole(db, req.params.id);
    await audit(db, req, "role_delete", req.params.id);
    res.json({ ok: true });
  }));
  return r;
}
module.exports = { managementRouter };
