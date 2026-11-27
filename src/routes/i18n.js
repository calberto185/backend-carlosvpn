const express = require("express");
const { listLocales, getCatalog } = require("../i18n");

function i18nRouter() {
  const r = express.Router();
  r.get("/i18n/locales", (_req, res) => res.json(listLocales()));
  r.get("/i18n/:lang", (req, res) => {
    const c = getCatalog(req.params.lang);
    if (!c) return res.status(404).json({ error: "not_found" });
    res.json(c);
  });
  return r;
}
module.exports = { i18nRouter };
