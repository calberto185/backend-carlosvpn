#!/usr/bin/env node
// Administración por línea de comandos. En el VPS:
//   cd /opt/carlosvpn && docker compose exec backend node src/cli.js <comando> [--opcion valor]
const { MongoClient } = require("mongodb");
const { load } = require("./config");
const ops = require("./admin/ops");
const plans = require("./admin/plans");
const auth = require("./auth/service");
const rolesSvc = require("./auth/roles");
const { generatePassword } = require("./lib/password");

const AYUDA = `Carlos VPN — administración

  panel:add  --id rw1 --sub-url https://sub.carlosvm.me [--provider remnawave] [--name "Remnawave principal"]
  panel:list
  sub:add    --panel rw1 --short-uuid <shortUuid> [--days 30] [--lang es] [--label "prueba"]
  sub:list
  sub:suspend --token <token>
  sub:resume  --token <token>
  user:create --email a@b.com --role admin|manager|support|<rol propio>|client [--lang es] [--name "Nombre"]
              (la contraseña se genera y se muestra UNA vez; no se pasa por la línea de comandos)
  user:passwd --email a@b.com     genera una contraseña nueva y cierra las sesiones de ese usuario
  user:list
  plan:seed   [--panel rw1]       crea 3 planes de ejemplo (mensual, trimestral, anual), inactivos y con precio 0
  plan:list
  role:list
  role:sync                        añade a los roles las pantallas nuevas del catálogo
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
    await rolesSvc.seedRoles(db); // idempotente: garantiza que existan los roles de sistema
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
    } else if (cmd === "role:list") {
      for (const r of await rolesSvc.listRoles(db)) console.log(`${r.name}\t${r.isSystem ? "sistema" : "propio"}\t${r.allowedRoutes.join(", ")}`);
    } else if (cmd === "role:sync") {
      console.log(`Roles actualizados: ${await rolesSvc.syncRoutes(db)}`);
    } else if (cmd === "user:create") {
      const pw = generatePassword();
      const u = await auth.createUser(db, { email: a.email, password: pw, role: a.role, language: a.lang, name: a.name });
      console.log(`Usuario creado: ${u.email} (${u.role}).\nContraseña (guárdala ahora, no se vuelve a mostrar):\n${pw}`);
    } else if (cmd === "user:passwd") {
      const pw = generatePassword();
      await auth.setPassword(db, a.email, pw);
      console.log(`Contraseña nueva para ${auth.normEmail(a.email)} (sesiones cerradas):\n${pw}`);
    } else if (cmd === "user:list") {
      const l = await auth.listUsers(db);
      if (!l.length) console.log("(sin usuarios)");
      for (const u of l) console.log(`${u.email}\t${u.role}\t${u.status}\t${u.language || "-"}`);
    } else if (cmd === "plan:seed") {
      const c = await plans.seedExamplePlans(db, { panel_ids: a.panel ? [a.panel] : [] });
      console.log(c.length ? `Planes creados (inactivos, precio 0): ${c.map((p) => p.id).join(", ")}` : "Los planes de ejemplo ya existen.");
    } else if (cmd === "plan:list") {
      const l = await plans.listPlans(db);
      if (!l.length) console.log("(sin planes)");
      for (const p of l) console.log(`${p.id}\t${p.active ? "activo" : "inactivo"}\t${p.price.amount} ${p.price.currency}\t${p.duration_days}d\t${p.traffic.mode === "quota" ? p.traffic.gb + "GB" : "ilimitado"}\t${p.hwid_limit} disp.`);
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
