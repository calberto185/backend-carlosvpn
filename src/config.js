// Lee la configuración del entorno. Falla pronto si falta algo crítico.
function load(env = process.env) {
  const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
  // Solo URLs http(s) válidas: cualquier otra cosa (vacío, comentarios, texto) se ignora.
  const httpUrl = (v) => (/^https?:\/\/\S+$/.test(String(v || "").trim()) ? String(v).trim() : "");
  const cfg = {
    port: num(env.PORT, 3000),
    publicBaseUrl: (env.PUBLIC_BASE_URL || "https://vpn.carlosvm.me").replace(/\/+$/, ""),
    brandName: env.BRAND_NAME || "Carlos VPN",
    brandNameRu: env.BRAND_NAME_RU || "КарлосВПН",
    supportUrl: httpUrl(env.SUPPORT_URL),
    profileWebUrl: httpUrl(env.PROFILE_WEB_URL),
    mongoUri: env.MONGO_URI || "mongodb://localhost:27017",
    mongoDb: env.MONGO_DB || "carlosvpn",
    encryptionKey: env.ENCRYPTION_KEY || "",
    upstreamTimeoutMs: num(env.UPSTREAM_TIMEOUT_MS, 8000),
    subUpdateIntervalHours: num(env.SUB_UPDATE_INTERVAL_HOURS, 6),
    rateLimitPerMin: num(env.RATE_LIMIT_PER_MIN, 30),
    defaultLocale: env.DEFAULT_LOCALE || "es",
    sessionTtlHours: num(env.SESSION_TTL_HOURS, 12),
  };
  return cfg;
}

function assertProduction(cfg) {
  if (!/^[0-9a-fA-F]{64}$/.test(cfg.encryptionKey)) {
    throw new Error("ENCRYPTION_KEY debe ser 64 caracteres hexadecimales (openssl rand -hex 32)");
  }
}

module.exports = { load, assertProduction };
