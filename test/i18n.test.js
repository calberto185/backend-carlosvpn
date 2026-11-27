const test = require("node:test");
const assert = require("node:assert/strict");
const { LOCALES, resolveLocale, fromAcceptLanguage, t, isRtl, listLocales, getCatalog } = require("../src/i18n");

test("están los 7 idiomas pedidos", () => {
  assert.deepEqual(LOCALES, ["es", "en", "ru", "zh", "ar", "hi", "bn"]);
  assert.deepEqual(listLocales().map((l) => l.name), ["Español", "English", "Русский", "简体中文", "العربية", "हिन्दी", "বাংলা"]);
});

test("todos los catálogos tienen las mismas claves, sin vacíos, y conservan {name}", () => {
  const keys = Object.keys(getCatalog("en").strings).sort();
  for (const l of LOCALES) {
    const s = getCatalog(l).strings;
    assert.deepEqual(Object.keys(s).sort(), keys, `claves distintas en ${l}`);
    for (const k of keys) assert.ok(s[k].trim().length > 0, `${l}:${k} vacío`);
    assert.ok(s["lang.changed"].includes("{name}"), `${l}: falta {name}`);
  }
});

test("solo el árabe es RTL", () => {
  assert.deepEqual(LOCALES.filter(isRtl), ["ar"]);
});

test("Accept-Language: respeta prioridades y variantes regionales", () => {
  assert.equal(fromAcceptLanguage("hi-IN,hi;q=0.9,en;q=0.8"), "hi");
  assert.equal(fromAcceptLanguage("bn-BD"), "bn");
  assert.equal(fromAcceptLanguage("zh-CN,zh;q=0.9"), "zh");
  assert.equal(fromAcceptLanguage("fr-FR,fr;q=0.9,ru;q=0.5"), "ru");
  assert.equal(fromAcceptLanguage("en;q=0.2,ar;q=0.9"), "ar");
  assert.equal(fromAcceptLanguage("fr,de"), null);
  assert.equal(fromAcceptLanguage(""), null);
});

test("resolveLocale: preferencia del usuario > ?lang > Accept-Language > por defecto", () => {
  assert.equal(resolveLocale({ userLang: "ar", queryLang: "en", acceptLanguage: "ru" }), "ar");
  assert.equal(resolveLocale({ queryLang: "en", acceptLanguage: "ru" }), "en");
  assert.equal(resolveLocale({ acceptLanguage: "bn" }), "bn");
  assert.equal(resolveLocale({ userLang: "xx" }), "es");
  assert.equal(resolveLocale({ defaultLocale: "ru" }), "ru");
});

test("t(): interpola y cae a inglés o a la clave si falta", () => {
  assert.equal(t("es", "lang.changed", { name: "Русский" }), "Idioma cambiado a Русский.");
  assert.equal(t("zh", "lang.choose"), "选择语言");
  assert.equal(t("xx", "lang.choose"), "Choose your language");
  assert.equal(t("es", "no.existe"), "no.existe");
});
