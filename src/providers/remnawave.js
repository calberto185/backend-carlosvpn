// Cabeceras del cliente que se reenvían al panel (Remnawave registra el HWID con ellas).
const FORWARD = ["x-hwid", "x-device-os", "x-ver-os", "x-device-model", "accept-language"];

function pickForwardHeaders(h = {}) {
  const out = {};
  for (const k of FORWARD) if (h[k]) out[k] = String(h[k]);
  return out;
}

function createRemnawaveProvider({ fetchImpl = fetch } = {}) {
  return {
    name: "remnawave",
    // GET <sub_url>/<short_uuid> con el User-Agent del cliente (el panel elige el formato por UA).
    async fetchSubscription(panel, account, { userAgent, headers, timeoutMs = 8000 } = {}) {
      const base = String(panel.sub_url || "").replace(/\/+$/, "");
      if (!base || !account.short_uuid) throw new Error("Cuenta o panel sin sub_url/short_uuid");
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${base}/${encodeURIComponent(account.short_uuid)}`, {
          headers: { "user-agent": userAgent || "Carlos-VPN-Aggregator", ...pickForwardHeaders(headers) },
          signal: ctl.signal,
          redirect: "follow",
        });
        const body = await res.text();
        const h = {};
        res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
        return { status: res.status, headers: h, body };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = { createRemnawaveProvider, pickForwardHeaders };
