const { createRemnawaveProvider } = require("./remnawave");
const { NotImplementedProvider } = require("./base");

function createRegistry({ fetchImpl } = {}) {
  const map = {
    remnawave: createRemnawaveProvider({ fetchImpl }),
    pasarguard: new NotImplementedProvider("pasarguard"), // fase posterior
  };
  return {
    get(name) {
      const p = map[name];
      if (!p) throw new Error(`Proveedor desconocido: ${name}`);
      return p;
    },
  };
}
module.exports = { createRegistry };
