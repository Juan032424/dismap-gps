import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { DevicesService } from '../devices/devices.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { EventsService } from '../events/events.service';
import { ParsedPosition } from '../protocol-gateway/adapters/adapter.interface';

@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly devices: DevicesService,
    private readonly realtime: RealtimeGateway,
    private readonly events: EventsService,
  ) {}

  /** Pipeline de ingesta: BD (histórico) → Redis (última pos) → WebSocket (vivo).
   *  Resiliente: si la BD o Redis fallan, la posición IGUAL se emite en vivo
   *  al monitor — solo se pierde el histórico, y queda registrado en el log. */
  async ingest(p: ParsedPosition) {
    let deviceId: number | null = null;
    let device: { id: number; unique_id: string; name?: string; plate?: string; speed_limit?: number; driver?: string } | null = null;

    try {
      device = await this.devices.findOrCreate(p.uniqueId);
      deviceId = device.id;
      await this.db.query(
        `INSERT INTO positions
          (device_id, time, latitude, longitude, geom,
           speed_kmh, course, valid, ignition, alarms, status_raw, raw)
         VALUES
          ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($4, $3), 4326),
           $5, $6, $7, $8, $9, $10, $11)`,
        [
          device.id, p.time, p.latitude, p.longitude,
          p.speedKmh, p.course, p.valid, p.ignition,
          p.alarms, p.statusRaw, p.raw,
        ],
      );
    } catch (err) {
      this.logger.error(
        `Sin histórico para ${p.uniqueId} (¿BD apagada?): ${(err as Error).message}`,
      );
    }

    const payload = {
      deviceId,
      uniqueId: p.uniqueId,
      time: p.time.toISOString(),
      latitude: p.latitude,
      longitude: p.longitude,
      speedKmh: p.speedKmh,
      course: p.course,
      valid: p.valid,
      ignition: p.ignition,
      alarms: p.alarms,
    };

    // El tiempo real va PRIMERO y nunca espera a nadie
    this.realtime.emitPosition(payload);
    this.logger.log(
      `Posición ${p.uniqueId} → ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)} @ ${p.speedKmh} km/h`,
    );

    // Motor de alertas: exceso de velocidad, SOS, geocercas, encendido…
    // (mejor esfuerzo; si falla no interrumpe la ingesta ni el tiempo real)
    if (deviceId != null) {
      this.events
        .evaluatePosition(p, {
          id: deviceId, name: device?.name, plate: device?.plate,
          speed_limit: device?.speed_limit, driver: device?.driver,
        })
        .catch((err) => this.logger.error(`Motor de eventos: ${(err as Error).message}`));
    }

    // Última posición en Redis: mejor esfuerzo, sin bloquear
    this.redis.client
      .set(`lastpos:${p.uniqueId}`, JSON.stringify(payload))
      .catch(() => undefined);
  }

  /** Historial para reproducción de viajes (por defecto: últimas 24 h). */
  async history(deviceId: number, from?: string, to?: string, limit = 1000) {
    const res = await this.db.query(
      `SELECT time, latitude, longitude, speed_kmh, course, valid, ignition, alarms
       FROM positions
       WHERE device_id = $1
         AND time >= COALESCE($2::timestamptz, now() - interval '24 hours')
         AND time <= COALESCE($3::timestamptz, now())
       ORDER BY time ASC
       LIMIT $4`,
      [deviceId, from ?? null, to ?? null, Math.min(limit, 10000)],
    );
    return res.rows;
  }
}
