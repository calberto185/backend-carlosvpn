const { MongoClient } = require("mongodb");
const { load, assertProduction } = require("./config");
const { createApp } = require("./app");
const { createRepo } = require("./repo");
const { createRegistry } = require("./providers");

async function main() {
  const cfg = load();
  assertProduction(cfg);
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db = client.db(cfg.mongoDb);
  await db.collection("subscriptions").createIndex({ sub_token: 1 }, { unique: true, partialFilterExpression: { sub_token: { $type: "string" } } });
  await db.collection("panels").createIndex({ id: 1 }, { unique: true });
  const app = createApp({ repo: createRepo(db), providers: createRegistry(), cfg });
  app.listen(cfg.port, () => console.log(`${cfg.brandName} backend en :${cfg.port}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
