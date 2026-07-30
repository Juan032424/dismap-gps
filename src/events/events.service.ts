import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { GeofencesService } from '../geofences/geofences.service';
import { ParsedPosition } from '../protocol-gateway/adapters/adapter.interface';

export type Severity = 'critical' | 'warning' | 'info';

interface DeviceCfg {
  id: number;
  name?: string;
  plate?: string;
  speed_limit?: number;
  driver?: string;
}

interface VehState {
  overLimit: boolean;
  ignition: boolean | null;
  moving: boolean;
  inside: Map<number, string>; // geofenceId -> name
  lowBattWarned: boolean;
}

/**
 * Motor de eventos: transforma cada posición en información accionable.
 * Detecta transiciones (no repite la misma alerta en cada trama) de:
 *  - exceso de velocidad (según límite por vehículo)
 *  - encendido/apagado del motor (bit ACC)
 *  - SOS, corte de energía, vibración (alarmas del equipo)
 *  - inicio/fin de movimiento
 *  - entrada/salida de geocercas
 *  - batería baja (en el heartbeat)
 * Cada evento se guarda (histórico) y se emite en vivo por WebSocket.
 */
@Injectable()
export class EventsService implements OnModuleInit {
  private readonly logger = new Logger(EventsService.name);
  private readonly state = new Map<string, VehState>();

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeGateway,
    private readonly geofences: GeofencesService,
  ) {}

  async onModuleInit() {
    try {
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS events (
          id           BIGSERIAL PRIMARY KEY,
          device_id    INTEGER,
          type         TEXT NOT NULL,
          severity     TEXT NOT NULL DEFAULT 'info',
          message      TEXT NOT NULL,
          latitude     DOUBLE PRECISION,
          longitude    DOUBLE PRECISION,
          speed_kmh    REAL,
          geofence_id  INTEGER,
          meta         JSONB,
          acknowledged BOOLEAN NOT NULL DEFAULT false,
          time         TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS idx_events_time ON events (time DESC)`,
      );
    } catch (err) {
      this.logger.warn(`No se pudo preparar events: ${(err as Error).message}`);
    }
  }

  /** Evalúa una posición y produce/guarda/emite los eventos que correspondan. */
  async evaluatePosition(p: ParsedPosition, device: DeviceCfg) {
    const st =
      this.state.get(p.uniqueId) ??
      ({ overLimit: false, ignition: p.ignition, moving: false, inside: new Map(), lowBattWarned: false } as VehState);

    const out: { type: string; severity: Severity; message: string; geofenceId?: number }[] = [];
    const limit = device.speed_limit ?? 80;
    // Etiqueta de la alerta: vehículo + conductor al mando (si está asignado),
    // para saber de un vistazo QUÉ vehículo y QUIÉN lo conduce.
    const vehicle = device.plate || device.name || p.uniqueId;
    const label = device.driver ? `${vehicle} (${device.driver})` : vehicle;

    // Exceso de velocidad (solo al cruzar el umbral hacia arriba)
    if (p.speedKmh > limit && !st.overLimit) {
      out.push({ type: 'exceso_velocidad', severity: 'warning', message: `${label}: exceso de velocidad ${Math.round(p.speedKmh)} km/h (límite ${limit})` });
    }
    st.overLimit = p.speedKmh > limit;

    // Motor encendido / apagado
    if (p.ignition !== null && st.ignition !== p.ignition) {
      out.push(p.ignition
        ? { type: 'encendido', severity: 'info', message: `${label}: motor encendido` }
        : { type: 'apagado', severity: 'info', message: `${label}: motor apagado` });
    }
    st.ignition = p.ignition;

    // Inicio / fin de movimiento
    const moving = p.speedKmh > 2;
    if (moving && !st.moving) out.push({ type: 'inicio_movimiento', severity: 'info', message: `${label}: comenzó a moverse` });
    if (!moving && st.moving) out.push({ type: 'detenido', severity: 'info', message: `${label}: se detuvo` });
    st.moving = moving;

    // Alarmas del equipo
    for (const a of p.alarms) {
      if (a === 'sos') out.push({ type: 'sos', severity: 'critical', message: `${label}: ¡BOTÓN SOS ACTIVADO!` });
      else if (a === 'corte_energia') out.push({ type: 'corte_energia', severity: 'critical', message: `${label}: corte de energía / batería desconectada` });
      else if (a === 'vibracion') out.push({ type: 'vibracion', severity: 'info', message: `${label}: vibración detectada` });
    }

    // Geocercas (entrada/salida)
    try {
      const inside = await this.geofences.containing(p.latitude, p.longitude);
      const nowIds = new Map(inside.map((g) => [g.id, g.name]));
      const alertOn = new Map(inside.map((g) => [g.id, g.alert_on]));
      for (const g of inside) {
        if (!st.inside.has(g.id) && (g.alert_on === 'enter' || g.alert_on === 'both')) {
          out.push({ type: 'geocerca_entrada', severity: 'info', message: `${label}: entró a la zona "${g.name}"`, geofenceId: g.id });
        }
      }
      for (const [id, name] of st.inside) {
        if (!nowIds.has(id)) {
          const mode = alertOn.get(id);
          out.push({ type: 'geocerca_salida', severity: 'warning', message: `${label}: salió de la zona "${name}"`, geofenceId: id });
        }
      }
      st.inside = nowIds;
    } catch {
      /* sin geocercas / BD apagada: no rompe la ingesta */
    }

    this.state.set(p.uniqueId, st);

    for (const e of out) {
      await this.emit(device.id, e.type, e.severity, e.message, {
        latitude: p.latitude, longitude: p.longitude, speedKmh: p.speedKmh, geofenceId: e.geofenceId,
      });
    }
  }

  /** Batería baja: se evalúa en el heartbeat del equipo. */
  async evaluateBattery(uniqueId: string, deviceId: number, battery: number | null) {
    if (battery == null) return;
    const st = this.state.get(uniqueId);
    if (battery <= 20 && !(st?.lowBattWarned)) {
      await this.emit(deviceId, 'bateria_baja', 'warning', `${uniqueId}: batería baja (${battery}%)`, { battery });
      if (st) st.lowBattWarned = true;
    }
    if (battery > 30 && st) st.lowBattWarned = false;
  }

  private async emit(
    deviceId: number | null,
    type: string,
    severity: Severity,
    message: string,
    meta: { latitude?: number; longitude?: number; speedKmh?: number; geofenceId?: number; battery?: number },
  ) {
    const payload: any = {
      deviceId, type, severity, message,
      latitude: meta.latitude ?? null, longitude: meta.longitude ?? null,
      speedKmh: meta.speedKmh ?? null, geofenceId: meta.geofenceId ?? null,
      time: new Date().toISOString(),
    };
    try {
      const res = await this.db.query(
        `INSERT INTO events (device_id, type, severity, message, latitude, longitude, speed_kmh, geofence_id, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, time`,
        [deviceId, type, severity, message, meta.latitude ?? null, meta.longitude ?? null, meta.speedKmh ?? null, meta.geofenceId ?? null, meta.battery != null ? { battery: meta.battery } : null],
      );
      payload.id = res.rows[0].id;
      payload.time = res.rows[0].time;
    } catch (err) {
      this.logger.error(`Evento sin histórico: ${(err as Error).message}`);
    }
    this.realtime.emitEvent(payload);
    this.logger.log(`[${severity.toUpperCase()}] ${message}`);
  }

  /** Historial de eventos para el panel de alertas. */
  async list(opts: { deviceId?: number; limit?: number; severity?: string; unackOnly?: boolean }) {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.deviceId != null) { params.push(opts.deviceId); conds.push(`e.device_id = $${params.length}`); }
    if (opts.severity) { params.push(opts.severity); conds.push(`e.severity = $${params.length}`); }
    if (opts.unackOnly) conds.push(`e.acknowledged = false`);
    params.push(Math.min(opts.limit ?? 100, 500));
    const res = await this.db.query(
      `SELECT e.*, d.name AS device_name, d.plate
       FROM events e LEFT JOIN devices d ON d.id = e.device_id
       ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
       ORDER BY e.time DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows;
  }

  async acknowledge(id: number) {
    await this.db.query('UPDATE events SET acknowledged = true WHERE id = $1', [id]);
    return { acknowledged: id };
  }

  async acknowledgeAll() {
    await this.db.query('UPDATE events SET acknowledged = true WHERE acknowledged = false');
    return { ok: true };
  }
}
