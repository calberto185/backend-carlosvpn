#!/usr/bin/env node
// Administración por línea de comandos. En el VPS:
//   cd /opt/carlosvpn && docker compose exec backend node src/cli.js <comando> [--opcion valor]
const { MongoClient } = require("mongodb");
const { load } = require("./config");
const ops = require("./admin/ops");

const AYUDA = `Carlos VPN — administración

  panel:add  --id rw1 --sub-url https://sub.carlosvm.me [--provider remnawave] [--name "Remnawave principal"]
  panel:list
  sub:add    --panel rw1 --short-uuid <shortUuid> [--days 30] [--lang es] [--label "prueba"]
  sub:list
  sub:suspend --token <token>
  sub:resume  --token <token>
`;

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2).replace(/-/g, "_");
    const next = argv[i + 1];
    o[k] = next && !next.startsWith("--") ? (i++, next) : true;
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(AYUDA); return; }
  const a = parseArgs(rest);
  const cfg = load();
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db = client.db(cfg.mongoDb);
  try {
    if (cmd === "panel:add") {
      const p = await ops.addPanel(db, { id: a.id, provider: a.provider, name: a.name, sub_url: a.sub_url });
      console.log(`Panel registrado: ${p.id} (${p.provider}) -> ${p.sub_url}`);
    } else if (cmd === "panel:list") {
      const l = await ops.listPanels(db);
      if (!l.length) console.log("(sin paneles)");
      for (const p of l) console.log(`${p.id}\t${p.provider}\t${p.sub_url}`);
    } else if (cmd === "sub:add") {
      const r = await ops.addSubscription(db, { panel_id: a.panel, short_uuid: a.short_uuid, days: a.days, language: a.lang, label: a.label }, { publicBaseUrl: cfg.publicBaseUrl });
      console.log(`Suscripción creada (vence ${r.doc.expires_at.slice(0, 10)}).\nEnlace para el cliente:\n${r.url}`);
    } else if (cmd === "sub:list") {
      const l = await ops.listSubscriptions(db);
      if (!l.length) console.log("(sin suscripciones)");
      for (const s of l) console.log(`${s.sub_token.slice(0, 6)}…\t${s.status}\t${String(s.expires_at).slice(0, 10)}\t${s.label || ""}\t${(s.accounts || []).map((x) => x.panel_id).join(",")}`);
    } else if (cmd === "sub:suspend" || cmd === "sub:resume") {
      await ops.setSubscriptionStatus(db, a.token, cmd === "sub:suspend" ? "suspended" : "active");
      console.log("Hecho.");
    } else {
      console.log(`Comando desconocido: ${cmd}\n\n${AYUDA}`); process.exitCode = 1;
    }
  } catch (e) {
    console.error(`Error: ${e.message}`); process.exitCode = 1;
  } finally {
    await client.close();
  }
}
main();
