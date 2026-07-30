import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class DevicesService implements OnModuleInit {
  private readonly logger = new Logger(DevicesService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Añade columnas nuevas sobre bases ya existentes (idempotente). */
  async onModuleInit() {
    try {
      await this.db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS speed_limit INTEGER DEFAULT 80`);
      await this.db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS driver TEXT`);
      await this.db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS notes TEXT`);
      await this.db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS sim_number TEXT`);
      await this.db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS apn TEXT`);
      await this.db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS provisioned BOOLEAN NOT NULL DEFAULT false`);
      await this.db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true`);
    } catch (err) {
      this.logger.warn(`No se pudieron preparar columnas de devices: ${(err as Error).message}`);
    }
  }

  /** Provisión: el administrador registra un GPS con toda su configuración
   *  antes de que se conecte. Al conectarse (findOrCreate) conserva estos datos.
   *  Idempotente: volver a registrar el mismo unique_id actualiza la config. */
  async provision(data: {
    unique_id: string; name?: string; plate?: string; model?: string; protocol?: string;
    sim_number?: string; apn?: string; speed_limit?: number; driver?: string; notes?: string;
  }) {
    if (!data.unique_id) throw new Error('unique_id (ID del GPS) es obligatorio');
    const { rows } = await this.db.query(
      `INSERT INTO devices (unique_id, name, plate, model, protocol, sim_number, apn, speed_limit, driver, notes, provisioned, active)
       VALUES ($1,$2,$3, COALESCE($4,'ST-901'), COALESCE($5,'h02'), $6,$7, COALESCE($8,80), $9,$10, true, true)
       ON CONFLICT (unique_id) DO UPDATE SET
         name = COALESCE($2, devices.name),
         plate = COALESCE($3, devices.plate),
         model = COALESCE($4, devices.model),
         protocol = COALESCE($5, devices.protocol),
         sim_number = COALESCE($6, devices.sim_number),
         apn = COALESCE($7, devices.apn),
         speed_limit = COALESCE($8, devices.speed_limit),
         driver = COALESCE($9, devices.driver),
         notes = COALESCE($10, devices.notes),
         provisioned = true
       RETURNING *`,
      [
        data.unique_id, data.name ?? null, data.plate ?? null, data.model ?? null, data.protocol ?? null,
        data.sim_number ?? null, data.apn ?? null, data.speed_limit ?? null, data.driver ?? null, data.notes ?? null,
      ],
    );
    return rows[0];
  }

  async remove(id: number) {
    await this.db.query('DELETE FROM positions WHERE device_id = $1', [id]);
    await this.db.query('DELETE FROM devices WHERE id = $1', [id]);
    return { deleted: id };
  }

  /** Auto-registro: la primera trama de un GPS crea el dispositivo. */
  async findOrCreate(
    uniqueId: string,
  ): Promise<{ id: number; unique_id: string; name?: string; plate?: string; speed_limit?: number; driver?: string }> {
    const res = await this.db.query(
      `INSERT INTO devices (unique_id, name, last_seen)
       VALUES ($1, $2, now())
       ON CONFLICT (unique_id) DO UPDATE SET last_seen = now()
       RETURNING id, unique_id, name, plate, speed_limit, driver`,
      [uniqueId, `ST-901 ${uniqueId}`],
    );
    return res.rows[0];
  }

  /** Heartbeat HTBT del ST-901: actualiza última conexión y % de batería. */
  async heartbeat(uniqueId: string, batteryLevel: number | null): Promise<{ id: number }> {
    const res = await this.db.query(
      `INSERT INTO devices (unique_id, name, battery_level, last_seen)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (unique_id) DO UPDATE
         SET battery_level = COALESCE($3, devices.battery_level),
             last_seen = now()
       RETURNING id`,
      [uniqueId, `ST-901 ${uniqueId}`, batteryLevel],
    );
    return res.rows[0];
  }

  /** Lista de dispositivos con su última posición (para el mapa en vivo). */
  async list() {
    const res = await this.db.query(`
      SELECT d.id, d.unique_id, d.name, d.plate, d.model, d.protocol,
             d.battery_level, d.speed_limit, d.driver, d.notes,
             d.sim_number, d.apn, d.provisioned, d.active, d.created_at, d.last_seen,
             p.time AS position_time, p.latitude, p.longitude,
             p.speed_kmh, p.course, p.valid, p.ignition, p.alarms
      FROM devices d
      LEFT JOIN LATERAL (
        SELECT * FROM positions
        WHERE device_id = d.id
        ORDER BY time DESC
        LIMIT 1
      ) p ON true
      ORDER BY d.id`);
    return res.rows;
  }

  /** Editar datos del vehículo real de la flota (nombre, placa, límite, conductor…). */
  async update(
    id: number,
    data: { name?: string; plate?: string; speed_limit?: number; driver?: string; notes?: string },
  ) {
    const res = await this.db.query(
      `UPDATE devices
       SET name = COALESCE($2, name),
           plate = COALESCE($3, plate),
           speed_limit = COALESCE($4, speed_limit),
           driver = COALESCE($5, driver),
           notes = COALESCE($6, notes)
       WHERE id = $1
       RETURNING *`,
      [id, data.name ?? null, data.plate ?? null, data.speed_limit ?? null, data.driver ?? null, data.notes ?? null],
    );
    return res.rows[0];
  }
}
