// Bitácora de acciones sensibles. Nunca debe romper la operación que registra.
async function audit(db, req, action, target = "", meta = {}) {
  try {
    await db.collection("audit_log").insertOne({
      at: new Date(), action, target: String(target),
      actor_id: req.user ? req.user.id : null, actor_role: req.user ? req.user.role : null,
      ip: req.ip, meta,
    });
  } catch (e) { console.error("[audit]", e.message); }
}
module.exports = { audit };
