const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { memDb } = require("./helpers/memdb");
const auth = require("../src/auth/service");
const plans = require("../src/admin/plans");
const ops = require("../src/admin/ops");
const rolesSvc = require("../src/auth/roles");

const CFG = { brandName: "Carlos VPN", brandNameRu: "КарлосВПН", supportUrl: "", publicBaseUrl: "https://vpn.carlosvm.me", defaultLocale: "es", sessionTtlHours: 12, rateLimitPerMin: 100, upstreamTimeoutMs: 500, subUpdateIntervalHours: 6, encryptionKey: "ab".repeat(32) };
const PW = "una-clave-larga-123";

async function boot(t) {
  const db = memDb(); await rolesSvc.seedRoles(db);
  for (const [email, role] of [["admin@test.com", "admin"], ["gerente@test.com", "manager"], ["soporte@test.com", "support"]]) await auth.createUser(db, { email, password: PW, role });
  await ops.addPanel(db, { id: "rw1", sub_url: "https://sub.test" });
  const app = createApp({ repo: {}, providers: {}, cfg: CFG, db });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = "GET", body, token } = {}) => fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const login = async (email) => (await (await call("/api/auth/login", { method: "POST", body: { email, password: PW, mode: "token" } })).json()).token;
  return { db, call, login };
}

const BASE_PLAN = { id: "mensual", names: { es: "Mensual" }, price: { amount: 5, currency: "USD" }, duration_days: 30, traffic: { mode: "unlimited" }, hwid_limit: 3, panel_ids: ["rw1"] };

test("planes: descripciones y características por idioma, precio por país y validaciones", async (t) => {
  const s = await boot(t);
  const p = await plans.createPlan(s.db, { ...BASE_PLAN, descriptions: { es: "Para uso diario", "ru-RU": "Для каждого дня" }, features: { es: ["3 dispositivos", "  ", "Sin límite"], en: ["3 devices"] }, country_prices: [{ country: "pe", amount: 18.5, currency: "pen" }, { country: "RU", amount: 400, currency: "RUB" }], visible: true, main: true });
  assert.deepEqual(p.descriptions, { es: "Para uso diario", ru: "Для каждого дня" });
  assert.deepEqual(p.features.es, ["3 dispositivos", "Sin límite"]);
  assert.deepEqual(p.country_prices[0], { country: "PE", amount: 18.5, currency: "PEN" });
  assert.equal(p.visible, true); assert.equal(p.main, true);
  assert.deepEqual(plans.priceFor(p, "pe"), { amount: 18.5, currency: "PEN" });
  assert.deepEqual(plans.priceFor(p, "CO"), { amount: 5, currency: "USD" }, "sin precio de país → base");
  assert.deepEqual(plans.priceFor(p, undefined), { amount: 5, currency: "USD" });
  const bad = (patch, re) => assert.rejects(plans.updatePlan(s.db, "mensual", patch), re);
  await bad({ country_prices: [{ country: "PE", amount: 1, currency: "USD" }, { country: "pe", amount: 2, currency: "USD" }] }, /repetido/);
  await bad({ country_prices: [{ country: "PERU", amount: 1, currency: "USD" }] }, /2 letras/);
  await bad({ country_prices: [{ country: "PE", amount: -1, currency: "USD" }] }, /amount/);
  await bad({ country_prices: [{ country: "PE", amount: 1, currency: "XXX" }] }, /currency/);
  await bad({ descriptions: { fr: "hola" } }, /idioma desconocido/);
  await bad({ features: { es: "no es lista" } }, /lista/);
  const adm = await s.login("admin@test.com"), sup = await s.login("soporte@test.com");
  const r = await (await s.call("/api/plans?country=PE", { token: sup })).json();
  assert.deepEqual(r.plans[0].display_price, { amount: 18.5, currency: "PEN" });
  assert.ok(!("display_price" in (await (await s.call("/api/plans", { token: adm })).json()).plans[0]));
});

test("clientes: alta, validaciones, unicidad y que no tengan acceso al panel", async (t) => {
  const s = await boot(t); const adm = await s.login("admin@test.com");
  const mk = (b, token = adm) => s.call("/api/clients", { method: "POST", token, body: b });
  const r = await mk({ name: "  Juan Pérez ", email: "JUAN@X.com", whatsapp: "+51 987 654 321", telegram_id: "12345", country: "pe", lang: "ru-RU", tags: ["VIP", "vip", "latam"], source: "telegram" });
  assert.equal(r.status, 201);
  const c = (await r.json()).client;
  assert.equal(c.name, "Juan Pérez"); assert.equal(c.email, "juan@x.com"); assert.equal(c.whatsapp, "+51987654321");
  assert.equal(c.telegram_id, 12345); assert.equal(c.country, "PE"); assert.equal(c.lang, "ru"); assert.deepEqual(c.tags, ["vip", "latam"]);
  assert.equal(c.pipeline_stage, "lead"); assert.equal(c.state, "pendiente"); assert.ok(!("_id" in c) && !("password" in c) && !("password_hash" in c));
  for (const [b, re] of [[{}, /name/], [{ name: "A", email: "mal" }, /email/], [{ name: "A", whatsapp: "987654321" }, /internacional/], [{ name: "A", telegram_id: "abc" }, /telegram_id/], [{ name: "A", country: "PERU" }, /country/], [{ name: "A", lang: "fr" }, /lang/], [{ name: "A", tags: ["Con Espacio"] }, /tags/], [{ name: "A", pipeline_stage: "x" }, /pipeline_stage/], [{ name: "A", source: "radio" }, /source/]]) {
    const x = await mk(b); assert.equal(x.status, 400, JSON.stringify(b)); assert.match((await x.json()).message, re);
  }
  for (const dup of [{ email: "juan@x.com" }, { whatsapp: "+51987654321" }, { telegram_id: 12345 }]) assert.equal((await mk({ name: "Otro", ...dup })).status, 400, JSON.stringify(dup));
  assert.equal((await s.db.collection("users").find({}).toArray()).length, 3, "crear clientes no crea usuarios del panel");
  assert.equal((await s.db.collection("clients").find({}).toArray()).length, 1);
});

test("clientes: edición, notas, filtros y detalle con suscripciones sin enlaces", async (t) => {
  const s = await boot(t); const mgr = await s.login("gerente@test.com"); const sup = await s.login("soporte@test.com");
  const mk = async (b) => (await (await s.call("/api/clients", { method: "POST", token: mgr, body: b })).json()).client;
  const a = await mk({ name: "Ana Ruiz", email: "ana@x.com", tags: ["vip"], country: "PE" });
  const b = await mk({ name: "Boris", whatsapp: "+79001234567", tags: ["rusia"], pipeline_stage: "activo" });
  const up = await s.call(`/api/clients/${a.id}`, { method: "PATCH", token: mgr, body: { pipeline_stage: "contactado", state: "activo", tags: ["vip", "moroso"] } });
  assert.equal(up.status, 200); assert.equal((await up.json()).client.pipeline_stage, "contactado");
  assert.equal((await s.call(`/api/clients/${a.id}`, { method: "PATCH", token: mgr, body: { email: "" } })).status, 200, "se puede vaciar el correo");
  assert.equal((await s.call(`/api/clients/${a.id}`, { method: "PATCH", token: mgr, body: { whatsapp: "+79001234567" } })).status, 400, "no puede quitarle el WhatsApp a otro");
  assert.equal((await s.call(`/api/clients/nada`, { method: "PATCH", token: mgr, body: { name: "x" } })).status, 400);
  const n = await s.call(`/api/clients/${a.id}/notes`, { method: "POST", token: mgr, body: { text: "Pidió factura" } });
  assert.equal(n.status, 201); const notes = (await n.json()).client.notes; assert.equal(notes[0].text, "Pidió factura"); assert.ok(notes[0].createdBy);
  assert.equal((await s.call(`/api/clients/${a.id}/notes`, { method: "POST", token: mgr, body: { text: "  " } })).status, 400);
  assert.ok(!JSON.stringify(s.db._data.audit_log).includes("Pidió factura"), "el texto de la nota no va a la bitácora");
  const list = async (qs, token = sup) => (await (await s.call(`/api/clients${qs}`, { token })).json()).clients.map((c) => c.name);
  assert.deepEqual((await list("")).sort(), ["Ana Ruiz", "Boris"]);
  assert.deepEqual(await list("?stage=activo"), ["Boris"]);
  assert.deepEqual(await list("?tag=VIP"), ["Ana Ruiz"]);
  assert.deepEqual(await list("?q=79001"), ["Boris"]);
  assert.deepEqual(await list("?q=ana"), ["Ana Ruiz"]);
  assert.deepEqual(await list("?state=activo&tag=moroso"), ["Ana Ruiz"]);
  // suscripciones enlazadas
  const { doc } = await ops.addSubscription(s.db, { panel_id: "rw1", short_uuid: "abc12345", days: 10 }, { publicBaseUrl: CFG.publicBaseUrl });
  assert.equal((await s.call(`/api/clients/${a.id}/subscriptions/${doc.id}`, { method: "POST", token: mgr })).status, 200);
  assert.equal((await s.call(`/api/clients/${a.id}/subscriptions/zzz`, { method: "POST", token: mgr })).status, 400);
  const det = await (await s.call(`/api/clients/${a.id}`, { token: sup })).json();
  assert.equal(det.subscriptions.length, 1);
  const raw = JSON.stringify(det); assert.ok(!raw.includes(doc.sub_token) && !raw.includes("abc12345") && !raw.includes("/s/"));
  assert.equal((await s.call("/api/clients/no-existe", { token: sup })).status, 404);
});

test("clientes: permisos (soporte solo consulta), sin sesión y alta con client_id inexistente", async (t) => {
  const s = await boot(t); const sup = await s.login("soporte@test.com"); const mgr = await s.login("gerente@test.com"); const adm = await s.login("admin@test.com");
  const c = (await (await s.call("/api/clients", { method: "POST", token: mgr, body: { name: "Ana" } })).json()).client;
  assert.equal((await s.call("/api/clients", { token: sup })).status, 200);
  for (const [m, p, b] of [["POST", "/api/clients", { name: "X" }], ["PATCH", `/api/clients/${c.id}`, { name: "Y" }], ["POST", `/api/clients/${c.id}/notes`, { text: "n" }]]) assert.equal((await s.call(p, { method: m, body: b, token: sup })).status, 403, `soporte ${m} ${p}`);
  assert.equal((await s.call("/api/clients")).status, 401);
  await plans.createPlan(s.db, BASE_PLAN);
  const r = await s.call("/api/subscriptions/provision", { method: "POST", token: adm, body: { plan_id: "mensual", client_id: "no-existe" } });
  assert.equal(r.status, 400); assert.match((await r.json()).message, /cliente/);
});

test("roles de sistema existentes reciben 'clients' por defecto al sincronizar; los propios no", async (t) => {
  const db = memDb(); await rolesSvc.seedRoles(db);
  // simula una base anterior: rol de sistema y rol propio sin la pantalla 'clients'
  for (const r of await db.collection("roles").find({}).toArray()) { const rp = { ...r.routePermissions }; delete rp.clients; await db.collection("roles").updateOne({ id: r.id }, { $set: { routePermissions: rp } }); }
  await db.collection("roles").insertOne({ id: "x1", name: "ventas", label: "V", isSystem: false, routePermissions: { subscriptions: { view: true, create: false, update: false, delete: false } }, allowedRoutes: ["subscriptions"] });
  await rolesSvc.syncRoutes(db);
  const can = (r, a) => rolesSvc.roleCan(db, r, "clients", a);
  assert.ok(await can("manager", "create") && await can("manager", "update") && !(await can("manager", "delete")));
  assert.ok(await can("support", "view") && !(await can("support", "create")));
  assert.ok(!(await can("ventas", "view")), "rol propio sin permisos hasta que el admin los dé");
});

test("escalada: un rol propio con users/roles marcados NO puede crear usuarios ni editar roles (solo admin)", async (t) => {
  const s = await boot(t); const adm = await s.login("admin@test.com");
  const all = { view: true, create: true, update: true, delete: true };
  const c = await s.call("/api/roles", { method: "POST", token: adm, body: { name: "jefe", label: "Jefe", routePermissions: { users: all, roles: all } } });
  assert.equal(c.status, 201);
  await auth.createUser(s.db, { email: "jefe@test.com", password: PW, role: "jefe" });
  const jefe = await s.login("jefe@test.com");
  assert.equal((await s.call("/api/users", { method: "POST", token: jefe, body: { email: "nuevo@test.com", role: "admin" } })).status, 403);
  assert.equal((await s.call("/api/roles", { method: "POST", token: jefe, body: { name: "otro", label: "O" } })).status, 403);
  assert.equal((await s.call("/api/roles/x", { method: "PATCH", token: jefe, body: { label: "Z" } })).status, 403);
  assert.equal((await s.call("/api/roles/x", { method: "DELETE", token: jefe })).status, 403);
  assert.equal((await s.call("/api/roles/sync-routes", { method: "POST", token: jefe })).status, 403);
  assert.equal(await s.db.collection("users").findOne({ email: "nuevo@test.com" }), null);
  assert.equal((await s.call("/api/users", { method: "POST", token: adm, body: { email: "nuevo@test.com", role: "support" } })).status, 201, "el admin sí puede");
});
