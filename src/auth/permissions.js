// Catálogo de pantallas (routeKey) y acciones, y roles de sistema por defecto.
// Los roles viven en MongoDB y se editan desde el panel; esto solo define el punto de partida.
// Las claves de pantalla siguen la convención del backend anterior (users, settings/plans, ...).
const ACTIONS = ["view", "create", "update", "delete"];
const ROUTE_KEYS = ["dashboard", "users", "subscriptions", "settings/plans", "settings/servers", "remnawave", "activity", "roles"];

const ALL = { view: true, create: true, update: true, delete: true };
const VIEW = { view: true, create: false, update: false, delete: false };
const VIEW_EDIT = { view: true, create: false, update: true, delete: false };
const VIEW_CREATE_EDIT = { view: true, create: true, update: true, delete: false };

const DEFAULT_ROLES = [
  {
    name: "admin", label: "Administrador", color: "error", isSystem: true,
    description: "Acceso completo al panel de administración.",
    routePermissions: { dashboard: VIEW, users: ALL, subscriptions: ALL, "settings/plans": ALL, "settings/servers": ALL, remnawave: ALL, activity: VIEW, roles: ALL },
  },
  {
    name: "manager", label: "Gerente", color: "warning", isSystem: true,
    description: "Gestión operativa: clientes, suscripciones y actividad.",
    routePermissions: { dashboard: VIEW, users: VIEW_CREATE_EDIT, subscriptions: VIEW_EDIT, "settings/plans": VIEW, activity: VIEW },
  },
  {
    name: "support", label: "Soporte", color: "info", isSystem: true,
    description: "Atención al cliente: solo consulta de clientes, suscripciones y planes.",
    routePermissions: { dashboard: VIEW, users: VIEW, subscriptions: VIEW, "settings/plans": VIEW },
  },
];

const NO_PERMS = { view: false, create: false, update: false, delete: false };
module.exports = { ACTIONS, ROUTE_KEYS, DEFAULT_ROLES, NO_PERMS };
