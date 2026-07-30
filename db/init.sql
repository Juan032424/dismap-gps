-- DISMAP GPS — esquema inicial (Fase 1)
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS devices (
  id            SERIAL PRIMARY KEY,
  unique_id     TEXT NOT NULL UNIQUE,        -- ID del GPS (10 dígitos en el ST-901)
  name          TEXT,
  plate         TEXT,                        -- placa del vehículo
  model         TEXT DEFAULT 'ST-901',
  protocol      TEXT DEFAULT 'h02',
  battery_level INTEGER,                     -- % reportado en el heartbeat HTBT
  speed_limit   INTEGER DEFAULT 80,          -- límite para alerta de exceso (km/h)
  driver        TEXT,                        -- conductor asignado
  notes         TEXT,                        -- notas libres del vehículo
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS positions (
  id         BIGSERIAL,
  device_id  INTEGER NOT NULL REFERENCES devices(id),
  time       TIMESTAMPTZ NOT NULL,
  latitude   DOUBLE PRECISION NOT NULL,
  longitude  DOUBLE PRECISION NOT NULL,
  geom       geometry(Point, 4326),          -- para consultas espaciales (geocercas, Fase 2)
  speed_kmh  REAL,
  course     REAL,                           -- rumbo en grados
  valid      BOOLEAN,                        -- A = fix GPS válido, V = inválido
  ignition   BOOLEAN,                        -- bit ACC (validar contra el equipo real)
  alarms     TEXT[],
  status_raw TEXT,                           -- los 8 hex del campo de estado, sin interpretar
  raw        TEXT,                           -- trama original completa (auditoría / depuración)
  PRIMARY KEY (device_id, time, id)
);

SELECT create_hypertable('positions', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_positions_device_time ON positions (device_id, time DESC);

-- Geocercas: zonas (círculo o polígono) que disparan alertas de entrada/salida.
CREATE TABLE IF NOT EXISTS geofences (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'polygon',   -- 'circle' | 'polygon'
  color       TEXT DEFAULT '#F5A524',
  center_lat  DOUBLE PRECISION,                  -- centro (círculo)
  center_lon  DOUBLE PRECISION,
  radius_m    DOUBLE PRECISION,                  -- radio en metros (círculo)
  geom        geometry(Polygon, 4326),           -- polígono
  alert_on    TEXT NOT NULL DEFAULT 'both',      -- 'enter' | 'exit' | 'both'
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Eventos/alertas generados por el motor (exceso, SOS, geocercas, batería…).
CREATE TABLE IF NOT EXISTS events (
  id           BIGSERIAL PRIMARY KEY,
  device_id    INTEGER,
  type         TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info',      -- 'critical' | 'warning' | 'info'
  message      TEXT NOT NULL,
  latitude     DOUBLE PRECISION,
  longitude    DOUBLE PRECISION,
  speed_kmh    REAL,
  geofence_id  INTEGER,
  meta         JSONB,
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  time         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events (time DESC);
