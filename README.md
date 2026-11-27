# Carlos VPN (КарлосВПН) — backend

Node.js. Fuente de verdad del servicio y agregador de suscripción en `https://vpn.carlosvm.me/s/<token>`.

## Estado (fase 1)
- Proveedor Remnawave: obtiene la suscripción de cada cuenta del cliente (reenvía HWID y User-Agent).
- PasarGuard: reservado, lanza "no implementado".
- Agregador `GET /s/:token`: base64, JSON Xray, sing-box y Clash; cabeceras de marca y consumo sumado; tolera paneles caídos; límite de peticiones.
- Idiomas: es, en, ru, zh, ar (RTL), hi, bn. Catálogo en `src/i18n/locales`, API `GET /i18n/locales` y `GET /i18n/:codigo`. Los errores del agregador salen en el idioma del usuario.
- Pruebas: `npm test` (27, con panel simulado).

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
# backend-carlosvpn
