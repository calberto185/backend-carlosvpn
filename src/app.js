const express = require("express");
const { subscriptionRouter } = require("./routes/subscription");
const { createRateLimiter } = require("./lib/rateLimit");
const { i18nRouter } = require("./routes/i18n");
const { attachUser } = require("./auth/middleware");
const { authRouter } = require("./routes/auth");
const { managementRouter } = require("./routes/management");

function createApp({ repo, providers, cfg, db }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // detrás de nginx/caddy
  app.get("/health", (_req, res) => res.json({ ok: true, name: cfg.brandName }));
  const allow = createRateLimiter({ perMinute: cfg.rateLimitPerMin });
  app.use(i18nRouter());
  app.use(subscriptionRouter({ repo, providers, cfg, allow }));
  if (db) {
    app.use("/api", express.json({ limit: "20kb" }), attachUser(db, cfg));
    app.use(authRouter({ db, cfg }));
    app.use(managementRouter({ db, cfg }));
  }
  app.use((e, req, res, _next) => {
    if (e && e.code === "VALIDATION") return res.status(400).json({ error: "validation", message: e.message });
    if (e && e.type === "entity.parse.failed") return res.status(400).json({ error: "bad_json" });
    console.error("[api] error:", e && e.message);
    res.status(500).json({ error: "internal" });
  });
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return app;
}
module.exports = { createApp };
