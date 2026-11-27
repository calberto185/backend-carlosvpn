// Límite de peticiones por clave (token o IP) en ventana de 1 minuto. En memoria.
function createRateLimiter({ perMinute = 30, now = () => Date.now() } = {}) {
  const hits = new Map();
  return function allow(k) {
    const t = now();
    const arr = (hits.get(k) || []).filter((x) => t - x < 60000);
    if (arr.length >= perMinute) { hits.set(k, arr); return false; }
    arr.push(t); hits.set(k, arr);
    if (hits.size > 5000) for (const [kk, v] of hits) if (!v.some((x) => t - x < 60000)) hits.delete(kk);
    return true;
  };
}
module.exports = { createRateLimiter };
