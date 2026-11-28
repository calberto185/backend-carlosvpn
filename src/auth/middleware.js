const { userFromToken } = require("./service");
const { roleCan } = require("./roles");
const { resolveLocale, t } = require("../i18n");

const COOKIE = "cvpn_session";
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Identifica al usuario por "Authorization: Bearer" (bots, scripts) o por cookie (web). No bloquea: solo rellena req.user.
function attachUser(db, cfg) {
  return async (req, _res, next) => {
    try {
      req.locale = resolveLocale({ queryLang: req.query.lang, acceptLanguage: req.get("accept-language"), defaultLocale: cfg.defaultLocale });
      const h = req.get("authorization") || "";
      let token = h.startsWith("Bearer ") ? h.slice(7).trim() : null;
      let viaCookie = false;
      if (!token) { token = readCookie(req, COOKIE); viaCookie = !!token; }
      if (!token) return next();
      const user = await userFromToken(db, token);
      if (user) {
        req.user = user; req.sessionToken = token; req.viaCookie = viaCookie;
        if (user.language) req.locale = resolveLocale({ userLang: user.language, defaultLocale: cfg.defaultLocale });
      }
      next();
    } catch (e) { next(e); }
  };
}

// Fábrica del guardián de rutas. requirePerm() exige solo sesión; requirePerm("users", "view") exige además
// que el rol del usuario tenga esa acción en esa pantalla (permisos leídos de la base, con caché).
// Con cookie, las acciones que modifican exigen la cabecera X-Requested-With (protección CSRF).
function makeGuard(db) {
  return function requirePerm(routeKey, action) {
    return async (req, res, next) => {
      try {
        if (!req.user) return res.status(401).json({ error: "unauthorized", message: t(req.locale, "auth.unauthorized") });
        if (req.viaCookie && UNSAFE.has(req.method) && req.get("x-requested-with") !== "carlosvpn") {
          return res.status(403).json({ error: "csrf", message: t(req.locale, "auth.forbidden") });
        }
        if (routeKey && !(await roleCan(db, req.user.role, routeKey, action))) {
          return res.status(403).json({ error: "forbidden", message: t(req.locale, "auth.forbidden") });
        }
        next();
      } catch (e) { next(e); }
    };
  };
}

module.exports = { attachUser, makeGuard, COOKIE };
