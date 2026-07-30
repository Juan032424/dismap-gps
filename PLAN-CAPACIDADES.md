# Plan Fase 5 — Capacidades por modelo y funcionalidades avanzadas

> Documento de planificación. **Nada de esto está implementado.** Es el diseño
> para que DISMAP alcance el nivel de funciones de las plataformas de referencia
> (Reportes, Gestión, Sensores, Ajustes) **pero con una regla que ellas no
> respetan**: que cada modelo muestre únicamente lo que su hardware realmente
> entrega. Complementa a [PLAN-MULTIPROTOCOLO.md](PLAN-MULTIPROTOCOLO.md).

## El problema que resuelve

Las plataformas chinas tipo Coban muestran **todo a todos**: un ST-901 sencillo
te ofrece "Reporte de combustible", "TPMS chart", "CAN data", "People Counter"…
aunque ese equipo no tenga ninguno de esos sensores. Resultado: menús llenos de
reportes que salen vacíos, columnas en blanco y botones que no hacen nada. Ruido.

DISMAP hará lo contrario: **el modelo declara sus capacidades y la app entera se
adapta.** Si el equipo no tiene sensor de combustible, esa opción ni siquiera
aparece para ese vehículo. Cero interferencias entre lo que se ve y lo que el
equipo puede dar.

> Esto es coherente con una decisión ya tomada: en el rediseño del login se
> quitó "Control de combustible" de los beneficios porque el sistema aún no lo
> tenía. Este plan es el camino para que esa y otras funciones sean **reales y
> por modelo**, no promesas de menú.

## Concepto central: capacidades en tres capas

Cada capacidad (combustible, temperatura, corte de motor, RFID…) se filtra por
tres niveles. Una capacidad solo está disponible si pasa los tres:

```
  CAPA 1 · Protocolo   →  ¿el FORMATO puede transportar este dato?
     (techo técnico)       H02 no lleva CAN; Codec8 sí.

  CAPA 2 · Modelo      →  ¿este HARDWARE trae el sensor/entrada?
     (perfil de fábrica)   Un FMB920 con 1-wire tiene temperatura; otro no.
                           ← ESTA es la pantalla que pediste: al configurar el
                             modelo se ven las opciones que su protocolo permite
                             y marcas las que ese modelo físicamente tiene.

  CAPA 3 · Dispositivo →  ¿el admin la ACTIVÓ y quiere MOSTRARLA?
     (por vehículo)        Dos interruptores: "rastrear" y "mostrar en panel".
```

Regla: **una capacidad aparece en la interfaz solo si `protocolo la permite Y
modelo la tiene Y dispositivo la activó`.** Así nunca hay un reporte de
combustible en un equipo sin sensor de combustible.

## Catálogo de capacidades

Agrupadas por familia. Cada una tiene: `code`, `name`, `family`, `data_type`
(bool/number/enum/text), `unit`, `icon`, y a qué reportes/columnas/comandos
habilita.

| Familia | Capacidades |
|---|---|
| **Posición** *(base, todos)* | ubicación, velocidad, rumbo, validez GPS, altitud, satélites |
| **Ubicación auxiliar** | LBS (celda) cuando no hay GPS, precisión (HDOP) |
| **Estado del vehículo** | ignición/ACC, motor on/off, batería del equipo (%/V), batería del vehículo (V), estado de carga |
| **Entradas / Salidas (I/O)** | entradas digitales, salidas digitales, **relé (corte de motor)** |
| **Sensores analógicos** | **combustible** (nivel %/L), **temperatura** (1..N sondas), **humedad**, presión |
| **CAN bus / OBD** | odómetro real, RPM, nivel de combustible OEM, consumo, temperatura motor, VIN, pedal, nivel AdBlue |
| **Neumáticos** | **TPMS** (presión y temperatura por llanta) |
| **Conductor** | **RFID / iButton** (identificación), autorización de encendido |
| **Comportamiento** | aceleración brusca, frenado brusco, curva agresiva, exceso, ralentí (idle), remolque |
| **Multimedia** | foto por evento (cámara), audio |
| **Conteo** | pasajeros (People Counter) |
| **Mantenimiento** | por km, por horas de motor, por fecha |
| **Alarmas** | SOS, corte de energía, vibración, caída (jamming), batería baja, geocerca |

Cada capacidad numérica define además su **agregación** para reportes (suma,
promedio, máx, min, delta) — p. ej. combustible usa delta (llenados/robos),
temperatura usa promedio y min/max.

## Matriz honesta: qué entrega cada protocolo (el techo)

Esto responde directo a tu pregunta *"con cuáles podemos obtener toda la
información"*. No todos los protocolos son iguales:

| Capacidad | H02 (ST-901) | GT06 (Concox) | TK103 | **Codec8 (Teltonika)** | @Track (Queclink) | Meitrack |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Posición, velocidad, rumbo | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Ignición / ACC | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Batería equipo | ✔ | ✔ | parcial | ✔ | ✔ | ✔ |
| Relé (corte motor) | según modelo | ✔ | ✔ | ✔ | ✔ | ✔ |
| Entradas/Salidas | limitado | parcial | parcial | ✔✔ | ✔ | ✔ |
| Combustible (sensor) | ✖ | ✖ | ✖ | ✔ | ✔ | ✔ |
| Temperatura | ✖ | ✖ | ✖ | ✔ (1-wire) | ✔ | ✔ |
| CAN bus / OBD | ✖ | ✖ | ✖ | ✔✔✔ | parcial | parcial |
| TPMS | ✖ | ✖ | ✖ | ✔ | ✖ | parcial |
| RFID / conductor | ✖ | parcial | ✖ | ✔ | ✔ | ✔ |
| Comportamiento (frenado…) | ✖ | parcial | ✖ | ✔✔ | ✔ | ✔ |
| Foto (cámara) | ✖ | ✖ | ✖ | ✔ (con cámara) | ✖ | ✔ (con cámara) |

**Conclusión práctica:** para "obtener toda la información" (combustible, CAN,
temperatura, comportamiento, TPMS) el camino es **Teltonika (Codec8)**. Los
equipos H02/GT06 dan lo esencial (ubicación, ignición, batería, corte de motor).
El sistema debe reflejar esa realidad, no aparentar que todos dan todo.

## La pantalla que pediste: configuración de un modelo

Nuevo módulo **Configuración → Modelos GPS** (solo super admin). Al crear/editar
un modelo:

1. **Eliges protocolo** (H02, GT06, Codec8…). Al elegirlo, la app carga la
   *paleta de capacidades* = el techo de ese protocolo (Capa 1). Las que el
   protocolo no soporta aparecen **en gris, deshabilitadas**, con una nota
   ("H02 no transporta datos CAN"). Así es imposible marcar algo incoherente.
2. **Marcas lo que este hardware trae** (Capa 2): un interruptor por capacidad
   disponible. Ej. para un FMB920: activas combustible, temperatura, CAN,
   comportamiento; para un ST-901: solo ignición, batería, relé.
3. **Configuras cada capacidad activada** (si aplica):
   - Combustible → tipo (sensor analógico / CAN), capacidad del tanque, curva
     de calibración.
   - Temperatura → cuántas sondas y sus nombres ("cava", "motor").
   - Relé → plantilla del comando (SMS y/o GPRS) y política ("solo super admin").
   - RFID → lista de tarjetas autorizadas.
4. **Notas de instalación** y a qué puerto/protocolo pertenece (informativo).
5. Guardas → queda el **perfil de capacidades del modelo**. Todo dispositivo de
   ese modelo hereda ese perfil.

Vista previa en la misma pantalla: *"Un vehículo con este modelo mostrará: mapa
en vivo, corte de motor, batería. NO mostrará: combustible, CAN, TPMS."* — para
que el admin vea el alcance antes de guardar.

## Cómo se adapta el resto de la app (anti-interferencia)

Todo lo visible se **filtra por capacidad**. Ejemplos concretos:

| Zona de la app | Cómo se adapta |
|---|---|
| **Registro de vehículo** | El desplegable de modelo (de la Fase 4) ya trae el perfil. Al elegirlo, la ficha solo pide/ofrece lo que ese modelo tiene. |
| **Ficha del vehículo** | Solo se dibujan las tarjetas de telemetría de capacidades activas. Sin sensor de combustible → no hay tarjeta de combustible (ni vacía). |
| **Menú de Reportes** | Un reporte solo aparece si el vehículo (o algún vehículo de la flota) tiene la capacidad que necesita. "Reporte de combustible" no sale para una flota de puros ST-901. |
| **Botones de comando** | "Cortar motor" solo si `supports_relay`. "Foto" solo si tiene cámara. |
| **Popup del mapa y panel flotante** | Como los "Ajustes → ventana pop-up" de la referencia, pero los checkboxes disponibles se limitan a lo que el modelo del vehículo soporta. Eliges *cuáles de las disponibles* mostrar (Capa 3, interruptor "mostrar"). |
| **Columnas de la lista de flota** | Personalizables, y solo se ofrecen columnas que al menos un vehículo puede llenar. |
| **Alertas** | Los tipos de alerta configurables por vehículo dependen de sus capacidades (no ofrecer "temperatura fuera de rango" a un equipo sin sonda). |

## Modelo de datos (se suma al de la Fase 4)

```sql
-- Catálogo maestro de capacidades
CREATE TABLE capabilities (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,      -- 'fuel', 'temp', 'relay', 'rfid', 'can_rpm'...
  name TEXT NOT NULL,
  family TEXT NOT NULL,           -- 'sensor', 'io', 'can', 'driver'...
  data_type TEXT NOT NULL,        -- 'bool'|'number'|'enum'|'text'
  unit TEXT,                      -- '%','°C','L','V'...
  aggregation TEXT,               -- 'avg'|'sum'|'delta'|'min'|'max'|null
  icon TEXT
);

-- Techo por protocolo (Capa 1): qué puede transportar cada formato
CREATE TABLE protocol_capabilities (
  protocol_id INTEGER REFERENCES protocols(id),
  capability_id INTEGER REFERENCES capabilities(id),
  PRIMARY KEY (protocol_id, capability_id)
);

-- Perfil del modelo (Capa 2): qué trae este hardware + su configuración
CREATE TABLE model_capabilities (
  model_id INTEGER REFERENCES gps_models(id),
  capability_id INTEGER REFERENCES capabilities(id),
  config JSONB,                   -- tanque, curva, nº sondas, plantilla comando
  PRIMARY KEY (model_id, capability_id)
);

-- Instancia (Capa 3): por vehículo, activar y mostrar
CREATE TABLE device_capabilities (
  device_id INTEGER REFERENCES devices(id),
  capability_id INTEGER REFERENCES capabilities(id),
  enabled BOOLEAN DEFAULT true,   -- ¿rastrear este dato?
  display BOOLEAN DEFAULT true,   -- ¿mostrarlo en panel/popup?
  config JSONB,                   -- overrides por vehículo (p.ej. su tanque real)
  PRIMARY KEY (device_id, capability_id)
);

-- Preferencias de visualización del usuario (popup, panel flotante, columnas)
CREATE TABLE view_preferences (
  user_id INTEGER REFERENCES users(id),
  scope TEXT,                     -- 'popup'|'floating'|'fleet_columns'
  fields JSONB,                   -- qué capacidades mostrar y en qué orden
  PRIMARY KEY (user_id, scope)
);
```

### Telemetría variable → una columna JSONB
Como cada modelo emite campos distintos, **no** se crean 50 columnas dispersas en
`positions`. Se mantienen las columnas núcleo (lat, lon, speed, course, ignition,
valid, battery) para indexar y consultar rápido, y todo lo demás va en:

```sql
ALTER TABLE positions ADD COLUMN telemetry JSONB;
-- ej: {"fuel": 62, "temp1": 4.5, "rpm": 1800, "rfid": "A1B2C3", "din1": true}
```

Cada adapter (Fase 4) rellena `telemetry` con lo que ese equipo mandó. Los
reportes consultan por clave JSONB. Ventaja: añadir un sensor nuevo no cambia el
esquema. Se puede crear un índice GIN sobre `telemetry` si algún filtro lo pide.

## Mapeo de las funciones de referencia → capacidad requerida

Traducción de lo que se ve en tus capturas al plan, marcando qué necesita
hardware que no todos tienen:

| Función (referencia) | Capacidad requerida | Fase DISMAP |
|---|---|---|
| Reporte de eventos / Estadística de eventos | *(ya existe: eventos)* | 5.1 |
| Datos históricos | *(ya existe: posiciones)* | ✔ hoy |
| Curva / Gráfico de velocidad | posición/velocidad | 5.1 |
| Reporte de estacionado (paradas) | ignición + posición | 5.1 |
| Reporte de jornada / Kilometraje | odómetro (calculado o CAN) | 5.1 |
| Reporte de sensores / Promedio | temperatura, humedad, combustible | 5.3 (requiere sensor) |
| Reporte de estado de E/S | I/O digitales | 5.3 |
| TPMS chart | TPMS | 5.4 (requiere hardware) |
| Temperature / Humidity difference & chart | temperatura, humedad | 5.3 (requiere sonda) |
| Reporte de fotos | cámara | 5.5 (requiere cámara) |
| People Counter Report | conteo | 5.5 (requiere sensor) |
| Reporte de mantenimiento | mantenimiento (km/horas/fecha) | 5.2 |
| Record de operación / Informe de consultas | auditoría de usuarios | 5.2 |
| Geocerca poligonal / Unión | *(ya existe)* | ✔ hoy |
| Envío de comandos por lote | comandos GPRS/SMS a varios | 5.2 (tras Fase 4) |
| Tarjeta RFID / Info del conductor | RFID | 5.3 |
| Sensor de combustible / temperatura | combustible, temperatura | 5.3 |
| Configuración LED / Mac / Actualización en línea | comandos específicos por modelo | 5.4 |
| Consultar longitud y latitud / ruta / POI | *(búsquedas — fácil)* | 5.1 |
| Ajustes: unidades, zona horaria, mapa | preferencias de usuario/empresa | 5.1 |
| Ajustes: pop-up y panel flotante | `view_preferences` filtrado por capacidad | 5.1 |

## Sub-fases

| Sub-fase | Alcance | Requiere |
|---|---|---|
| **5.0 Catálogo de capacidades** | Tablas de capacidades + techo por protocolo + perfil por modelo + pantalla "Configuración de modelos" con la paleta gris/activable. **Aún todo H02.** | — |
| **5.1 UI adaptativa + ajustes** | Ficha, popup, panel flotante y columnas filtrados por capacidad. Preferencias (unidades, zona horaria, mapa) por usuario. Reportes de velocidad/paradas/jornada/kilometraje. Búsquedas por coordenada/ruta/POI. | 5.0 |
| **5.2 Mantenimiento + auditoría + comandos por lote** | Reportes de mantenimiento (km/horas), log de operaciones de usuario, envío de comandos a varios equipos. | Fase 4 (comandos GPRS) |
| **5.3 Sensores (combustible, temperatura, I/O, RFID)** | Ingesta y reportes de sensores analógicos y conductor. | Fase 4.3 (Codec8) o modelos con sensor |
| **5.4 CAN / TPMS / comandos avanzados** | Datos CAN/OBD, TPMS, configuración LED/actualización por modelo. | Codec8 + hardware |
| **5.5 Multimedia / conteo** | Fotos por evento, People Counter. | Cámara / sensor |

Orden recomendado: **5.0 → 5.1** dan el salto de percepción más grande (la app se
siente "profesional y a medida") **sin depender de hardware nuevo**, porque solo
usan lo que el ST-901 ya entrega. Los sensores (5.3+) llegan cuando haya equipos
Teltonika en la flota.

## Riesgos y decisiones pendientes

- **Sobre-configuración:** el sistema de 3 capas es potente pero puede abrumar.
  Mitigación: perfiles de modelo vienen **pre-cargados** (una semilla con los 10
  modelos y sus capacidades ya marcadas); el admin casi nunca crea uno desde
  cero, solo elige del catálogo.
- **JSONB vs columnas:** JSONB da flexibilidad; si un sensor se vuelve central
  (p. ej. combustible en toda la flota) se puede promover a columna real después.
- **Calibración de combustible:** el nivel crudo del sensor no es litros; hace
  falta una curva de calibración por tanque. Es trabajo real de la 5.3, no un
  simple "mostrar el dato".
- **Corte de motor:** capacidad sensible. Decisión heredada del otro plan: solo
  super admin, con confirmación escrita del nombre del vehículo, y registro en
  auditoría (5.2).
- **No prometer lo que el hardware no da:** el valor de este plan es la honestidad
  por modelo. Nunca mostrar una capacidad "por si acaso"; si el modelo no la
  declara, no existe para ese vehículo.

---

*Escrito el 25-07-2026. Depende de la Fase 4 (multiprotocolo) para los datos de
sensores/CAN; las sub-fases 5.0 y 5.1 pueden hacerse antes, solo con H02.*
