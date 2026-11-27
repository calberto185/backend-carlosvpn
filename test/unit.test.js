const test = require("node:test");
const assert = require("node:assert/strict");
const { generateSubToken, isValidSubToken } = require("../src/lib/token");
const { encrypt, decrypt, isEncrypted } = require("../src/lib/crypto");
const { createRateLimiter } = require("../src/lib/rateLimit");
const { detectFormat, sniffBody } = require("../src/aggregator/detect");
const { mergeBodies, decodeLinks } = require("../src/aggregator/merge");
const { parseUserInfo } = require("../src/aggregator/service");

const KEY = "a".repeat(64);
const b64 = (s) => Buffer.from(s).toString("base64");

test("token: 32 caracteres base64url y único", () => {
  const a = generateSubToken(), b = generateSubToken();
  assert.equal(a.length, 32); assert.ok(isValidSubToken(a)); assert.notEqual(a, b);
  assert.ok(!isValidSubToken("corto")); assert.ok(!isValidSubToken("x".repeat(31) + "!")); assert.ok(!isValidSubToken(null));
});

test("crypto: ida y vuelta, y detecta manipulación o clave incorrecta", () => {
  const c = encrypt("secreto-ñ", KEY);
  assert.ok(isEncrypted(c)); assert.notEqual(c, "secreto-ñ");
  assert.equal(decrypt(c, KEY), "secreto-ñ");
  assert.notEqual(encrypt("x", KEY), encrypt("x", KEY)); // IV distinto
  assert.throws(() => decrypt(c, "b".repeat(64)));
  const t = c.split(":"); t[3] = Buffer.from("zzzz").toString("base64url");
  assert.throws(() => decrypt(t.join(":"), KEY));
  assert.throws(() => encrypt("x", "corta"));
});

test("rateLimit: corta al superar el límite y se libera tras 1 minuto", () => {
  let t = 0; const allow = createRateLimiter({ perMinute: 2, now: () => t });
  assert.ok(allow("k")); assert.ok(allow("k")); assert.ok(!allow("k")); assert.ok(allow("otro"));
  t = 61000; assert.ok(allow("k"));
});

test("detectFormat: por User-Agent y ?format= manda", () => {
  assert.equal(detectFormat("Happ/2.0"), "base64");
  assert.equal(detectFormat("v2rayNG/1.9"), "base64");
  assert.equal(detectFormat("Hiddify/2.0"), "singbox");
  assert.equal(detectFormat("clash-verge/1.7"), "clash");
  assert.equal(detectFormat("Happ/2.0", { format: "xray-json" }), "xray-json");
  assert.equal(detectFormat("Happ/2.0", { format: "raro" }), "base64");
});

test("sniffBody: reconoce el formato real del panel", () => {
  assert.equal(sniffBody(""), "empty");
  assert.equal(sniffBody('[{"remarks":"a"}]'), "xray-json");
  assert.equal(sniffBody('{"outbounds":[]}'), "singbox");
  assert.equal(sniffBody("proxies:\n  - name: a"), "clash");
  assert.equal(sniffBody(b64("vless://x#a")), "base64");
});

test("merge enlaces: junta, quita duplicados y acepta texto plano", () => {
  const r = mergeBodies("base64", [b64("vless://a#1\nvless://b#2"), "vless://b#2\nhy2://c#3"]);
  assert.equal(r.count, 3);
  assert.deepEqual(decodeLinks(r.body), ["vless://a#1", "vless://b#2", "hy2://c#3"]);
});

test("merge xray-json: concatena sin repetir remarks y tolera JSON roto", () => {
  const r = mergeBodies("xray-json", ['[{"remarks":"A"},{"remarks":"B"}]', '[{"remarks":"B"},{"remarks":"C"}]', "no-json"]);
  assert.deepEqual(JSON.parse(r.body).map((c) => c.remarks), ["A", "B", "C"]);
});

test("merge sing-box: añade salidas y las mete en selector/urltest", () => {
  const d1 = { outbounds: [{ type: "selector", tag: "proxy", outbounds: ["n1"] }, { type: "vless", tag: "n1" }, { type: "direct", tag: "direct" }] };
  const d2 = { outbounds: [{ type: "selector", tag: "proxy", outbounds: ["n2"] }, { type: "vless", tag: "n2" }, { type: "vless", tag: "n1" }] };
  const out = JSON.parse(mergeBodies("singbox", [JSON.stringify(d1), JSON.stringify(d2)]).body);
  assert.deepEqual(out.outbounds.find((o) => o.tag === "proxy").outbounds, ["n1", "n2"]);
  assert.equal(out.outbounds.filter((o) => o.tag === "n1").length, 1);
  assert.ok(out.outbounds.some((o) => o.tag === "n2"));
});

test("merge clash: añade proxies y los agrega a los grupos", () => {
  const a = "proxies:\n  - {name: A, type: vless}\nproxy-groups:\n  - {name: G, type: select, proxies: [A]}\n";
  const b = "proxies:\n  - {name: B, type: vless}\n  - {name: A, type: vless}\n";
  const r = mergeBodies("clash", [a, b]);
  const y = require("yaml").parse(r.body);
  assert.deepEqual(y.proxies.map((p) => p.name), ["A", "B"]);
  assert.deepEqual(y["proxy-groups"][0].proxies, ["A", "B"]);
});

test("parseUserInfo", () => {
  assert.deepEqual(parseUserInfo("upload=1; download=2; total=3; expire=4"), { upload: 1, download: 2, total: 3, expire: 4 });
  assert.deepEqual(parseUserInfo(undefined), { upload: 0, download: 0, total: 0, expire: 0 });
});
