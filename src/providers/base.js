/**
 * Interfaz de proveedor de panel. Cada proveedor (remnawave, pasarguard…) implementa:
 *
 *   fetchSubscription(panel, account, { userAgent, headers, timeoutMs })
 *       -> { status, headers, body }      // suscripción del usuario tal como la sirve el panel
 *
 * Fases siguientes añadirán: createUser, suspendUser, renewUser, resetTraffic, listHwid.
 */
class NotImplementedProvider {
  constructor(name) { this.name = name; }
  async fetchSubscription() {
    const e = new Error(`El proveedor "${this.name}" aún no está implementado`);
    e.code = "NOT_IMPLEMENTED";
    throw e;
  }
}
module.exports = { NotImplementedProvider };
