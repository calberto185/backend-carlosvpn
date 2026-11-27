// Idiomas de Carlos VPN. Se comparten entre la API, la web (Angular) y los bots.
// Códigos: es, en, ru, zh (chino simplificado), ar (árabe, RTL), hi (hindi, India), bn (bengalí, Bangladesh).
const LOCALES = ["es", "en", "ru", "zh", "ar", "hi", "bn"];
const catalogs = Object.fromEntries(LOCALES.map((l) => [l, require(`./locales/${l}.json`)]));

function normalize(tag) {
  const base = String(tag || "").toLowerCase().trim().split(/[-_]/)[0];
  return LOCALES.includes(base) ? base : null;
}

// Accept-Language: "hi-IN,hi;q=0.9,en;q=0.8" -> primer idioma soportado por prioridad.
function fromAcceptLanguage(header) {
  const items = String(header || "").split(",").map((p) => {
    const [tag, q] = p.trim().split(";q=");
    return { tag, q: q === undefined ? 1 : Number(q) || 0 };
  }).filter((x) => x.tag).sort((a, b) => b.q - a.q);
  for (const it of items) { const n = normalize(it.tag); if (n && it.q > 0) return n; }
  return null;
}

/**
 * Orden: preferencia guardada del usuario > ?lang= > Accept-Language > idioma por defecto.
 */
function resolveLocale({ userLang, queryLang, acceptLanguage, defaultLocale = "es" } = {}) {
  return normalize(userLang) || normalize(queryLang) || fromAcceptLanguage(acceptLanguage) || normalize(defaultLocale) || "en";
}

function t(locale, key, vars = {}) {
  const cat = catalogs[normalize(locale) || "en"];
  let s = cat[key] ?? catalogs.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

const isRtl = (locale) => (catalogs[normalize(locale)] || {})._dir === "rtl";
function listLocales() {
  return LOCALES.map((code) => ({ code, name: catalogs[code]._name, dir: catalogs[code]._dir }));
}
function getCatalog(locale) {
  const n = normalize(locale);
  if (!n) return null;
  const { _name, _dir, ...strings } = catalogs[n];
  return { code: n, name: _name, dir: _dir, strings };
}

module.exports = { LOCALES, normalize, resolveLocale, fromAcceptLanguage, t, isRtl, listLocales, getCatalog };
