const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { createRepo } = require("../src/repo");
const { createRegistry } = require("../src/providers");
const { generateSubToken } = require("../src/lib/token");
const { decodeLinks } = require("../src/aggregator/merge");

const b64 = (s) => Buffer.from(s).toString("base64");
const CFG = { brandName: "Carlos VPN", brandNameRu: "КарлосВПН", supportUrl: "https://t.me/x", upstreamTimeoutMs: 500, subUpdateIntervalHours: 6, rateLimitPerMin: 100 };

function fakeDb(data) {
  return { collection: (n) => ({ findOne: async (f) => (data[n] || []).find((d) => Object.entries(f).every(([k, v]) => d[k] === v)) || null }) };
}
// Panel simulado: responde según la URL base. Guarda las peticiones para inspeccionarlas.
function fakeFetch(routes, calls) {
  return async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const r = routes[url];
    if (!r) throw new Error("sin ruta " + url);
    if (r instanceof Error) throw r;
    return { status: r.status ?? 200, text: async () => r.body, headers: { forEach: (cb) => Object.entries(r.headers || {}).forEach(([k, v]) => cb(v, k)) } };
  };
}
async function start({ routes, sub, cfg = CFG }) {
  const calls = [];
  const token = generateSubToken();
  const data = {
    panels: [{ id: "p1", provider: "remnawave", sub_url: "https://sub1.test" }, { id: "p2", provider: "remnawave", sub_url: "https://sub2.test" }, { id: "p3", provider: "pasarguard", sub_url: "https://sub3.test" }],
    subscriptions: [{ sub_token: token, status: "active", expires_at: new Date(Date.now() + 864e5).toISOString(), accounts: [{ panel_id: "p1", short_uuid: "u1", status: "active" }], ...sub }],
  };
  const app = createApp({ repo: createRepo(fakeDb(data)), providers: createRegistry({ fetchImpl: fakeFetch(routes, calls) }), cfg });
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, token, calls, close: () => server.close() };
}

test("404 para token inválido o desconocido; no filtra nada", async () => {
  const s = await start({ routes: {} });
  assert.equal((await fetch(`${s.base}/s/corto`)).status, 404);
  assert.equal((await fetch(`${s.base}/s/${"A".repeat(32)}`)).status, 404);
  s.close();
});

test("200 con un panel: enlaces, cabeceras de marca y consumo", async () => {
  const s = await start({ routes: { "https://sub1.test/u1": { body: b64("vless://a#1\nhy2://b#2"), headers: { "subscription-userinfo": "upload=10; download=20; total=0; expire=0" } } } });
  const r = await fetch(`${s.base}/s/${s.token}`, { headers: { "user-agent": "Happ/2.0", "x-hwid": "abc123", "x-device-os": "Android" } });
  assert.equal(r.status, 200);
  assert.deepEqual(decodeLinks(await r.text()), ["vless://a#1", "hy2://b#2"]);
  assert.equal(r.headers.get("subscription-userinfo").split(";")[0], "upload=10");
  assert.match(r.headers.get("subscription-userinfo"), /total=0/);
  assert.equal(Buffer.from(r.headers.get("profile-title").replace("base64:", ""), "base64").toString(), "Carlos VPN | КарлосВПН");
  assert.equal(r.headers.get("profile-update-interval"), "6");
  assert.equal(r.headers.get("x-sub-nodes"), "2");
  // anuncio localizado (por defecto es), soporte y aviso de vencimiento
  assert.match(Buffer.from(r.headers.get("announce").replace("base64:", ""), "base64").toString(), /Carlos VPN/);
  assert.equal(r.headers.get("support-url"), "https://t.me/x");
  assert.equal(r.headers.get("sub-expire"), "true");
  assert.equal(r.headers.get("sub-expire-button-link"), "https://t.me/x");
  // el HWID y el UA llegan al panel
  assert.equal(s.calls[0].headers["x-hwid"], "abc123");
  assert.equal(s.calls[0].headers["x-device-os"], "Android");
  assert.equal(s.calls[0].headers["user-agent"], "Happ/2.0");
  s.close();
});

test("fusiona dos paneles y suma el consumo", async () => {
  const s = await start({
    sub: { accounts: [{ panel_id: "p1", short_uuid: "u1", status: "active" }, { panel_id: "p2", short_uuid: "u2", status: "active" }] },
    routes: {
      "https://sub1.test/u1": { body: b64("vless://a#1"), headers: { "subscription-userinfo": "upload=1; download=2; total=100; expire=0" } },
      "https://sub2.test/u2": { body: b64("vless://b#2"), headers: { "subscription-userinfo": "upload=3; download=4; total=200; expire=0" } },
    },
  });
  const r = await fetch(`${s.base}/s/${s.token}`);
  assert.deepEqual(decodeLinks(await r.text()), ["vless://a#1", "vless://b#2"]);
  assert.match(r.headers.get("subscription-userinfo"), /upload=4; download=6; total=300/);
  assert.equal(r.headers.get("x-sub-partial"), null);
  s.close();
});

test("si un panel cae devuelve lo que hay y lo marca como parcial", async () => {
  const s = await start({
    sub: { accounts: [{ panel_id: "p1", short_uuid: "u1", status: "active" }, { panel_id: "p2", short_uuid: "u2", status: "active" }] },
    routes: { "https://sub1.test/u1": { body: b64("vless://a#1") }, "https://sub2.test/u2": new Error("timeout") },
  });
  const r = await fetch(`${s.base}/s/${s.token}`);
  assert.equal(r.status, 200); assert.equal(r.headers.get("x-sub-partial"), "1/2");
  assert.deepEqual(decodeLinks(await r.text()), ["vless://a#1"]);
  s.close();
});

test("502 si ningún panel responde (y también con un proveedor sin implementar)", async () => {
  const s = await start({ sub: { accounts: [{ panel_id: "p3", short_uuid: "u3", status: "active" }] }, routes: {} });
  assert.equal((await fetch(`${s.base}/s/${s.token}`)).status, 502);
  s.close();
});

test("403 si la suscripción está vencida o suspendida; cuentas inactivas se ignoran", async () => {
  const a = await start({ sub: { expires_at: new Date(Date.now() - 1000).toISOString() }, routes: {} });
  assert.equal((await fetch(`${a.base}/s/${a.token}`)).status, 403); a.close();
  const b = await start({ sub: { status: "suspended" }, routes: {} });
  assert.equal((await fetch(`${b.base}/s/${b.token}`)).status, 403); b.close();
  const c = await start({ sub: { accounts: [{ panel_id: "p1", short_uuid: "u1", status: "active" }, { panel_id: "p2", short_uuid: "u2", status: "disabled" }] }, routes: { "https://sub1.test/u1": { body: b64("vless://a#1") } } });
  const r = await fetch(`${c.base}/s/${c.token}`); assert.equal(r.status, 200); assert.equal(c.calls.length, 1); c.close();
});

test("?format= fuerza el formato y fusiona JSON Xray de dos paneles", async () => {
  const s = await start({
    sub: { accounts: [{ panel_id: "p1", short_uuid: "u1", status: "active" }, { panel_id: "p2", short_uuid: "u2", status: "active" }] },
    routes: { "https://sub1.test/u1": { body: '[{"remarks":"A"}]' }, "https://sub2.test/u2": { body: '[{"remarks":"B"}]' } },
  });
  const r = await fetch(`${s.base}/s/${s.token}?format=xray-json`);
  assert.deepEqual(JSON.parse(await r.text()).map((c) => c.remarks), ["A", "B"]);
  assert.equal(r.headers.get("x-sub-format"), "xray-json");
  assert.equal(s.calls[0].headers["user-agent"], "Happ/1.0 (json)");
  s.close();
});

test("429 al superar el límite por minuto", async () => {
  const s = await start({ cfg: { ...CFG, rateLimitPerMin: 2 }, routes: { "https://sub1.test/u1": { body: b64("vless://a#1") } } });
  const codes = []; for (let i = 0; i < 4; i++) codes.push((await fetch(`${s.base}/s/${s.token}`)).status);
  assert.deepEqual(codes.slice(0, 2), [200, 200]); assert.ok(codes.includes(429));
  s.close();
});

test("/health responde", async () => {
  const s = await start({ routes: {} });
  assert.deepEqual(await (await fetch(`${s.base}/health`)).json(), { ok: true, name: "Carlos VPN" });
  s.close();
});

test("mensajes de error en el idioma: guardado en la suscripción > ?lang > Accept-Language", async () => {
  const a = await start({ sub: { status: "suspended", language: "bn" }, routes: {} });
  const ra = await fetch(`${a.base}/s/${a.token}?lang=en`, { headers: { "accept-language": "ru" } });
  assert.equal(ra.status, 403); assert.match((await ra.json()).message, /সাবস্ক্রিপশন/); a.close();
  const b = await start({ sub: { status: "suspended" }, routes: {} });
  assert.match((await (await fetch(`${b.base}/s/${b.token}?lang=ar`)).json()).message, /اشتراكك/);
  assert.match((await (await fetch(`${b.base}/s/${b.token}`, { headers: { "accept-language": "hi-IN" } })).json()).message, /सदस्यता/); b.close();
});

test("GET /i18n/locales y /i18n/:lang", async () => {
  const s = await start({ routes: {} });
  const list = await (await fetch(`${s.base}/i18n/locales`)).json();
  assert.equal(list.length, 7); assert.equal(list.find((l) => l.code === "ar").dir, "rtl");
  const zh = await (await fetch(`${s.base}/i18n/zh`)).json();
  assert.equal(zh.strings["lang.choose"], "选择语言");
  assert.equal((await fetch(`${s.base}/i18n/xx`)).status, 404);
  s.close();
});
