// Mongo mínimo en memoria para pruebas (igualdad simple, $set, sort/limit).
function memDb() {
  const data = {};
  const col = (n) => {
    const arr = (data[n] = data[n] || []);
    const match = (f) => (d) => Object.entries(f || {}).every(([k, v]) => d[k] === v);
    return {
      insertOne: async (d) => { arr.push({ ...d }); },
      findOne: async (f) => arr.find(match(f)) || null,
      find: (f) => {
        let rows = arr.filter(match(f)); const c = {
          sort: (s) => { const [[k, dir]] = Object.entries(s); rows = [...rows].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); return c; },
          limit: (n) => { rows = rows.slice(0, n); return c; },
          toArray: async () => rows.map((r) => ({ ...r })),
        }; return c;
      },
      updateOne: async (f, u) => { const d = arr.find(match(f)); if (d) Object.assign(d, u.$set); return { matchedCount: d ? 1 : 0 }; },
      deleteOne: async (f) => { const i = arr.findIndex(match(f)); if (i >= 0) arr.splice(i, 1); },
      deleteMany: async (f) => { for (let i = arr.length - 1; i >= 0; i--) if (match(f)(arr[i])) arr.splice(i, 1); },
    };
  };
  return { collection: col, _data: data };
}
module.exports = { memDb };
