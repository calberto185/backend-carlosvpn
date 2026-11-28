const express = require("express");
const { authenticate, createSession, revokeSession, setLanguage, publicUser } = require("../auth/service");
const { makeGuard, COOKIE } = require("../auth/middleware");
const { createRateLimiter } = require("../lib/rateLimit");
const { audit } = require("../lib/audit");
const { t } = require("../i18n");
const crypto = require("crypto");

function authRouter({ db, cfg }) {
  const r = express.Router();
  const requirePerm = makeGuard(db);
  const loginAllow = createRateLimiter({ perMinute: 10 });
  const secure = cfg.publicBaseUrl.startsWith("https://") ? "; Secure" : "";
  const ttl = cfg.sessionTtlHours;

  // mode "cookie" (web, por defecto): la sesión viaja en una cookie HttpOnly y el token no llega al JavaScript.
  // mode "token" (bots, scripts): el token se devuelve en la respuesta y se envía como "Authorization: Bearer".
  r.post("/api/auth/login", async (req, res, next) => {
    try {
      const { email, password, mode = "cookie" } = req.body || {};
      const emailKey = crypto.createHash("sha256").update(String(email || "").toLowerCase()).digest("hex").slice(0, 16);
      if (!loginAllow(`ip:${req.ip}`) || !loginAllow(`em:${emailKey}`)) {
        return res.status(429).json({ error: "rate_limited", message: t(req.locale, "auth.too_many_attempts") });
      }
      const user = typeof email === "string" && typeof password === "string" ? await authenticate(db, email, password) : null;
      if (!user) {
        await audit(db, req, "login_failed", emailKey);
        return res.status(401).json({ error: "invalid_credentials", message: t(req.locale, "auth.invalid_credentials") });
      }
      const s = await createSession(db, user, { ttlHours: ttl, meta: { ip: req.ip, ua: String(req.get("user-agent") || "").slice(0, 200) } });
      req.user = user;
      await audit(db, req, "login", user.id);
      const body = { user: publicUser(user), expires_at: s.expires_at };
      if (mode === "token") return res.json({ ...body, token: s.token });
      res.set("Set-Cookie", `${COOKIE}=${encodeURIComponent(s.token)}; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=${Math.round(ttl * 3600)}`);
      res.json(body);
    } catch (e) { next(e); }
  });

  r.post("/api/auth/logout", requirePerm(), async (req, res, next) => {
    try {
      await revokeSession(db, req.sessionToken);
      res.set("Set-Cookie", `${COOKIE}=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.get("/api/me", requirePerm(), (req, res) => res.json({ user: publicUser(req.user) }));

  r.patch("/api/me", requirePerm(), async (req, res, next) => {
    try {
      const language = await setLanguage(db, req.user.id, (req.body || {}).language);
      res.json({ user: { ...publicUser(req.user), language } });
    } catch (e) { next(e); }
  });
  return r;
}
module.exports = { authRouter };
