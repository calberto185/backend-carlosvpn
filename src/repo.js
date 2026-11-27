// Acceso a datos del agregador. `db` es un Db de MongoDB (o un doble con collection().findOne()).
function createRepo(db) {
  return {
    async getByToken(token) {
      const sub = await db.collection("subscriptions").findOne({ sub_token: token });
      if (!sub) return null;
      const panels = {};
      for (const a of sub.accounts || []) {
        if (!panels[a.panel_id]) {
          const p = await db.collection("panels").findOne({ id: a.panel_id });
          if (p) panels[a.panel_id] = p;
        }
      }
      return { sub, panels };
    },
  };
}
module.exports = { createRepo };
