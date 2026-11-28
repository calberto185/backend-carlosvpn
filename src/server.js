const { MongoClient } = require("mongodb");
const { load, assertProduction } = require("./config");
const { createApp } = require("./app");
const { createRepo } = require("./repo");
const { createRegistry } = require("./providers");
const { seedRoles } = require("./auth/roles");

async function main() {
  const cfg = load();
  assertProduction(cfg);
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db = client.db(cfg.mongoDb);
  await db.collection("subscriptions").createIndex({ sub_token: 1 }, { unique: true, partialFilterExpression: { sub_token: { $type: "string" } } });
  await db.collection("panels").createIndex({ id: 1 }, { unique: true });
  await db.collection("subscriptions").createIndex({ id: 1 }, { unique: true });
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("users").createIndex({ id: 1 }, { unique: true });
  await db.collection("plans").createIndex({ id: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ token_hash: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }); // MongoDB borra las sesiones vencidas
  await db.collection("audit_log").createIndex({ at: -1 });
  await db.collection("roles").createIndex({ name: 1 }, { unique: true });
  await db.collection("roles").createIndex({ id: 1 }, { unique: true });
  await seedRoles(db); // crea admin/manager/support si faltan y añade pantallas nuevas sin tocar lo editado
  const app = createApp({ repo: createRepo(db), providers: createRegistry(), cfg, db });
  app.listen(cfg.port, () => console.log(`${cfg.brandName} backend en :${cfg.port}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
