const express = require("express");
const { subscriptionRouter } = require("./routes/subscription");
const { createRateLimiter } = require("./lib/rateLimit");
const { i18nRouter } = require("./routes/i18n");

function createApp({ repo, providers, cfg }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // detrás de nginx/caddy
  app.get("/health", (_req, res) => res.json({ ok: true, name: cfg.brandName }));
  const allow = createRateLimiter({ perMinute: cfg.rateLimitPerMin });
  app.use(i18nRouter());
  app.use(subscriptionRouter({ repo, providers, cfg, allow }));
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return app;
}
module.exports = { createApp };
