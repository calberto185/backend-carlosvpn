# Carlos VPN (КарлосВПН) — backend

Node.js. Fuente de verdad del servicio y agregador de suscripción en `https://vpn.carlosvm.me/s/<token>`.

## Estado (fase 1)
- Proveedor Remnawave: obtiene la suscripción de cada cuenta del cliente (reenvía HWID y User-Agent).
- PasarGuard: reservado, lanza "no implementado".
- Agregador `GET /s/:token`: base64, JSON Xray, sing-box y Clash; cabeceras de marca y consumo sumado; tolera paneles caídos; límite de peticiones.
- Idiomas: es, en, ru, zh, ar (RTL), hi, bn. Catálogo en `src/i18n/locales`, API `GET /i18n/locales` y `GET /i18n/:codigo`. Los errores del agregador salen en el idioma del usuario.
- Administración por consola (`src/cli.js`): registrar paneles y crear/suspender suscripciones. En el VPS: `cd /opt/carlosvpn && docker compose exec backend node src/cli.js help`.
- Pruebas: `npm test` (31, con panel simulado).

## Pendiente de validar con el panel real
- User-Agent que usa Remnawave para elegir cada formato cuando se fuerza `?format=` (`src/aggregator/detect.js`, `FORMAT_UA`).
- Que Happ registre el HWID a través del agregador.
- Rutas y formato de la API de Remnawave de tu versión (service.carlosvm.me/api/docs).

## Arranque
```
cp .env.example .env     # rellena ENCRYPTION_KEY (openssl rand -hex 32)
npm install
npm test
npm start
```

## Datos que espera el agregador (MongoDB)
`panels`: `{ id, provider: "remnawave", sub_url: "https://sub.carlosvm.me" }`
`subscriptions`: `{ sub_token, status: "active", expires_at, accounts: [{ panel_id, short_uuid, status: "active" }] }`

## Seguridad
Token de 32 caracteres; los inválidos y los desconocidos responden igual (404). No subas `.env` a GitHub.


## Gestión: usuarios, roles, planes y clientes (fase 2a)

**Roles en la base de datos**, con permisos por pantalla y acción (`view`, `create`, `update`, `delete`), como en el backend anterior.
Pantallas: `dashboard`, `users`, `subscriptions`, `settings/plans`, `settings/servers`, `remnawave`, `activity`, `roles`
(catálogo en `src/auth/permissions.js`). Al arrancar se crean los roles de sistema que falten y se añaden las pantallas nuevas **sin pisar lo que hayas editado**.

| Rol | Alcance por defecto |
|---|---|
| `admin` | Todo. No se puede restringir ni eliminar. |
| `manager` | Clientes (ver, crear, editar), suscripciones (ver, suspender, reanudar, extender), planes y actividad en lectura |
| `support` | Solo consulta: clientes, suscripciones y planes |
| `client` | No entra al panel; solo `/api/me` |
| propios | Los que crees desde el panel de roles (`POST /api/roles`) |

**Primer administrador (en el VPS):**
```
docker compose exec backend node src/cli.js user:create --email tu@correo.com --role admin --lang es
docker compose exec backend node src/cli.js plan:seed --panel rw1
```
La contraseña se genera y se muestra una sola vez. Los planes de ejemplo nacen inactivos y con precio 0.

**Sesiones:** `POST /api/auth/login` con `{email, password}`. Por defecto la sesión va en una cookie `HttpOnly` (web). Con `"mode":"token"` devuelve un token para bots y scripts (`Authorization: Bearer ...`). Con cookie, las peticiones que modifican datos deben llevar `X-Requested-With: carlosvpn`. Máximo 10 intentos de login por minuto por IP y por correo. Las contraseñas se guardan con hash scrypt (no reversible).

| Método y ruta | Pantalla y acción |
|---|---|
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET/PATCH /api/me` (idioma) | solo sesión |
| `GET /api/plans` · `POST /api/plans` · `PATCH /api/plans/:id` | `settings/plans`: view · create · update |
| `GET /api/panels` | `settings/servers`: view |
| `GET /api/subscriptions`, `GET /api/subscriptions/:id` (enlace completo, queda en bitácora) | `subscriptions`: view |
| `POST /api/subscriptions` | `subscriptions`: create |
| `POST /api/subscriptions/:id/suspend`, `/resume`, `/extend` | `subscriptions`: update |
| `GET /api/users` · `POST /api/users` (contraseña temporal, se muestra una vez) | `users`: view · create |
| `GET /api/audit` | `activity`: view |
| `GET /api/roles` · `POST /api/roles` · `PATCH /api/roles/:id` · `DELETE /api/roles/:id` · `POST /api/roles/sync-routes` | `roles`: view · create · update · delete · update |
| `GET /api/roles/:name` | cualquier sesión |

Los cambios en un rol se aplican de inmediato. No se puede borrar un rol de sistema ni uno con usuarios asignados.
La lista de suscripciones nunca expone el token ni el `short_uuid` de los paneles. Toda acción sensible se registra en `audit_log`.
