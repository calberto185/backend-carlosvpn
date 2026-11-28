const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { memDb } = require("./helpers/memdb");
const auth = require("../src/auth/service");
const plans = require("../src/admin/plans");
const ops = require("../src/admin/ops");
const { hashPassword, verifyPassword } = require("../src/lib/password");
const rolesSvc = require("../src/auth/roles");

const CFG = { brandName: "Carlos VPN", brandNameRu: "КарлосВПН", supportUrl: "", publicBaseUrl: "https://vpn.carlosvm.me", defaultLocale: "es", sessionTtlHours: 12, rateLimitPerMin: 100, upstreamTimeoutMs: 500, subUpdateIntervalHours: 6 };
const PW = "una-clave-larga-123";

async function boot(t) {
  const db = memDb();
  await rolesSvc.seedRoles(db);
  await auth.createUser(db, { email: "Admin@Test.com", password: PW, role: "admin" });
  await auth.createUser(db, { email: "gerente@test.com", password: PW, role: "manager" });
  await auth.createUser(db, { email: "soporte@test.com", password: PW, role: "support" });
  await auth.createUser(db, { email: "cliente@test.com", password: PW, role: "client" });
  await ops.addPanel(db, { id: "rw1", sub_url: "https://sub.test" });
  const app = createApp({ repo: {}, providers: {}, cfg: CFG, db });
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = "GET", body, token, headers = {} } = {}) => fetch(base + path, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const login = async (email, extra = {}) => (await (await call("/api/auth/login", { method: "POST", body: { email, password: PW, mode: "token", ...extra } })).json()).token;
  const close = () => { server.closeAllConnections(); server.close(); };
  if (t) t.after(close); // se cierra siempre, aunque la prueba falle
  return { db, base, call, login, close };
}

test("contraseñas: scrypt, verificación y formato", async () => {
  const h = await hashPassword("secreto-largo-1");
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("secreto-largo-1", h), true);
  assert.equal(await verifyPassword("otra-cosa-larga", h), false);
  assert.equal(await verifyPassword("x", "basura"), false);
});

test("usuarios: validaciones, correo normalizado, duplicados y hash oculto", async () => {
  const db = memDb(); await rolesSvc.seedRoles(db);
  const u = await auth.createUser(db, { email: "  Hola@Mail.COM ", password: PW, role: "support", language: "ru-RU" });
  assert.equal(u.email, "hola@mail.com"); assert.equal(u.language, "ru"); assert.ok(!("password_hash" in u));
  await assert.rejects(auth.createUser(db, { email: "hola@mail.com", password: PW }), /Ya existe/);
  await assert.rejects(auth.createUser(db, { email: "mal", password: PW }), /correo/);
  await assert.rejects(auth.createUser(db, { email: "a@b.co", password: "corta" }), /al menos/);
  await assert.rejects(auth.createUser(db, { email: "a@b.co", password: PW, role: "root" }), /no existe/);
  await assert.rejects(auth.createUser(db, { email: "a@b.co", password: PW, language: "fr" }), /language/);
});

test("permisos: matriz por rol y pantalla (roles de sistema sembrados)", async () => {
  const db = memDb(); await rolesSvc.seedRoles(db);
  const can = (r, k, a) => rolesSvc.roleCan(db, r, k, a);
  for (const k of ["users", "clients", "roles", "settings/plans", "remnawave"]) for (const a of ["view", "create", "update", "delete"]) assert.ok(await can("admin", k, a), `admin ${k}:${a}`);
  assert.ok(await can("manager", "clients", "create") && await can("manager", "subscriptions", "update") && await can("manager", "activity", "view"));
  for (const [k, a] of [["users", "view"], ["users", "create"], ["clients", "delete"], ["subscriptions", "create"], ["settings/plans", "update"], ["roles", "view"], ["settings/servers", "view"]]) assert.ok(!(await can("manager", k, a)), `manager no ${k}:${a}`);
  for (const k of ["clients", "subscriptions", "settings/plans", "dashboard"]) assert.ok(await can("support", k, "view"), `support ve ${k}`);
  for (const [k, a] of [["users", "view"], ["clients", "create"], ["subscriptions", "update"], ["activity", "view"], ["roles", "view"], ["settings/servers", "view"]]) assert.ok(!(await can("support", k, a)), `support no ${k}:${a}`);
  for (const r of ["client", "inventado", undefined, ""]) assert.ok(!(await can(r, "users", "view")), `rol ${r}`);
  assert.ok(!(await can("support", "pantalla-inexistente", "view")));
});

test("login con cookie: HttpOnly, SameSite, sin token en el cuerpo; /api/me; logout revoca", async (t) => {
  const s = await boot(t);
  const r = await s.call("/api/auth/login", { method: "POST", body: { email: "admin@test.com", password: PW } });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Secure/); assert.match(cookie, /Path=\/api/);
  const body = await r.json();
  assert.equal(body.user.role, "admin"); assert.ok(!("token" in body)); assert.ok(!("password_hash" in body.user));
  const c = cookie.split(";")[0];
  const me = await s.call("/api/me", { headers: { cookie: c } });
  assert.equal(me.status, 200); assert.equal((await me.json()).user.email, "admin@test.com");
  const out = await s.call("/api/auth/logout", { method: "POST", headers: { cookie: c, "x-requested-with": "carlosvpn" } });
  assert.equal(out.status, 200);
  assert.equal((await s.call("/api/me", { headers: { cookie: c } })).status, 401);
  s.close();
});

test("login con token (bots): Bearer funciona y se puede revocar", async (t) => {
  const s = await boot(t);
  const token = await s.login("soporte@test.com");
  assert.ok(token && token.length > 30);
  assert.equal((await s.call("/api/me", { token })).status, 200);
  await s.call("/api/auth/logout", { method: "POST", token });
  assert.equal((await s.call("/api/me", { token })).status, 401);
  s.close();
});

test("credenciales malas: misma respuesta para usuario inexistente y clave errónea, y se registra", async (t) => {
  const s = await boot(t);
  const a = await s.call("/api/auth/login", { method: "POST", body: { email: "admin@test.com", password: "incorrecta-123" } });
  const b = await s.call("/api/auth/login", { method: "POST", body: { email: "nadie@test.com", password: "incorrecta-123" } });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), await b.json());
  assert.equal((await s.call("/api/auth/login", { method: "POST", body: { email: 5, password: {} } })).status, 401);
  assert.equal(s.db._data.audit_log.filter((e) => e.action === "login_failed").length, 3);
  s.close();
});

test("límite de intentos de login: el 11.º en un minuto da 429", async (t) => {
  const s = await boot(t);
  let last;
  for (let i = 0; i < 11; i++) last = await s.call("/api/auth/login", { method: "POST", body: { email: "admin@test.com", password: "incorrecta-123" } });
  assert.equal(last.status, 429);
  s.close();
});

test("mensajes de error en el idioma pedido", async (t) => {
  const s = await boot(t);
  const r = await s.call("/api/auth/login", { method: "POST", body: { email: "x@y.co", password: "incorrecta-123" }, headers: { "accept-language": "ru-RU,ru;q=0.9" } });
  assert.match((await r.json()).message, /Неверный/);
  const un = await s.call("/api/plans", { headers: { "accept-language": "ar" } });
  assert.equal(un.status, 401); assert.match((await un.json()).message, /تسجيل الدخول/);
  s.close();
});

test("CSRF: con cookie, las acciones que modifican exigen X-Requested-With", async (t) => {
  const s = await boot(t);
  const r = await s.call("/api/auth/login", { method: "POST", body: { email: "admin@test.com", password: PW } });
  const c = r.headers.get("set-cookie").split(";")[0];
  const sin = await s.call("/api/plans", { method: "POST", body: { id: "x1" }, headers: { cookie: c } });
  assert.equal(sin.status, 403); assert.equal((await sin.json()).error, "csrf");
  const con = await s.call("/api/plans", { method: "POST", body: { id: "x1" }, headers: { cookie: c, "x-requested-with": "carlosvpn" } });
  assert.equal(con.status, 400); // pasa CSRF y falla la validación del plan
  s.close();
});

test("sin sesión 401; cliente 403 en todo lo de gestión; JSON roto 400", async (t) => {
  const s = await boot(t);
  for (const p of ["/api/plans", "/api/subscriptions", "/api/panels", "/api/users", "/api/audit"]) {
    assert.equal((await s.call(p)).status, 401, p);
    assert.equal((await s.call(p, { token: await s.login("cliente@test.com") })).status, 403, p);
  }
  const bad = await fetch(s.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{no-json" });
  assert.equal(bad.status, 400);
  s.close();
});

test("support solo consulta; manager opera; ninguno administra", async () => {
  const s = await boot();
  const { doc } = await ops.addSubscription(s.db, { panel_id: "rw1", short_uuid: "abc12345", days: 10 }, { publicBaseUrl: CFG.publicBaseUrl });
  const sup = await s.login("soporte@test.com"), mgr = await s.login("gerente@test.com");
  const list = await (await s.call("/api/subscriptions", { token: sup })).json();
  assert.equal(list.subscriptions.length, 1);
  const raw = JSON.stringify(list);
  assert.ok(!raw.includes(doc.sub_token) && !raw.includes("abc12345") && !raw.includes("/s/"), "la lista no debe filtrar token, short_uuid ni enlace");
  const detalle = await (await s.call(`/api/subscriptions/${doc.id}`, { token: sup })).json();
  assert.equal(detalle.subscription.url, `https://vpn.carlosvm.me/s/${doc.sub_token}`);
  assert.ok(s.db._data.audit_log.some((e) => e.action === "subscription_view_link" && e.actor_role === "support"));
  assert.equal((await s.call("/api/plans", { token: sup })).status, 200);
  // support: nada que modifique
  for (const [m, p, b] of [["POST", `/api/subscriptions/${doc.id}/suspend`], ["POST", `/api/subscriptions/${doc.id}/resume`], ["POST", `/api/subscriptions/${doc.id}/extend`, { days: 5 }], ["POST", "/api/subscriptions", { panel_id: "rw1", short_uuid: "zzzz1234" }], ["POST", "/api/plans", {}], ["POST", "/api/users", {}]]) {
    assert.equal((await s.call(p, { method: m, body: b, token: sup })).status, 403, `support ${m} ${p}`);
  }
  for (const p of ["/api/panels", "/api/audit", "/api/roles"]) assert.equal((await s.call(p, { token: sup })).status, 403, `support ${p}`);
  // manager: opera sobre suscripciones y clientes
  assert.equal((await (await s.call(`/api/subscriptions/${doc.id}/suspend`, { method: "POST", token: mgr })).json()).subscription.status, "suspended");
  assert.equal((await (await s.call(`/api/subscriptions/${doc.id}/resume`, { method: "POST", token: mgr })).json()).subscription.status, "active");
  const ext = await (await s.call(`/api/subscriptions/${doc.id}/extend`, { method: "POST", body: { days: 30 }, token: mgr })).json();
  const dias = (new Date(ext.subscription.expires_at) - Date.now()) / 864e5; assert.ok(dias > 39.9 && dias <= 40);
  assert.equal((await s.call("/api/audit", { token: mgr })).status, 200);
  // El gerente NO administra usuarios del panel: ni siquiera uno de rol inferior, y menos un admin (escalada).
  for (const role of ["support", "admin"]) assert.equal((await s.call("/api/users", { method: "POST", body: { email: "x@test.com", role }, token: mgr })).status, 403, `gerente no crea ${role}`);
  assert.equal((await s.db.collection("users").findOne({ email: "x@test.com" })), null);
  assert.equal((await s.call("/api/users", { token: mgr })).status, 403);
  for (const [m, p, b] of [["POST", "/api/subscriptions", { panel_id: "rw1", short_uuid: "zzzz1234" }], ["POST", "/api/plans", {}], ["PATCH", "/api/plans/x", {}]]) {
    assert.equal((await s.call(p, { method: m, body: b, token: mgr })).status, 403, `manager ${m} ${p}`);
  }
  for (const p of ["/api/panels", "/api/roles"]) assert.equal((await s.call(p, { token: mgr })).status, 403, `manager ${p}`);
  s.close();
});

test("roles: crear, editar con efecto inmediato, proteger sistema y eliminar solo si no están en uso", async () => {
  const s = await boot();
  const adm = await s.login("admin@test.com");
  const list = (await (await s.call("/api/roles", { token: adm })).json()).roles;
  assert.deepEqual(list.map((r) => r.name), ["admin", "manager", "support"]);
  assert.ok(list.every((r) => r.isSystem) && list.every((r) => r.allowedRoutes && !("_id" in r)));
  const c = await s.call("/api/roles", { method: "POST", token: adm, body: { name: "Ventas Peru", label: "Ventas", color: "success", routePermissions: { users: { view: true }, subscriptions: { view: true, update: true } } } });
  assert.equal(c.status, 201); const rol = (await c.json()).role;
  assert.equal(rol.name, "ventas_peru"); assert.equal(rol.isSystem, false); assert.deepEqual(rol.allowedRoutes, ["users", "subscriptions"]);
  assert.equal(rol.routePermissions.roles.view, false); // pantallas no indicadas quedan sin permisos
  for (const malo of [{ name: "admin", label: "x" }, { name: "client", label: "x" }, { name: "ventas_peru", label: "x" }, { name: "n1", label: "" }, { name: "n2", label: "x", color: "rosa" }, { name: "n3", label: "x", routePermissions: { inventada: { view: true } } }, { name: "!!!", label: "x" }]) {
    assert.equal((await s.call("/api/roles", { method: "POST", token: adm, body: malo })).status, 400, JSON.stringify(malo));
  }
  await auth.createUser(s.db, { email: "vendedor@test.com", password: PW, role: "ventas_peru" });
  const vend = await s.login("vendedor@test.com");
  assert.equal((await s.call("/api/subscriptions", { token: vend })).status, 200);
  assert.equal((await s.call("/api/plans", { token: vend })).status, 403);
  // editar el rol: el cambio se aplica ya, sin esperar a que caduque la caché
  const up = await s.call(`/api/roles/${rol.id}`, { method: "PATCH", token: adm, body: { routePermissions: { "settings/plans": { view: true }, subscriptions: { view: false } } } });
  assert.equal(up.status, 200);
  assert.equal((await s.call("/api/plans", { token: vend })).status, 200);
  assert.equal((await s.call("/api/subscriptions", { token: vend })).status, 403);
  // protecciones
  const adminRole = list.find((r) => r.name === "admin"), supportRole = list.find((r) => r.name === "support");
  assert.equal((await s.call(`/api/roles/${adminRole.id}`, { method: "PATCH", token: adm, body: { routePermissions: { users: {} } } })).status, 400);
  await s.db.collection("users").deleteMany({ role: "support" }); // sin usuarios: así solo puede frenarlo ser rol de sistema
  const delSys = await s.call(`/api/roles/${supportRole.id}`, { method: "DELETE", token: adm });
  assert.equal(delSys.status, 400); assert.match((await delSys.json()).message, /sistema/);
  assert.ok(await rolesSvc.getRole(s.db, "support"));
  assert.equal((await s.call(`/api/roles/${rol.id}`, { method: "DELETE", token: adm })).status, 400); // hay un usuario con este rol
  await s.db.collection("users").updateOne({ email: "vendedor@test.com" }, { $set: { role: "manager" } });
  assert.equal((await s.call(`/api/roles/${rol.id}`, { method: "DELETE", token: adm })).status, 200);
  assert.equal((await s.call("/api/roles/ventas_peru", { token: adm })).status, 404);
  // lectura de un rol: cualquier usuario con sesión; gestión: solo con permiso
  assert.equal((await s.call("/api/roles/support", { token: adm })).status, 200);
  const mgr = await s.login("gerente@test.com");
  assert.equal((await s.call("/api/roles/support", { token: mgr })).status, 200); // lectura de un rol: cualquier sesión
  assert.equal((await s.call("/api/roles", { method: "POST", token: mgr, body: { name: "zz", label: "zz" } })).status, 403);
  s.close();
});

test("roles: el arranque no pisa lo editado y sync-routes añade pantallas nuevas sin permisos", async () => {
  const db = memDb(); await rolesSvc.seedRoles(db);
  const sup = await rolesSvc.getRole(db, "support");
  await rolesSvc.updateRole(db, sup.id, { routePermissions: { users: { view: true, update: true } } });
  await rolesSvc.seedRoles(db); // "reinicio": no debe volver a los valores por defecto
  assert.equal((await rolesSvc.getRole(db, "support")).routePermissions.users.update, true);
  // una pantalla nueva en el catálogo: simulamos un rol antiguo al que le falta una clave
  const col = db.collection("roles"); const r = await col.findOne({ name: "manager" });
  const rp = { ...r.routePermissions }; delete rp.roles; await col.updateOne({ id: r.id }, { $set: { routePermissions: rp } });
  assert.equal(await rolesSvc.syncRoutes(db), 1);
  assert.deepEqual((await rolesSvc.getRole(db, "manager")).routePermissions.roles, { view: false, create: false, update: false, delete: false });
  assert.equal(await rolesSvc.syncRoutes(db), 0);
});

test("extender: desde el vencimiento si está vigente, desde hoy si ya venció", async () => {
  const db = memDb(); await ops.addPanel(db, { id: "rw1", sub_url: "https://sub.test" });
  const { doc } = await ops.addSubscription(db, { panel_id: "rw1", short_uuid: "abc12345", days: 5 }, { publicBaseUrl: "https://x" });
  const vig = await ops.extendSubscription(db, doc.id, 10);
  assert.ok(Math.abs((new Date(vig.expires_at) - Date.now()) / 864e5 - 15) < 0.01);
  await db.collection("subscriptions").updateOne({ id: doc.id }, { $set: { expires_at: new Date(Date.now() - 20 * 864e5).toISOString() } });
  const ven = await ops.extendSubscription(db, doc.id, 10);
  assert.ok(Math.abs((new Date(ven.expires_at) - Date.now()) / 864e5 - 10) < 0.01);
  await assert.rejects(ops.extendSubscription(db, doc.id, 0), /days/);
  await assert.rejects(ops.extendSubscription(db, "nope", 5), /No existe/);
});

test("admin: planes (crear, validar, editar), suscripción con plan, usuarios y bitácora", async (t) => {
  const s = await boot(t);
  const tk = await s.login("admin@test.com");
  const plan = { id: "mensual", names: { es: "Mensual", en: "Monthly" }, price: { amount: 5, currency: "usd" }, duration_days: 30, traffic: { mode: "quota", gb: 100 }, hwid_limit: 3, panel_ids: ["rw1"], active: true };
  const c = await s.call("/api/plans", { method: "POST", body: plan, token: tk });
  assert.equal(c.status, 201);
  assert.equal((await c.json()).plan.price.currency, "USD");
  assert.equal((await s.call("/api/plans", { method: "POST", body: plan, token: tk })).status, 400); // duplicado
  for (const malo of [{ ...plan, id: "b1", traffic: { mode: "quota" } }, { ...plan, id: "b2", hwid_limit: 0 }, { ...plan, id: "b3", panel_ids: ["no-existe"] }, { ...plan, id: "b4", names: { fr: "x" } }, { ...plan, id: "b5", price: { amount: -1, currency: "USD" } }, { ...plan, id: "B 6" }]) {
    assert.equal((await s.call("/api/plans", { method: "POST", body: malo, token: tk })).status, 400, JSON.stringify(malo.id));
  }
  const up = await s.call("/api/plans/mensual", { method: "PATCH", body: { price: { amount: 7.5, currency: "EUR" }, active: false }, token: tk });
  const p2 = (await up.json()).plan; assert.equal(p2.price.amount, 7.5); assert.equal(p2.active, false); assert.equal(p2.duration_days, 30);
  assert.equal((await s.call("/api/plans/mensual", { method: "PATCH", body: { id: "otro" }, token: tk })).status, 400);
  assert.equal((await s.call("/api/plans/nope", { method: "PATCH", body: { active: true }, token: tk })).status, 400);
  const sub = await s.call("/api/subscriptions", { method: "POST", body: { panel_id: "rw1", short_uuid: "abc12345", days: 30, plan_id: "mensual", language: "es" }, token: tk });
  assert.equal(sub.status, 201); assert.equal((await sub.json()).subscription.plan_id, "mensual");
  assert.equal((await s.call("/api/subscriptions", { method: "POST", body: { panel_id: "rw1", short_uuid: "abc12345", plan_id: "no" }, token: tk })).status, 400);
  const nu = await s.call("/api/users", { method: "POST", body: { email: "nuevo@test.com", role: "support", language: "bn" }, token: tk });
  assert.equal(nu.status, 201); const nb = await nu.json();
  assert.ok(nb.temporary_password.length >= 20); assert.ok(!("password_hash" in nb.user));
  assert.ok(await s.login("nuevo@test.com", { password: nb.temporary_password }), "la contraseña temporal permite entrar");
  assert.ok(!JSON.stringify(await (await s.call("/api/users", { token: tk })).json()).includes("password_hash"));
  const au = (await (await s.call("/api/audit", { token: tk })).json()).entries;
  for (const a of ["login", "plan_create", "plan_update", "subscription_create", "user_create"]) assert.ok(au.some((e) => e.action === a), a);
  assert.ok(!JSON.stringify(au).includes("temporary_password"));
  s.close();
});

test("planes de ejemplo: 3, inactivos, precio 0 y sin duplicar al repetir", async () => {
  const db = memDb();
  const c = await plans.seedExamplePlans(db);
  assert.deepEqual(c.map((p) => p.id), ["mensual", "trimestral", "anual"]);
  assert.ok(c.every((p) => p.active === false && p.price.amount === 0 && p.traffic.mode === "unlimited" && p.hwid_limit === 3));
  assert.deepEqual(c.map((p) => p.duration_days), [30, 90, 365]);
  assert.equal((await plans.seedExamplePlans(db)).length, 0);
  assert.equal((await plans.listPlans(db, { activeOnly: true })).length, 0);
});

test("sesión caducada o usuario suspendido no entran; cambiar contraseña cierra sesiones", async (t) => {
  const s = await boot(t);
  const tk = await s.login("soporte@test.com");
  assert.equal((await s.call("/api/me", { token: tk })).status, 200);
  for (const x of s.db._data.sessions) x.expires_at = new Date(Date.now() - 1000);
  assert.equal((await s.call("/api/me", { token: tk })).status, 401);
  const tk2 = await s.login("soporte@test.com");
  await auth.setPassword(s.db, "soporte@test.com", "otra-clave-larga-9");
  assert.equal((await s.call("/api/me", { token: tk2 })).status, 401);
  assert.equal(await s.login("soporte@test.com"), undefined); // la clave anterior ya no sirve
  await s.db.collection("users").updateOne({ email: "soporte@test.com" }, { $set: { status: "disabled" } });
  const r = await s.call("/api/auth/login", { method: "POST", body: { email: "soporte@test.com", password: "otra-clave-larga-9", mode: "token" } });
  assert.equal(r.status, 401);
  s.close();
});

test("idioma del usuario: se guarda, se valida y gobierna los mensajes", async (t) => {
  const s = await boot(t);
  const tk = await s.login("admin@test.com");
  assert.equal((await s.call("/api/me", { method: "PATCH", body: { language: "fr" }, token: tk })).status, 400);
  const r = await s.call("/api/me", { method: "PATCH", body: { language: "hi-IN" }, token: tk });
  assert.equal((await r.json()).user.language, "hi");
  const sin = await s.call("/api/users", { token: await s.login("cliente@test.com") }); // cliente sin idioma guardado
  assert.equal(sin.status, 403);
  const es = await s.call("/api/subscriptions", { token: tk, headers: { "accept-language": "en" } });
  assert.equal(es.status, 200);
  s.close();
});
