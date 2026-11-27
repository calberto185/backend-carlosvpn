const express = require("express");
const { isValidSubToken } = require("../lib/token");
const { buildSubscription } = require("../aggregator/service");
const { resolveLocale, t } = require("../i18n");

function subscriptionRouter({ repo, providers, cfg, allow }) {
  const r = express.Router();
  r.get("/s/:token", async (req, res) => {
    const token = req.params.token;
    // Token con formato inválido y exceso de peticiones se tratan igual que "no existe": no filtran información.
    if (!isValidSubToken(token)) return res.status(404).json({ error: "not_found" });
    const reqLocale = resolveLocale({ queryLang: req.query.lang, acceptLanguage: req.get("accept-language"), defaultLocale: cfg.defaultLocale });
    if (!allow(`t:${token}`) || !allow(`ip:${req.ip}`)) return res.status(429).json({ error: "rate_limited", message: t(reqLocale, "error.rate_limited") });
    try {
      const out = await buildSubscription({
        token, userAgent: req.get("user-agent") || "", headers: req.headers, query: req.query, repo, providers, cfg, locale: reqLocale,
      });
      if (out.json) return res.status(out.status).json(out.json);
      res.set(out.headers).status(out.status).send(out.body);
    } catch (e) {
      console.error("[sub] error:", e.message);
      res.status(500).json({ error: "internal" });
    }
  });
  return r;
}
module.exports = { subscriptionRouter };
