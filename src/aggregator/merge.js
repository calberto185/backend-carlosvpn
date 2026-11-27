const YAML = require("yaml");

// ---------- enlaces (base64 o texto plano) ----------
function decodeLinks(body) {
  const t = String(body || "").trim();
  if (!t) return [];
  const plain = /^[a-z][a-z0-9+.-]*:\/\//i.test(t);
  const text = plain ? t : Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
function mergeLinks(bodies) {
  const seen = new Set(); const out = [];
  for (const b of bodies) for (const l of decodeLinks(b)) if (!seen.has(l)) { seen.add(l); out.push(l); }
  return { body: Buffer.from(out.join("\n"), "utf8").toString("base64"), count: out.length, contentType: "text/plain; charset=utf-8" };
}

// ---------- JSON Xray (lista de configuraciones) ----------
function mergeXrayJson(bodies) {
  const seen = new Set(); const out = [];
  for (const b of bodies) {
    let arr; try { arr = JSON.parse(b); } catch { continue; }
    for (const cfg of Array.isArray(arr) ? arr : []) {
      const k = cfg && cfg.remarks ? cfg.remarks : JSON.stringify(cfg);
      if (!seen.has(k)) { seen.add(k); out.push(cfg); }
    }
  }
  return { body: JSON.stringify(out), count: out.length, contentType: "application/json; charset=utf-8" };
}

// ---------- sing-box ----------
const SB_SKIP = new Set(["selector", "urltest", "direct", "block", "dns", "fallback"]);
function mergeSingbox(bodies) {
  const docs = bodies.map((b) => { try { return JSON.parse(b); } catch { return null; } }).filter((d) => d && Array.isArray(d.outbounds));
  if (!docs.length) return { body: "{}", count: 0, contentType: "application/json; charset=utf-8" };
  const base = docs[0];
  const tags = new Set(base.outbounds.map((o) => o.tag));
  const added = [];
  for (const d of docs.slice(1)) for (const o of d.outbounds) {
    if (SB_SKIP.has(o.type) || tags.has(o.tag)) continue;
    base.outbounds.push(o); tags.add(o.tag); added.push(o.tag);
  }
  for (const o of base.outbounds) if ((o.type === "selector" || o.type === "urltest") && Array.isArray(o.outbounds)) {
    for (const t of added) if (!o.outbounds.includes(t)) o.outbounds.push(t);
  }
  const count = base.outbounds.filter((o) => !SB_SKIP.has(o.type)).length;
  return { body: JSON.stringify(base), count, contentType: "application/json; charset=utf-8" };
}

// ---------- Clash / mihomo ----------
function mergeClash(bodies) {
  const docs = bodies.map((b) => { try { return YAML.parse(b); } catch { return null; } }).filter((d) => d && Array.isArray(d.proxies));
  if (!docs.length) return { body: "", count: 0, contentType: "text/yaml; charset=utf-8" };
  const base = docs[0];
  const names = new Set(base.proxies.map((p) => p.name));
  const added = [];
  for (const d of docs.slice(1)) for (const p of d.proxies) if (!names.has(p.name)) { base.proxies.push(p); names.add(p.name); added.push(p.name); }
  for (const g of base["proxy-groups"] || []) if (Array.isArray(g.proxies) && !g.use) {
    for (const n of added) if (!g.proxies.includes(n)) g.proxies.push(n);
  }
  return { body: YAML.stringify(base), count: base.proxies.length, contentType: "text/yaml; charset=utf-8" };
}

const MERGERS = { base64: mergeLinks, "xray-json": mergeXrayJson, singbox: mergeSingbox, clash: mergeClash };
function mergeBodies(format, bodies) {
  const m = MERGERS[format];
  if (!m) throw new Error(`Formato no soportado: ${format}`);
  return m(bodies);
}

module.exports = { mergeBodies, decodeLinks };
