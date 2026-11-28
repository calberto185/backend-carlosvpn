// Roles en MongoDB con permisos por pantalla y acción. "admin" siempre tiene acceso total; "client" nunca entra al panel.
const crypto = require("crypto");
const { ACTIONS, ROUTE_KEYS, DEFAULT_ROLES, NO_PERMS } = require("./permissions");
const DEF_BY_NAME = Object.fromEntries(DEFAULT_ROLES.map((r) => [r.name, r.routePermissions]));

const err = (m, code = "VALIDATION") => Object.assign(new Error(m), { code });
const COLORS = ["primary", "secondary", "success", "warning", "error", "info", "ghost"];

// Caché de 5 minutos por rol; se invalida al crear, editar o borrar. WeakMap: una caché por conexión a la base.
const caches = new WeakMap();
const TTL = 5 * 60 * 1000;
const cacheOf = (db) => { if (!caches.has(db)) caches.set(db, new Map()); return caches.get(db); };
const invalidate = (db, name) => (name ? cacheOf(db).delete(name) : cacheOf(db).clear());

const allowedRoutes = (rp = {}) => Object.entries(rp).filter(([, p]) => p && p.view === true).map(([k]) => k);

// Solo pantallas conocidas y valores booleanos: un error de escritura no puede dar permisos por accidente.
function sanitize(raw = {}) {
  const out = {};
  for (const [route, p] of Object.entries(raw || {})) {
    if (!ROUTE_KEYS.includes(route)) throw err(`pantalla desconocida "${route}" (válidas: ${ROUTE_KEYS.join(", ")})`);
    out[route] = Object.fromEntries(ACTIONS.map((a) => [a, p && p[a] === true]));
  }
  return out;
}

// Crea los roles de sistema que falten y AÑADE (sin tocar lo editado) las pantallas nuevas del catálogo.
async function seedRoles(db) {
  const col = db.collection("roles");
  for (const def of DEFAULT_ROLES) {
    const cur = await col.findOne({ name: def.name });
    if (!cur) {
      const rp = sanitize(def.routePermissions);
      for (const k of ROUTE_KEYS) if (!rp[k]) rp[k] = { ...NO_PERMS };
      await col.insertOne({ id: crypto.randomUUID(), name: def.name, label: def.label, description: def.description, color: def.color, routePermissions: rp, allowedRoutes: allowedRoutes(rp), isSystem: true, createdAt: new Date(), updatedAt: new Date() });
    }
  }
  await syncRoutes(db);
  invalidate(db);
}

// Añade a cada rol las pantallas que le falten: los roles de sistema con su valor por defecto, los propios sin permisos.
async function syncRoutes(db) {
  let updated = 0;
  for (const role of await db.collection("roles").find({}).toArray()) {
    const rp = { ...(role.routePermissions || {}) };
    let changed = false;
    for (const k of ROUTE_KEYS) {
      if (!rp[k]) {
        // Roles de sistema reciben su valor por defecto en pantallas nuevas; los roles propios, sin permisos.
        const def = role.isSystem || role.name === "admin" ? (DEF_BY_NAME[role.name] || {})[k] : null;
        rp[k] = def ? Object.fromEntries(ACTIONS.map((a) => [a, def[a] === true])) : { ...NO_PERMS };
        changed = true;
      }
    }
    if (changed) { await db.collection("roles").updateOne({ id: role.id }, { $set: { routePermissions: rp, allowedRoutes: allowedRoutes(rp), updatedAt: new Date() } }); invalidate(db, role.name); updated++; }
  }
  return updated;
}

async function roleCan(db, roleName, routeKey, action) {
  if (roleName === "admin") return true;
  if (!roleName || roleName === "client") return false;
  const c = cacheOf(db), hit = c.get(roleName);
  let perms;
  if (hit && Date.now() - hit.at < TTL) perms = hit.perms;
  else { const r = await db.collection("roles").findOne({ name: roleName }); perms = r ? r.routePermissions || {} : null; c.set(roleName, { perms, at: Date.now() }); }
  return !!(perms && perms[routeKey] && perms[routeKey][action] === true);
}

const roleExists = async (db, name) => name === "client" || !!(await db.collection("roles").findOne({ name }));
const listRoles = async (db) => (await db.collection("roles").find({}).toArray()).map(({ _id, ...r }) => r).sort((a, b) => (b.isSystem === true) - (a.isSystem === true) || a.name.localeCompare(b.name));
const getRole = async (db, name) => { const r = await db.collection("roles").findOne({ name: String(name).toLowerCase() }); if (!r) return null; const { _id, ...rest } = r; return rest; };

async function createRole(db, { name, label, description = "", color = "primary", routePermissions = {} }) {
  const safe = String(name || "").toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  if (!safe || safe.length > 32) throw err("name inválido (letras minúsculas, números y _; máximo 32)");
  if (["client", "admin"].includes(safe)) throw err(`"${safe}" es un nombre reservado`);
  if (!String(label || "").trim()) throw err("label es requerido");
  if (!COLORS.includes(color)) throw err(`color debe ser: ${COLORS.join(", ")}`);
  if (await db.collection("roles").findOne({ name: safe })) throw err(`Ya existe un rol con el nombre "${safe}"`);
  const rp = sanitize(routePermissions);
  for (const k of ROUTE_KEYS) if (!rp[k]) rp[k] = { ...NO_PERMS };
  const doc = { id: crypto.randomUUID(), name: safe, label: String(label).trim().slice(0, 60), description: String(description).trim().slice(0, 300), color, routePermissions: rp, allowedRoutes: allowedRoutes(rp), isSystem: false, createdAt: new Date(), updatedAt: new Date() };
  await db.collection("roles").insertOne(doc);
  invalidate(db, safe);
  return doc;
}

async function updateRole(db, id, patch) {
  const cur = await db.collection("roles").findOne({ id });
  if (!cur) throw err("No existe ese rol");
  const set = { updatedAt: new Date() };
  if (patch.label !== undefined) { if (!String(patch.label).trim()) throw err("label no puede estar vacío"); set.label = String(patch.label).trim().slice(0, 60); }
  if (patch.description !== undefined) set.description = String(patch.description).trim().slice(0, 300);
  if (patch.color !== undefined) { if (!COLORS.includes(patch.color)) throw err(`color debe ser: ${COLORS.join(", ")}`); set.color = patch.color; }
  if (patch.routePermissions !== undefined) {
    if (cur.name === "admin") throw err("El rol admin siempre tiene acceso completo y no se puede restringir");
    const rp = sanitize(patch.routePermissions);
    for (const k of ROUTE_KEYS) if (!rp[k]) rp[k] = { ...(cur.routePermissions || {})[k] || NO_PERMS };
    set.routePermissions = rp; set.allowedRoutes = allowedRoutes(rp);
  }
  await db.collection("roles").updateOne({ id }, { $set: set });
  invalidate(db, cur.name);
  return getRole(db, cur.name);
}

async function deleteRole(db, id) {
  const cur = await db.collection("roles").findOne({ id });
  if (!cur) throw err("No existe ese rol");
  if (cur.isSystem) throw err("No se puede eliminar un rol del sistema");
  if (await db.collection("users").findOne({ role: cur.name })) throw err("Hay usuarios con este rol: cámbialos de rol antes de eliminarlo");
  await db.collection("roles").deleteOne({ id });
  invalidate(db, cur.name);
  return true;
}

module.exports = { seedRoles, syncRoutes, roleCan, roleExists, listRoles, getRole, createRole, updateRole, deleteRole, invalidate };
