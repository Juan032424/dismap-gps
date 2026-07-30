# DISMAP GPS — Backend (Fase 1)

Plataforma de rastreo vehicular de DISCOL. Fase 1: compatibilidad exacta con el
**SinoTrack ST-901 4G** (protocolo H02) — el equipo de pruebas de la flota.

## Arquitectura (monolito modular NestJS)

```
GPS ST-901 ──TCP──▶ tcp-server.service ──▶ H02Adapter (parser)
                                              │
                              ┌───────────────┼────────────────┐
                              ▼               ▼                ▼
                     PostgreSQL+PostGIS    Redis          Socket.IO
                     (histórico,           (última        (mapa en vivo,
                      hypertable            posición)      evento "position")
                      TimescaleDB)
```

Módulos: `protocol-gateway` (TCP + adapters), `devices`, `positions`,
`realtime`, `database`, `redis`. Para soportar otro GPS (GT06, Teltonika...)
se crea un nuevo adapter que implemente `ProtocolAdapter` — nada más cambia.

## Arranque limpio (borra todo lo que esté corriendo)

Si algo quedó a medias, esto deja el entorno como nuevo (PowerShell, en la
carpeta del proyecto):

```powershell
# 1. Detener el backend y el simulador: Ctrl+C en cada terminal.
#    Si quedaron procesos huérfanos ocupando 3000/5013:
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

# 2. Borrar contenedores Y el volumen de la base (empezar de cero)
docker compose down -v

# 3. Comprobar que db/init.sql es un ARCHIVO, no una carpeta
#    (si Docker no lo encuentra, crea una carpeta vacía con ese nombre)
Get-Item .\db\init.sql | Select-Object Mode, Name, Length
```

Si el `Mode` empieza por `d`, es una carpeta: bórrala con
`Remove-Item .\db\init.sql -Recurse -Force` y vuelve a copiar el archivo
`init.sql` de este repo antes de continuar.

> **Puertos:** la base se publica en el **5433** del PC (no 5432) para no
> chocar con un PostgreSQL instalado en Windows. El `.env` ya apunta ahí.

## Puesta en marcha local

Requisitos: Node.js 20+, Docker Desktop.

```bash
docker compose up -d          # PostgreSQL (PostGIS+Timescale) y Redis
cp .env.example .env
npm install
npm run test:parser           # valida el parser H02 con tramas de ejemplo
npm run start:dev             # API en :3000, servidor TCP GPS en :5013
```

Probar el pipeline completo **sin el equipo físico**:

```bash
npm run simulate              # simula un ST-901 recorriendo Cartagena
```

**Ver todo en el navegador:** abrir <http://localhost:3000> — monitor de
flota con mapa en vivo (Leaflet + Socket.IO): vehículos moviéndose en tiempo
real, panel de flota, estado de encendido, batería y botón de recorrido 24 h
por vehículo.

También por API:

```bash
curl http://localhost:3000/devices
curl "http://localhost:3000/devices/1/positions?limit=10"
```

WebSocket: Socket.IO en `http://localhost:3000`, evento `position` (es el
mismo que consume el monitor y que consumirá la app Flutter).

## Configurar el ST-901 real (cuando esté el VPS)

Comandos por SMS a la SIM del equipo (clave por defecto: `0000`, según el
manual de SinoTrack — verificar contra el manual que venga con el equipo):

| Acción | SMS | Ejemplo |
|---|---|---|
| Configurar APN | `803<clave> <APN>` | `8030000 <APN_DE_LIWA>` |
| APN con usuario/clave | `803<clave> <APN> <user> <pass>` | `8030000 apn user pass` |
| Apuntar al servidor | `804<clave> <IP> <puerto>` | `8040000 <IP_VPS> 5013` |
| Intervalo de reporte con ACC on (seg) | `805<clave> <T>` | `8050000 20` |
| Intervalo con ACC off (seg) | `809<clave> <T>` | `8090000 300` |
| Ver configuración actual | `RCONF` | responde APN, IP:puerto, intervalos |

> El APN de LIWA hay que confirmarlo con el operador (opera sobre red Tigo;
> los MVNO suelen tener APN propio). Sin el APN correcto el equipo nunca
> saldrá a internet.

## Validación de compatibilidad exacta (con el equipo en mano)

1. Arrancar el backend con nivel debug: todas las tramas crudas quedan en el
   log (`RAW ...`).
2. Apuntar UN ST-901 al servidor y dejarlo reportar 24 h.
3. Comparar tramas crudas vs. lo interpretado:
   - Coordenadas contra Google Maps.
   - **Bit de ACC**: encender/apagar el switch del vehículo y comparar el
     campo de estado (8 hex). El parser usa la convención H02 de Traccar,
     pero el bit exacto se confirma con esta prueba (`positions.status_raw`
     guarda siempre el valor crudo).
   - Heartbeat `HTBT`: si el equipo se desconecta de forma extraña, probar
     `H02_ACK_HEARTBEAT=false`.
4. Ajustar `h02.parser.ts` si alguna trama real difiere — el test
   `npm run test:parser` se alimenta con esas tramas reales.

## Endpoints

**Autenticación y usuarios** (Fase 3 — login + roles)
- `POST /auth/login` `{email,password}` → `{token, user}` (JWT). *Público.*
- `GET /auth/me` — datos del usuario del token.
- `POST /auth/change-password` `{current,next}` — cambio de contraseña propia.
- `GET/POST/PATCH/DELETE /users` — gestión de usuarios (solo Super Admin/Admin).
- Roles: **Super Admin** (todo), **Admin** (flota, dispositivos, operadores),
  **Operador** (solo lectura). El super admin inicial se siembra desde el `.env`
  (`SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD`) en el primer arranque.
- Toda la API (salvo `/auth/login`) exige `Authorization: Bearer <token>`. El
  WebSocket exige el token en el handshake (`auth.token`).

**Flota / posiciones**
- `GET /devices` — flota con última posición (para el mapa).
- `POST /devices` — **provisionar** un GPS con su config (ID, placa, SIM, APN,
  límite…) antes de que se conecte (solo Admin). Al conectarse conserva los datos.
- `PATCH /devices/:id` — editar `name`, `plate`, `speed_limit`, `driver`, `notes` (Admin).
- `DELETE /devices/:id` — eliminar vehículo e historial (Admin).
- `GET /devices/config` — host/puerto/clave que usa el panel para **generar los
  comandos SMS** de configuración del equipo (`PUBLIC_HOST`, `TCP_H02_PORT`,
  `GPS_SMS_PASSWORD`; si `PUBLIC_HOST` no está, el panel usa el host del navegador).
- `GET /devices/:id/positions?from&to&limit` — historial / reproducción.
- `GET /devices/:id/report?from&to` — reporte: distancia, viajes segmentados,
  velocidades máx/media, paradas, histograma horario.

**Geocercas** (zonas con alerta de entrada/salida, detección PostGIS)
- `GET /geofences` · `POST /geofences` · `PATCH /geofences/:id` · `DELETE /geofences/:id`
- Círculo `{name,kind:'circle',center:{lat,lon},radius_m,alert_on}` o
  polígono `{name,kind:'polygon',points:[[lat,lon],...],alert_on}`.

**Alertas / eventos** (motor por transiciones)
- `GET /events?deviceId&severity&limit&unack=1` — historial de alertas.
- `PATCH /events/:id/ack` · `POST /events/ack-all` — marcar como vistas.
- Tipos: exceso de velocidad, encendido/apagado, SOS, corte de energía,
  vibración, batería baja, inicio/fin de movimiento, geocerca entrada/salida.

**WebSocket Socket.IO** — evento `position` (tiempo real) y evento `event`
(alerta en vivo). Ambos los consume el monitor y los consumirá la app Flutter.

Los GPS se auto-registran con su primera trama (aparecen como
`ST-901 <id>` y luego se les asigna placa).

## Monitor web (dashboard interactivo)

`public/` — `index.html` + `styles.css` + `app.js`. Además del mapa en vivo:
panel de detalle por vehículo (telemetría, dirección, edición de ficha),
recorrido 24 h con estadísticas y **reproducción del viaje**, dibujo de
**geocercas** (círculo/polígono) sobre el mapa, panel de **alertas** con
badge y reconocimiento, **reporte** con gráfico y exportación GPX/CSV.

## Roadmap

- [x] **Fase 1**: TCP + parser H02 + histórico + tiempo real *(este repo)*
- [x] **Fase 1.2**: geocercas PostGIS, motor de alertas, reportes y dashboard
      interactivo (detalle, reproducción, geocercas, alertas, reportes)
- [x] **Fase 3 (base)**: login + roles (Super Admin/Admin/Operador), provisión de
      dispositivos y gestión de usuarios/vehículos. Ver [DEPLOY.md](DEPLOY.md).
- [ ] Fase 1.5: validación con ST-901 físico + despliegue en VPS (Docker)
- [ ] Fase 2: app Android **DISMAP GPS** en Flutter (mapa vivo, historial,
      reproducción, geocercas, alertas FCM)
- [ ] Fase 3: multiempresa, roles, reportes — comercialización a terceros
