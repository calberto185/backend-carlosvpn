const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp } = require("../src/app");
const { memDb } = require("./helpers/memdb");
const auth = require("../src/auth/service");
const plans = require("../src/admin/plans");
const ops = require("../src/admin/ops");
const remna = require("../src/admin/remna");
const rolesSvc = require("../src/auth/roles");
const { createRwClient } = require("../src/providers/remnawaveClient");

const KEY = "ab".repeat(32);
const TOKEN = "tok-secreto-de-prueba-123456";
const PW = "una-clave-larga-123";
const CFG = { brandName: "Carlos VPN", brandNameRu: "КарлосВПН", supportUrl: "", publicBaseUrl: "https://vpn.carlosvm.me", defaultLocale: "es", sessionTtlHours: 12, rateLimitPerMin: 100, upstreamTimeoutMs: 500, subUpdateIntervalHours: 6, encryptionKey: KEY };

// Panel Remnawave falso (contrato 3.x: id numérico, envoltorio { response }).
async function stubPanel(t, { failCreate = false, token = TOKEN } = {}) {
  const users = new Map(); const log = []; let nextId = 1;
  const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      log.push({ method: req.method, url: req.url, body, auth: req.headers.authorization, apiKey: req.headers["x-api-key"] });
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { message: "Unauthorized" });
      const u = new URL(req.url, "http://x"); const p = u.pathname; let m;
      if (req.method === "GET" && p === "/api/system/health") return send(res, 200, { response: { pm2Stats: [] } });
      if (req.method === "GET" && p === "/api/system/stats") return send(res, 200, { response: { users: { totalUsers: users.size } } });
      if (req.method === "GET" && p === "/api/nodes") return send(res, 200, { response: [{ uuid: "n1", name: "ru-1", isConnected: true }] });
      if (req.method === "GET" && p === "/api/hosts") return send(res, 200, { response: [{ uuid: "h1", remark: "host" }] });
      if (req.method === "GET" && p === "/api/internal-squads") return send(res, 200, { response: { total: 1, internalSquads: [{ uuid: "s1" }] } });
      if (req.method === "POST" && (m = p.match(/^\/api\/nodes\/([^/]+)\/actions\/(enable|disable|restart)$/))) return send(res, 200, { response: { uuid: m[1] } });
      if (req.method === "POST" && p === "/api/users") {
        if (failCreate) return send(res, 500, { message: "boom" });
        const user = { id: nextId++, shortUuid: `short${nextId}abcdefgh`, status: "ACTIVE", ...body };
        users.set(user.username, user); return send(res, 201, { response: user });
      }
      if (req.method === "GET" && (m = p.match(/^\/api\/users\/by-username\/(.+)$/))) { const x = users.get(decodeURIComponent(m[1])); return x ? send(res, 200, { response: x }) : send(res, 404, { message: "User not found" }); }
      if (req.method === "GET" && (m = p.match(/^\/api\/users\/by-short-uuid\/(.+)$/))) { const x = [...users.values()].find((q) => q.shortUuid === m[1]); return x ? send(res, 200, { response: x }) : send(res, 404, { message: "User not found" }); }
      if (req.method === "POST" && (m = p.match(/^\/api\/users\/(\d+)\/actions\/(enable|disable|reset-traffic|revoke|extend)$/))) {
        const x = [...users.values()].find((q) => q.id === Number(m[1])); if (!x) return send(res, 404, { message: "nope" });
        if (m[2] === "disable") x.status = "DISABLED"; if (m[2] === "enable") x.status = "ACTIVE";
        if (m[2] === "revoke") x.shortUuid = "nuevoShort" + x.id + "xxxxxxxx";
        return send(res, 200, { response: x });
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/users\/(\d+)$/))) { for (const [k, v] of users) if (v.id === Number(m[1])) users.delete(k); return send(res, 200, { response: { isDeleted: true } }); }
      if (req.method === "GET" && (m = p.match(/^\/api\/hwid\/devices\/(\d+)$/))) return send(res, 200, { response: { total: 1, devices: [{ hwid: "HW-1", userId: Number(m[1]), platform: "android", osVersion: "14", deviceModel: "Pixel", createdAt: "2026-01-01T00:00:00.000Z" }] } });
      if (req.method === "POST" && p === "/api/hwid/devices/delete") return send(res, 200, { response: { total: 0, devices: [] } });
      send(res, 404, { message: "no route " + p });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, users, log };
}

async function boot(t, { stubs = {} } = {}) {
  const db = memDb(); await rolesSvc.seedRoles(db);
  for (const [email, role] of [["admin@test.com", "admin"], ["gerente@test.com", "manager"], ["soporte@test.com", "support"]]) await auth.createUser(db, { email, password: PW, role });
  const app = createApp({ repo: {}, providers: {}, cfg: CFG, db });
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = "GET", body, token } = {}) => fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const login = async (email) => (await (await call("/api/auth/login", { method: "POST", body: { email, password: PW, mode: "token" } })).json()).token;
  return { db, call, login };
}

async function addPanel(db, id, stub, extra = {}) {
  await ops.addPanel(db, { id, sub_url: "https://sub.test" });
  await remna.setPanelCredentials(db, CFG, id, { api_url: stub.url, api_token: TOKEN, ...extra });
}

test("cliente: envoltorio response, Bearer, x-api-key, 401 sin filtrar el token, panel caído", async (t) => {
  const stub = await stubPanel(t);
  const rw = createRwClient({ baseUrl: stub.url + "/", token: TOKEN, caddyKey: "caddy-123" });
  assert.deepEqual(await rw.nodes(), [{ uuid: "n1", name: "ru-1", isConnected: true }]);
  assert.equal(stub.log[0].auth, `Bearer ${TOKEN}`); assert.equal(stub.log[0].apiKey, "caddy-123");
  const bad = createRwClient({ baseUrl: stub.url, token: "otro-token-incorrecto-1" });
  await assert.rejects(bad.nodes(), (e) => e.code === "RW_AUTH" && e.status === 401 && !e.message.includes("otro-token"));
  await assert.rejects(rw.getByUsername("nadie"), (e) => e.code === "RW_NOT_FOUND");
  const down = createRwClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, timeoutMs: 500 });
  await assert.rejects(down.nodes(), (e) => e.code === "RW_UNREACHABLE");
  assert.throws(() => createRwClient({ baseUrl: "nada", token: TOKEN }), /api_url/);
  assert.throws(() => createRwClient({ baseUrl: stub.url, token: "" }), /token/);
});

test("credenciales: token cifrado en reposo, nunca expuesto por la API, validaciones", async (t) => {
  const stub = await stubPanel(t); const s = await boot(t);
  await addPanel(s.db, "rw1", stub, { squad_uuids: ["11111111-1111-4111-8111-111111111111"] });
  const raw = await s.db.collection("panels").findOne({ id: "rw1" });
  assert.match(raw.api_token, /^v1:/); assert.ok(!raw.api_token.includes(TOKEN));
  await assert.rejects(remna.setPanelCredentials(s.db, CFG, "rw1", { api_token: "corto" }), /corto/);
  await assert.rejects(remna.setPanelCredentials(s.db, CFG, "rw1", { api_url: "ftp://x" }), /api_url/);
  await assert.rejects(remna.setPanelCredentials(s.db, CFG, "rw1", { squad_uuids: ["nope"] }), /UUID/);
  await assert.rejects(remna.setPanelCredentials(s.db, CFG, "no-existe", { api_token: TOKEN }), /No existe/);
  const adm = await s.login("admin@test.com");
  const body = await (await s.call("/api/panels", { token: adm })).json();
  assert.equal(body.panels[0].has_token, true);
  assert.ok(!JSON.stringify(body).includes("api_token") && !JSON.stringify(body).includes("v1:") && !JSON.stringify(body).includes(TOKEN));
});

test("panel:check: solo lectura, informa cada comprobación y marca el panel", async (t) => {
  const stub = await stubPanel(t); const s = await boot(t);
  await addPanel(s.db, "rw1", stub);
  const r = await remna.checkPanel(s.db, CFG, "rw1");
  assert.equal(r.ok, true); assert.equal(r.checks.nodes.value, 1); assert.equal(r.checks.squads.value, 1);
  assert.ok(stub.log.every((l) => l.method === "GET"), "solo GET");
  assert.equal((await s.db.collection("panels").findOne({ id: "rw1" })).api_ok, true);
  const bad = await stubPanel(t, { token: "otro-token-distinto-99999" });
  await addPanel(s.db, "rw2", bad);
  const r2 = await remna.checkPanel(s.db, CFG, "rw2");
  assert.equal(r2.ok, false); assert.equal(r2.checks.health.status, 401);
  assert.equal((await s.db.collection("panels").findOne({ id: "rw2" })).api_ok, false);
});

test("aprovisionar desde plan: cuerpo correcto en el panel y suscripción con la cuenta", async (t) => {
  const stub = await stubPanel(t); const s = await boot(t);
  const sq = "22222222-2222-4222-8222-222222222222";
  await addPanel(s.db, "rw1", stub, { squad_uuids: [sq] });
  await plans.createPlan(s.db, { id: "mensual", names: { es: "Mensual" }, price: { amount: 5, currency: "USD" }, duration_days: 30, traffic: { mode: "quota", gb: 100 }, hwid_limit: 3, panel_ids: ["rw1"], active: true });
  const adm = await s.login("admin@test.com");
  const r = await s.call("/api/subscriptions/provision", { method: "POST", token: adm, body: { plan_id: "mensual", label: "Cliente Juan", language: "ru", email: "juan@x.com" } });
  assert.equal(r.status, 201);
  const out = await r.json();
  assert.match(out.subscription.url, /^https:\/\/vpn\.carlosvm\.me\/s\/[A-Za-z0-9_-]{20,}$/);
  const created = stub.log.find((l) => l.method === "POST" && l.url === "/api/users").body;
  assert.match(created.username, /^cv-[0-9a-f]{12}$/);
  assert.equal(created.trafficLimitBytes, 100 * 1024 ** 3); assert.equal(created.hwidDeviceLimit, 3);
  assert.deepEqual(created.activeInternalSquads, [sq]); assert.equal(created.email, "juan@x.com");
  const days = (new Date(created.expireAt) - Date.now()) / 864e5; assert.ok(days > 29.9 && days <= 30);
  const sub = (await s.db.collection("subscriptions").find({}).toArray())[0];
  assert.equal(sub.plan_id, "mensual"); assert.equal(sub.accounts[0].rw_username, created.username); assert.match(sub.accounts[0].short_uuid, /^short/);
  // ilimitado → 0 bytes
  await plans.createPlan(s.db, { id: "ilim", names: { es: "I" }, price: { amount: 1, currency: "USD" }, duration_days: 5, traffic: { mode: "unlimited" }, hwid_limit: 1, panel_ids: ["rw1"] });
  await remna.provisionFromPlan(s.db, CFG, { plan_id: "ilim" }, { publicBaseUrl: CFG.publicBaseUrl });
  assert.equal(stub.log.filter((l) => l.url === "/api/users" && l.method === "POST").pop().body.trafficLimitBytes, 0);
  // permisos y validación
  for (const email of ["gerente@test.com", "soporte@test.com"]) assert.equal((await s.call("/api/subscriptions/provision", { method: "POST", token: await s.login(email), body: { plan_id: "mensual" } })).status, 403);
  assert.equal((await s.call("/api/subscriptions/provision", { method: "POST", token: adm, body: { plan_id: "nada" } })).status, 400);
});

test("aprovisionar: si falla el segundo panel se deshace el primero y no queda suscripción", async (t) => {
  const ok = await stubPanel(t); const bad = await stubPanel(t, { failCreate: true }); const s = await boot(t);
  await addPanel(s.db, "rw1", ok); await addPanel(s.db, "rw2", bad);
  await plans.createPlan(s.db, { id: "dos", names: { es: "Dos" }, price: { amount: 1, currency: "USD" }, duration_days: 30, traffic: { mode: "unlimited" }, hwid_limit: 2, panel_ids: ["rw1", "rw2"] });
  const adm = await s.login("admin@test.com");
  const r = await s.call("/api/subscriptions/provision", { method: "POST", token: adm, body: { plan_id: "dos" } });
  assert.equal(r.status, 502);
  assert.equal(ok.users.size, 0, "el usuario del primer panel se eliminó");
  assert.equal((await s.db.collection("subscriptions").find({}).toArray()).length, 0);
});

test("suspender/reanudar/extender se propagan al panel; si el panel falla, lo local se aplica y se informa", async (t) => {
  const stub = await stubPanel(t); const s = await boot(t);
  await addPanel(s.db, "rw1", stub);
  await plans.createPlan(s.db, { id: "mes", names: { es: "M" }, price: { amount: 1, currency: "USD" }, duration_days: 30, traffic: { mode: "unlimited" }, hwid_limit: 2, panel_ids: ["rw1"] });
  const { doc } = await remna.provisionFromPlan(s.db, CFG, { plan_id: "mes" }, { publicBaseUrl: CFG.publicBaseUrl });
  const mgr = await s.login("gerente@test.com");
  let r = await (await s.call(`/api/subscriptions/${doc.id}/suspend`, { method: "POST", token: mgr })).json();
  assert.equal(r.subscription.status, "suspended"); assert.deepEqual(r.panel_sync, [{ panel_id: "rw1", ok: true }]);
  assert.equal([...stub.users.values()][0].status, "DISABLED");
  await s.call(`/api/subscriptions/${doc.id}/resume`, { method: "POST", token: mgr });
  assert.equal([...stub.users.values()][0].status, "ACTIVE");
  r = await (await s.call(`/api/subscriptions/${doc.id}/extend`, { method: "POST", token: mgr, body: { days: 10 } })).json();
  assert.deepEqual(stub.log.filter((l) => l.url.endsWith("/actions/extend")).pop().body, { days: 10 });
  assert.ok(r.panel_sync[0].ok);
  // panel sin token → se aplica local y se informa
  await s.db.collection("panels").updateOne({ id: "rw1" }, { $set: { api_token: "" } });
  r = await (await s.call(`/api/subscriptions/${doc.id}/suspend`, { method: "POST", token: mgr })).json();
  assert.equal(r.subscription.status, "suspended"); assert.equal(r.panel_sync[0].ok, false); assert.equal(r.panel_sync[0].skipped, true);
  // panel caído → idem
  await remna.setPanelCredentials(s.db, CFG, "rw1", { api_url: "http://127.0.0.1:1", api_token: TOKEN });
  r = await (await s.call(`/api/subscriptions/${doc.id}/resume`, { method: "POST", token: mgr })).json();
  assert.equal(r.subscription.status, "active"); assert.equal(r.panel_sync[0].ok, false);
  const aud = await s.db.collection("audit_log").find({ action: "subscription_resume" }).toArray();
  assert.ok(aud.length === 2 && aud.every((a) => !JSON.stringify(a).includes(TOKEN)));
});

test("revocar actualiza el shortUuid guardado; HWID listar/eliminar; reset de tráfico", async (t) => {
  const stub = await stubPanel(t); const s = await boot(t);
  await addPanel(s.db, "rw1", stub);
  await plans.createPlan(s.db, { id: "mes", names: { es: "M" }, price: { amount: 1, currency: "USD" }, duration_days: 30, traffic: { mode: "unlimited" }, hwid_limit: 2, panel_ids: ["rw1"] });
  const { doc } = await remna.provisionFromPlan(s.db, CFG, { plan_id: "mes" }, { publicBaseUrl: CFG.publicBaseUrl });
  const adm = await s.login("admin@test.com"); const sup = await s.login("soporte@test.com");
  const before = doc.accounts[0].short_uuid;
  let r = await (await s.call(`/api/subscriptions/${doc.id}/revoke`, { method: "POST", token: adm })).json();
  assert.ok(r.panel_sync[0].ok);
  const after = (await s.db.collection("subscriptions").findOne({ id: doc.id })).accounts[0];
  assert.notEqual(after.short_uuid, before); assert.match(after.short_uuid, /^nuevoShort/);
  assert.equal(after.rw_username, doc.accounts[0].rw_username, "conserva el usuario");
  assert.ok((await s.call(`/api/subscriptions/${doc.id}/reset-traffic`, { method: "POST", token: adm })).ok);
  const h = await (await s.call(`/api/subscriptions/${doc.id}/hwid`, { token: sup })).json();
  assert.equal(h.panels[0].devices[0].hwid, "HW-1"); assert.equal(h.panels[0].devices[0].model, "Pixel");
  assert.equal((await s.call(`/api/subscriptions/${doc.id}/hwid/rw1/HW-1`, { method: "DELETE", token: sup })).status, 403, "soporte solo consulta");
  assert.equal((await s.call(`/api/subscriptions/${doc.id}/hwid/rw1/HW-1`, { method: "DELETE", token: adm })).status, 200);
  assert.deepEqual(stub.log.filter((l) => l.url === "/api/hwid/devices/delete").pop().body, { userId: 1, hwid: "HW-1" });
  assert.equal((await s.call(`/api/subscriptions/${doc.id}/hwid/nope/HW-1`, { method: "DELETE", token: adm })).status, 400);
  assert.equal((await s.call(`/api/subscriptions/no-existe/revoke`, { method: "POST", token: adm })).status, 404);
});

test("rutas /api/remna: nodos, hosts, squads, acciones; permisos y errores del panel", async (t) => {
  const stub = await stubPanel(t); const s = await boot(t);
  await addPanel(s.db, "rw1", stub);
  const adm = await s.login("admin@test.com"); const mgr = await s.login("gerente@test.com");
  for (const p of ["nodes", "hosts", "squads", "stats", "check"]) assert.equal((await s.call(`/api/remna/${p}?panel=rw1`, { token: adm })).status, 200, p);
  assert.equal((await s.call("/api/remna/nodes", { token: adm })).status, 400, "falta ?panel");
  assert.equal((await s.call("/api/remna/nodes?panel=zz", { token: adm })).status, 400);
  assert.equal((await s.call("/api/remna/nodes?panel=rw1", { token: mgr })).status, 403, "gerente no ve remnawave");
  assert.equal((await s.call("/api/remna/nodes?panel=rw1")).status, 401);
  assert.equal((await s.call("/api/remna/nodes/n1/restart?panel=rw1", { method: "POST", token: adm })).status, 200);
  assert.equal((await s.call("/api/remna/nodes/n1/borrar?panel=rw1", { method: "POST", token: adm })).status, 400);
  await remna.setPanelCredentials(s.db, CFG, "rw1", { api_token: "token-equivocado-0000000" });
  const r = await s.call("/api/remna/nodes?panel=rw1", { token: adm });
  assert.equal(r.status, 502); const b = await r.json(); assert.equal(b.status, 401); assert.ok(!JSON.stringify(b).includes("token-equivocado"));
});
