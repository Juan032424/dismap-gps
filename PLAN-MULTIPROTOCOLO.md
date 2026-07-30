# Plan Fase 4 — Soporte multiprotocolo y catálogo de modelos GPS

> Documento de planificación. Nada de esto está implementado aún; es la hoja de
> ruta para cuando se decida ampliar DISMAP más allá del ST-901/H02.

## Objetivo

Que DISMAP soporte los protocolos GPS dominantes del mercado (≈90 % de los
equipos) y que el registro de un dispositivo sea **elegir marca y modelo de un
desplegable**: el sistema deduce solo el protocolo, el puerto, las capacidades
(relé, SOS, ACC, combustible…) y los comandos SMS de ese equipo.

Protocolos meta, en orden de prioridad de mercado:

| # | Protocolo | Equipos representativos | Tipo de trama |
|---|-----------|------------------------|---------------|
| 1 | **H02** *(ya soportado)* | SinoTrack ST-901/902/903, GT02, J16, EV07 | Texto ASCII `*HQ,...#` |
| 2 | **GT06** | Concox GT06N/GT06E/AT6, GT02A, JM01, LK720 | **Binario** `0x78 0x78 ...` |
| 3 | **TK103** | Coban TK103/TK103B/TK103-2 | Texto `(...)`|
| 4 | **Codec8/8E (Teltonika)** | FMB920, FMC920, FMB120/130/140 | **Binario** con preámbulo |
| 5 | **@Track (Queclink)** | GV300W, GV55, GV57 | Texto `+RESP:...$` |
| 6 | **Meitrack** | T333, T366, T355 | Texto `$$...` |
| 7 | **JT808** | Estándar chino/asiático, integraciones | **Binario** con registro/auth |

## Qué ya juega a favor

- El patrón *Adapter* existe (`src/protocol-gateway/adapters/`): la interfaz
  `ProtocolAdapter` con `matches()`/`parse()` y el registro de adapters en
  `TcpServerService` fueron diseñados exactamente para esto.
- `devices.protocol` ya existe en la base.
- La provisión de dispositivos y el generador de comandos SMS ya funcionan
  (hoy con los comandos H02 escritos en el frontend; este plan los mueve a
  plantillas por modelo en la base).

## Correcciones técnicas al diseño propuesto

Tres realidades que el plan debe respetar (y que cambian el esfuerzo):

1. **El servidor TCP actual es solo-texto.** Acumula un string ASCII y corta
   tramas por `#`. GT06, Codec8 y JT808 son **binarios** (un byte `0x23` = `#`
   dentro de un paquete binario rompería todo). Refactor necesario:
   - El socket acumula `Buffer`, no string.
   - Cada adapter aporta su **framer** (cómo detectar inicio/fin de paquete) y
     el servidor delega el troceo al adapter identificado para esa conexión.
   - La primera trama identifica el protocolo y **fija el adapter a la
     conexión** (hoy se re-detecta por trama, válido solo para texto).

2. **Varios protocolos exigen respuestas (ACK) o el equipo se desconecta.**
   - GT06: hay que responder el paquete de *login* (si no, el equipo corta y
     reintenta en bucle) y cada paquete lleva serial que se devuelve.
   - Codec8: tras cada lote de registros hay que responder cuántos se
     aceptaron (4 bytes), o Teltonika reenvía eternamente.
   - JT808: flujo completo de registro → autenticación antes de aceptar
     posiciones.
   - Cambio de interfaz: `parse()` pasa a devolver `{ messages, reply? }` y el
     servidor escribe `reply` al socket. (El ACK de heartbeat H02 ya hace esto,
     pero como caso especial; se generaliza.)

3. **Puerto único vs. puerto por protocolo.** Detectar protocolos texto por
   firma en un solo puerto funciona; mezclar binarios complica el framing.
   Decisión: **híbrido** — un puerto por protocolo (como propone la tabla de
   abajo), y dentro de cada puerto la detección/validación por firma. Es lo
   que hace la industria (Traccar) y simplifica el diagnóstico.

   | Protocolo | Puerto propuesto |
   |-----------|------------------|
   | H02 | 5013 *(actual, no cambia)* |
   | GT06 | 5023 |
   | TK103 | 5001 |
   | Codec8 | 5027 |
   | @Track | 5004 |
   | Meitrack | 5020 |
   | JT808 | 5serve1 → definir (p. ej. 5200) |

   Cada puerto se abre en `docker-compose.prod.yml` y en el firewall del VPS.

4. **Identidad del equipo por protocolo.** H02 manda un ID de ~10 dígitos;
   GT06/Codec8/JT808 mandan **IMEI de 15**. `devices.unique_id` sigue siendo la
   llave, pero el formulario debe indicar qué identificador pide cada modelo.

## Modelo de datos nuevo

```sql
-- Protocolos disponibles (semilla fija, editable solo por super admin)
CREATE TABLE protocols (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,      -- 'h02', 'gt06', 'tk103', 'codec8', ...
  name TEXT NOT NULL,
  default_port INTEGER NOT NULL,
  frame_kind TEXT NOT NULL,       -- 'text' | 'binary'
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT true
);

-- Catálogo de modelos (el desplegable del registro)
CREATE TABLE gps_models (
  id SERIAL PRIMARY KEY,
  protocol_id INTEGER NOT NULL REFERENCES protocols(id),
  brand TEXT NOT NULL,            -- SinoTrack, Concox, Teltonika...
  model TEXT NOT NULL,            -- ST-901, GT06N, FMB920...
  id_kind TEXT NOT NULL DEFAULT 'device_id',  -- 'device_id' | 'imei'
  supports_relay BOOLEAN DEFAULT false,       -- corte de motor
  supports_acc BOOLEAN DEFAULT true,
  supports_sos BOOLEAN DEFAULT false,
  supports_fuel BOOLEAN DEFAULT false,
  supports_temperature BOOLEAN DEFAULT false,
  supports_canbus BOOLEAN DEFAULT false,
  notes TEXT,                     -- particularidades de instalación
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (brand, model)
);

-- Plantillas de comandos SMS por modelo
CREATE TABLE gps_model_commands (
  id SERIAL PRIMARY KEY,
  model_id INTEGER NOT NULL REFERENCES gps_models(id),
  label TEXT NOT NULL,            -- 'Configurar servidor', 'Cortar motor'...
  template TEXT NOT NULL,         -- '804{PASS} {HOST} {PORT}'
  danger BOOLEAN DEFAULT false,   -- true => pedir confirmación (corte de motor)
  sort INTEGER DEFAULT 0
);

-- El dispositivo apunta al modelo; protocol se conserva por compatibilidad
ALTER TABLE devices ADD COLUMN model_id INTEGER REFERENCES gps_models(id);
```

Variables de plantilla: `{HOST}` `{PORT}` `{APN}` `{PASS}` `{APN_USER}`
`{APN_PASS}` — se resuelven con los datos del dispositivo + `GET /devices/config`
(el generador SMS actual del frontend se elimina en favor de esto).

## Cambios de interfaz (backend)

```ts
interface ProtocolAdapter {
  readonly code: string;                      // 'gt06'
  readonly frameKind: 'text' | 'binary';
  /** Extrae tramas completas del buffer; devuelve lo que sobra. */
  frame(buf: Buffer): { frames: Buffer[]; rest: Buffer };
  /** Interpreta una trama; reply se escribe tal cual al socket. */
  parse(frame: Buffer, session: DeviceSession):
    { messages: ParsedMessage[]; reply?: Buffer };
}
```

- `DeviceSession` (nuevo): estado por conexión — adapter fijado, uniqueId ya
  autenticado (JT808/GT06), seriales pendientes.
- `TcpServerService` pasa a abrir **N listeners** (uno por protocolo activo,
  puerto de la tabla `protocols`).
- Todo lo demás (PositionsService, EventsService, geocercas, reportes,
  WebSocket) **no cambia**: los adapters entregan el mismo `ParsedPosition`.

## Cambios de panel (frontend)

1. **Registro de dispositivo:** el campo "Modelo" (texto libre) se convierte en
   desplegable agrupado por marca (`SinoTrack ST-901`, `Concox GT06N`…). Al
   elegir:
   - se fija protocolo y puerto automáticamente (solo lectura, informativo);
   - la etiqueta del campo ID cambia a "ID del GPS (10 dígitos)" o
     "IMEI (15 dígitos)" con validación de longitud;
   - aparece la tarjeta de instrucciones del modelo (notas + puerto + SMS).
2. **Botón 📱 SMS:** deja de estar cableado a H02; renderiza las plantillas de
   `gps_model_commands` del modelo del equipo. Comandos `danger` (corte de
   motor) piden confirmación explícita.
3. **Módulo Configuración (solo super admin):** pestañas *Protocolos* (ver
   puertos/activar) y *Modelos GPS* (CRUD del catálogo + sus comandos).
4. **Ficha del vehículo:** los botones que dependan de capacidades solo se
   muestran si el modelo las soporta (`supports_relay` → botón de relé, etc.).

## Catálogo semilla

| Marca | Modelo | Protocolo | ID | Relé | SOS |
|---|---|---|---|---|---|
| SinoTrack | ST-901 | h02 | device_id | ✔ | ✔ |
| SinoTrack | ST-902 | h02 | device_id | ✔ | ✔ |
| Coban | TK103B | tk103 | imei | ✔ | ✔ |
| Coban | TK311 | gt06 | imei | ✔ | — |
| Concox | GT06N | gt06 | imei | ✔ | ✔ |
| Concox | AT6 | gt06 | imei | ✔ | — |
| Teltonika | FMB920 | codec8 | imei | ✔ | — |
| Teltonika | FMC920 | codec8 | imei | ✔ | — |
| Queclink | GV300W | queclink | imei | ✔ | ✔ |
| Meitrack | T333 | meitrack | imei | ✔ | ✔ |

## Sub-fases y entregables

| Sub-fase | Alcance | Valor entregado | Riesgo |
|---|---|---|---|
| **4.0 Catálogo** | Tablas `protocols`/`gps_models`/`gps_model_commands` + siembra + desplegable de modelo + SMS por plantilla. **Sin protocolos nuevos.** | El registro ya es "elegir modelo"; los comandos SMS salen de la base. Se puede hacer ya, con H02 solo. | Bajo |
| **4.1 Refactor binario + GT06** | Buffer/framing por adapter, sesiones, multi-puerto. Adapter GT06 con ACK de login y serial. | Se abre el mercado Concox (el más vendido). | Medio-alto (refactor del corazón TCP) |
| **4.2 TK103** | Adapter texto sencillo sobre la base 4.1. | Coban. | Bajo |
| **4.3 Codec8** | Adapter binario + ACK de conteo. AVL IDs mapeados a ignición/batería/odómetro. | Mercado profesional (Teltonika). | Medio |
| **4.4 @Track + Meitrack** | Dos adapters de texto. | Queclink y Meitrack. | Bajo-medio |
| **4.5 JT808 + comandos GPRS** | Registro/auth JT808. Además: enviar comandos **por TCP** a equipos conectados (corte de motor sin SMS) usando el registro de sesiones. | Asia + corte de motor remoto en vivo. | Alto |

Regla de oro heredada de la Fase 1: **cada adapter se valida con tramas reales**
(`npm run test:parser` se generaliza a `test:parser -- gt06`) y con un simulador
propio (`scripts/simulate-gt06.js`, etc.) antes de tocar un equipo físico.

## Riesgos y decisiones pendientes

- **ACK exactos:** un ACK mal formado hace que GT06/Teltonika se desconecten en
  bucle; se valida contra capturas reales (la línea `RAW` del log ya existe
  para esto en texto; añadir volcado hex para binario).
- **Bit ACC por modelo:** igual que con el ST-901, cada modelo confirma su bit
  de ignición con el equipo en mano; `status_raw` ya guarda el crudo.
- **Puertos en el VPS:** cada protocolo nuevo = puerto nuevo en compose +
  firewall de Teramont.
- **RAM del VPS (1 GB):** los listeners extra son baratos; el refactor no
  cambia el perfil de memoria. Sin acción.
- **Pendiente de decidir:** si el corte de motor por SMS se muestra desde 4.0
  (plantillas `danger`) o se retiene hasta tener política de permisos (¿solo
  super admin corta motor?). Propuesta: solo super admin, con confirmación
  escrita del nombre del vehículo.

---

*Escrito el 25-07-2026. Prerequisito recomendado antes de 4.1: subir el
proyecto a un repositorio (GitHub) con despliegue automático, para que cada
sub-fase llegue a producción con un push — pendiente de decidir cuándo.*
