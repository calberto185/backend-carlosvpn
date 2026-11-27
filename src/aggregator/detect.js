// Formato que pide el cliente: ?format= manda; si no, se deduce del User-Agent.
const FORMATS = ["base64", "xray-json", "singbox", "clash"];

function detectFormat(userAgent = "", query = {}) {
  const q = String(query.format || "").toLowerCase();
  if (FORMATS.includes(q)) return q;
  const ua = String(userAgent).toLowerCase();
  if (/(hiddify|sing-box|singbox|streisand|sfa|sfi)/.test(ua)) return "singbox";
  if (/(clash|mihomo|stash|verge|flclash|meta)/.test(ua)) return "clash";
  return "base64"; // Happ, v2rayNG, v2rayN y desconocidos
}

// User-Agent que se envía al panel cuando el cliente fuerza ?format= (PENDIENTE de validar contra el panel real).
const FORMAT_UA = {
  base64: "v2rayN/7.0",
  "xray-json": "Happ/1.0 (json)",
  singbox: "sing-box/1.11",
  clash: "mihomo/1.19",
};

// Deduce el formato real del cuerpo que devolvió el panel.
function sniffBody(body) {
  const t = String(body || "").trim();
  if (!t) return "empty";
  if (t.startsWith("[")) { try { if (Array.isArray(JSON.parse(t))) return "xray-json"; } catch {} }
  if (t.startsWith("{")) { try { const o = JSON.parse(t); if (o && Array.isArray(o.outbounds)) return "singbox"; } catch {} }
  if (/^\s*(proxies|proxy-groups|port|mixed-port)\s*:/m.test(t)) return "clash";
  return "base64";
}

module.exports = { FORMATS, detectFormat, FORMAT_UA, sniffBody };
