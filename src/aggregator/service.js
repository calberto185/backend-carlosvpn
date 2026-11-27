const { detectFormat, FORMAT_UA, sniffBody } = require("./detect");
const { mergeBodies } = require("./merge");
const { resolveLocale, t } = require("../i18n");

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// Interpreta "upload=1; download=2; total=3; expire=4" del panel.
function parseUserInfo(v) {
  const o = { upload: 0, download: 0, total: 0, expire: 0 };
  for (const part of String(v || "").split(";")) {
    const [k, val] = part.trim().split("=");
    if (k in o && val !== undefined && !Number.isNaN(Number(val))) o[k] = Number(val);
  }
  return o;
}

/**
 * Construye la respuesta de suscripción de un cliente.
 *  - repo:      { getByToken(token) -> { sub, panels } | null }
 *  - providers: registro con get(nombre)
 */
async function buildSubscription({ token, userAgent, headers, query, repo, providers, cfg, locale }) {
  const found = await repo.getByToken(token);
  if (!found) return { status: 404, json: { error: "not_found" } };
  const { sub, panels } = found;
  const lang = resolveLocale({ userLang: sub.language, queryLang: locale, defaultLocale: cfg.defaultLocale });

  const expiresMs = sub.expires_at ? new Date(sub.expires_at).getTime() : 0;
  if (sub.status !== "active" || (expiresMs && expiresMs < Date.now())) {
    return { status: 403, json: { error: "inactive", message: t(lang, "sub.inactive") } };
  }

  const wanted = detectFormat(userAgent, query);
  const forced = query && query.format ? wanted : null;
  const ua = forced ? FORMAT_UA[forced] : userAgent;

  const accounts = (sub.accounts || []).filter((a) => a.status === "active");
  const settled = await Promise.allSettled(accounts.map(async (a) => {
    const panel = panels[a.panel_id];
    if (!panel) throw new Error("panel no encontrado");
    const r = await providers.get(panel.provider).fetchSubscription(panel, a, { userAgent: ua, headers, timeoutMs: cfg.upstreamTimeoutMs });
    if (r.status !== 200 || !r.body) throw new Error(`panel respondió ${r.status}`);
    return r;
  }));

  const ok = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  const failed = settled.length - ok.length;
  if (!ok.length) return { status: 502, json: { error: "upstream_unavailable", message: t(lang, "sub.upstream_unavailable") } };

  // El cuerpo manda: se fusiona según el formato real que devolvieron los paneles.
  const kinds = ok.map((r) => sniffBody(r.body));
  const fmt = kinds.find((k) => k !== "empty" && k !== "base64") || "base64";
  const same = ok.filter((_, i) => kinds[i] === fmt || (fmt === "base64" && kinds[i] === "base64"));
  const merged = mergeBodies(fmt, same.map((r) => r.body));

  // Consumo sumado de todos los paneles.
  const info = ok.map((r) => parseUserInfo(r.headers["subscription-userinfo"]));
  const upload = info.reduce((s, i) => s + i.upload, 0);
  const download = info.reduce((s, i) => s + i.download, 0);
  const hasQuota = info.length > 0 && info.every((i) => i.total > 0);
  const total = hasQuota ? info.reduce((s, i) => s + i.total, 0) : 0; // 0 = sin cuota/ilimitado
  const expire = expiresMs ? Math.floor(expiresMs / 1000) : 0;

  const title = `${cfg.brandName} | ${cfg.brandNameRu}`;
  const out = {
    "content-type": merged.contentType,
    "profile-title": `base64:${b64(title)}`,
    "profile-update-interval": String(cfg.subUpdateIntervalHours),
    "subscription-userinfo": `upload=${upload}; download=${download}; total=${total}; expire=${expire}`,
    "cache-control": "no-store",
    "x-sub-format": fmt,
    "x-sub-nodes": String(merged.count),
  };
  if (cfg.supportUrl) out["support-url"] = cfg.supportUrl;
  if (failed) out["x-sub-partial"] = `${failed}/${settled.length}`;
  return { status: 200, headers: out, body: merged.body };
}

module.exports = { buildSubscription, parseUserInfo };
