// Cliente HTTP de la API de administración de Remnawave (contrato @remnawave/backend-contract 3.4.x).
// Solo habla con el panel; no conoce MongoDB ni los planes. El token nunca aparece en errores ni en logs.
class RwError extends Error {
  constructor(message, { status = 0, code = "RW_ERROR" } = {}) {
    super(message);
    this.name = "RwError";
    this.status = status;
    this.code = code;
  }
}

// Remnawave 2.x usa id numérico; versiones anteriores usaban uuid. Se usa el que traiga el usuario.
const userRef = (u) => (u && (u.id ?? u.uuid)) ?? null;

function createRwClient({ baseUrl, token, caddyKey, fetchImpl = fetch, timeoutMs = 10000 }) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(base)) throw new RwError("api_url del panel inválida", { code: "RW_CONFIG" });
  if (!token) throw new RwError("El panel no tiene token de API (usa panel:set-token)", { code: "RW_CONFIG" });

  async function request(method, path, body) {
    const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (caddyKey) headers["x-api-key"] = caddyKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      throw new RwError(e && e.name === "AbortError" ? "El panel no respondió a tiempo" : "No se pudo conectar con el panel", { code: "RW_UNREACHABLE" });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* respuesta no JSON */ }
    if (!res.ok) {
      const msg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
      const code = res.status === 401 || res.status === 403 ? "RW_AUTH" : res.status === 404 ? "RW_NOT_FOUND" : "RW_ERROR";
      throw new RwError(`Panel: ${String(msg).slice(0, 200)}`, { status: res.status, code });
    }
    return json && Object.prototype.hasOwnProperty.call(json, "response") ? json.response : json;
  }

  const enc = encodeURIComponent;
  return {
    request,
    // --- Sistema ---
    health: () => request("GET", "/api/system/health"),
    stats: () => request("GET", "/api/system/stats"),
    // --- Usuarios ---
    getByUsername: (u) => request("GET", `/api/users/by-username/${enc(u)}`),
    getByShortUuid: (s) => request("GET", `/api/users/by-short-uuid/${enc(s)}`),
    createUser: (body) => request("POST", "/api/users", body),
    // `id` (número) o `username` identifican al usuario en el PATCH; nunca `uuid`.
    updateUser: (body) => request("PATCH", "/api/users", body),
    enable: (u) => request("POST", `/api/users/${enc(userRef(u))}/actions/enable`),
    disable: (u) => request("POST", `/api/users/${enc(userRef(u))}/actions/disable`),
    resetTraffic: (u) => request("POST", `/api/users/${enc(userRef(u))}/actions/reset-traffic`),
    revoke: (u, body = {}) => request("POST", `/api/users/${enc(userRef(u))}/actions/revoke`, body),
    extend: (u, days) => request("POST", `/api/users/${enc(userRef(u))}/actions/extend`, { days }),
    deleteUser: (u) => request("DELETE", `/api/users/${enc(userRef(u))}`),
    // --- HWID ---
    hwidList: (u) => request("GET", `/api/hwid/devices/${enc(userRef(u))}`),
    hwidDelete: (u, hwid) => request("POST", "/api/hwid/devices/delete", { userId: userRef(u), hwid }),
    // --- Infraestructura ---
    nodes: () => request("GET", "/api/nodes"),
    nodeAction: (uuid, action) => request("POST", `/api/nodes/${enc(uuid)}/actions/${action}`),
    hosts: () => request("GET", "/api/hosts"),
    squads: () => request("GET", "/api/internal-squads"),
  };
}

module.exports = { createRwClient, RwError, userRef };
