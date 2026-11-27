const test = require("node:test");
const assert = require("node:assert/strict");
const ops = require("../src/admin/ops");
const { isValidSubToken } = require("../src/lib/token");

// Mongo mínimo en memoria
function memDb() {
  const data = {};
  return {
    collection(n) {
      const arr = (data[n] = data[n] || []);
      const match = (f) => (d) => Object.entries(f).every(([k, v]) => d[k] === v);
      return {
        insertOne: async (d) => { arr.push({ ...d }); },
        findOne: async (f) => arr.find(match(f)) || null,
        find: (f) => ({ toArray: async () => arr.filter(match(f)) }),
        updateOne: async (f, u) => { const d = arr.find(match(f)); if (d) Object.assign(d, u.$set); return { matchedCount: d ? 1 : 0 }; },
      };
    },
  };
}
const BASE = { publicBaseUrl: "https://vpn.carlosvm.me" };

test("panel: alta, duplicado y validaciones", async () => {
  const db = memDb();
  const p = await ops.addPanel(db, { id: "rw1", sub_url: "https://sub.carlosvm.me///" });
  assert.equal(p.sub_url, "https://sub.carlosvm.me"); assert.equal(p.provider, "remnawave");
  await assert.rejects(ops.addPanel(db, { id: "rw1", sub_url: "https://x.test" }), /Ya existe/);
  await assert.rejects(ops.addPanel(db, { id: "a", sub_url: "https://x.test" }), /id inválido/);
  await assert.rejects(ops.addPanel(db, { id: "rw2", sub_url: "ftp://x" }), /sub_url/);
  await assert.rejects(ops.addPanel(db, { id: "rw2", provider: "otro", sub_url: "https://x.test" }), /provider/);
  assert.equal((await ops.listPanels(db)).length, 1);
});

test("suscripción: token válido, URL pública, vencimiento e idioma", async () => {
  const db = memDb(); await ops.addPanel(db, { id: "rw1", sub_url: "https://sub.test" });
  const r = await ops.addSubscription(db, { panel_id: "rw1", short_uuid: "abc12345", days: 10, language: "hi-IN", label: "prueba" }, BASE);
  assert.ok(isValidSubToken(r.doc.sub_token));
  assert.equal(r.url, `https://vpn.carlosvm.me/s/${r.doc.sub_token}`);
  assert.equal(r.doc.language, "hi"); assert.equal(r.doc.status, "active");
  const dias = (new Date(r.doc.expires_at) - Date.now()) / 864e5; assert.ok(dias > 9.9 && dias <= 10);
  assert.deepEqual(r.doc.accounts, [{ panel_id: "rw1", short_uuid: "abc12345", status: "active" }]);
  const sin = await ops.addSubscription(db, { panel_id: "rw1", short_uuid: "abc12345" }, BASE);
  assert.ok(!("language" in sin.doc));
});

test("suscripción: rechaza panel inexistente y datos inválidos", async () => {
  const db = memDb(); await ops.addPanel(db, { id: "rw1", sub_url: "https://sub.test" });
  await assert.rejects(ops.addSubscription(db, { panel_id: "nope", short_uuid: "abc12345" }, BASE), /No existe el panel/);
  await assert.rejects(ops.addSubscription(db, { panel_id: "rw1", short_uuid: "x" }, BASE), /short_uuid/);
  await assert.rejects(ops.addSubscription(db, { panel_id: "rw1", short_uuid: "abc12345", days: 0 }, BASE), /days/);
  await assert.rejects(ops.addSubscription(db, { panel_id: "rw1", short_uuid: "abc12345", language: "fr" }, BASE), /language/);
});

test("suspender y reanudar", async () => {
  const db = memDb(); await ops.addPanel(db, { id: "rw1", sub_url: "https://sub.test" });
  const { doc } = await ops.addSubscription(db, { panel_id: "rw1", short_uuid: "abc12345" }, BASE);
  await ops.setSubscriptionStatus(db, doc.sub_token, "suspended");
  assert.equal((await ops.listSubscriptions(db))[0].status, "suspended");
  await ops.setSubscriptionStatus(db, doc.sub_token, "active");
  assert.equal((await ops.listSubscriptions(db))[0].status, "active");
  await assert.rejects(ops.setSubscriptionStatus(db, "corto", "active"), /token/);
  await assert.rejects(ops.setSubscriptionStatus(db, "A".repeat(32), "active"), /No existe/);
});
