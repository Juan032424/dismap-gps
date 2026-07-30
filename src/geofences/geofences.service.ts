import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface GeofenceInput {
  name: string;
  kind?: 'circle' | 'polygon';
  color?: string;
  center?: { lat: number; lon: number };
  radius_m?: number;
  points?: [number, number][]; // [[lat, lon], ...]
  active?: boolean;
  alert_on?: 'enter' | 'exit' | 'both';
}

/**
 * Geocercas: zonas dibujadas en el mapa (círculo o polígono) que disparan
 * alertas cuando un vehículo entra o sale. Usa PostGIS para la detección
 * espacial exacta (metros para círculos, contención para polígonos).
 */
@Injectable()
export class GeofencesService implements OnModuleInit {
  private readonly logger = new Logger(GeofencesService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Crea la tabla si no existe — funciona también sobre bases ya creadas. */
  async onModuleInit() {
    try {
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS geofences (
          id          SERIAL PRIMARY KEY,
          name        TEXT NOT NULL,
          kind        TEXT NOT NULL DEFAULT 'polygon',
          color       TEXT DEFAULT '#F5A524',
          center_lat  DOUBLE PRECISION,
          center_lon  DOUBLE PRECISION,
          radius_m    DOUBLE PRECISION,
          geom        geometry(Polygon, 4326),
          alert_on    TEXT NOT NULL DEFAULT 'both',
          active      BOOLEAN NOT NULL DEFAULT true,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    } catch (err) {
      this.logger.warn(`No se pudo preparar geofences: ${(err as Error).message}`);
    }
  }

  async list() {
    const res = await this.db.query(`
      SELECT id, name, kind, color, center_lat, center_lon, radius_m, alert_on, active, created_at,
             CASE WHEN kind = 'polygon' THEN ST_AsGeoJSON(geom) END AS geojson
      FROM geofences ORDER BY id`);
    return res.rows;
  }

  async create(g: GeofenceInput) {
    const kind = g.kind ?? (g.points ? 'polygon' : 'circle');
    let geomWkt: string | null = null;
    if (kind === 'polygon' && g.points?.length) {
      const ring = [...g.points];
      const [flat, flon] = ring[0];
      const [llat, llon] = ring[ring.length - 1];
      if (flat !== llat || flon !== llon) ring.push(ring[0]); // cerrar el anillo
      geomWkt = `POLYGON((${ring.map(([lat, lon]) => `${lon} ${lat}`).join(', ')}))`;
    }
    const base = [g.name, kind, g.color ?? '#F5A524', g.center?.lat ?? null, g.center?.lon ?? null, g.radius_m ?? null];
    const params = geomWkt ? [...base, geomWkt, g.alert_on ?? 'both'] : [...base, g.alert_on ?? 'both'];
    const geomExpr = geomWkt ? 'ST_GeomFromText($7,4326)' : 'NULL';
    const alertPlaceholder = geomWkt ? '$8' : '$7';
    const res = await this.db.query(
      `INSERT INTO geofences (name, kind, color, center_lat, center_lon, radius_m, geom, alert_on, active)
       VALUES ($1,$2,$3,$4,$5,$6, ${geomExpr}, ${alertPlaceholder}, true)
       RETURNING id, name, kind, color, center_lat, center_lon, radius_m, alert_on, active, created_at,
                 CASE WHEN kind = 'polygon' THEN ST_AsGeoJSON(geom) END AS geojson`,
      params,
    );
    return res.rows[0];
  }

  async update(id: number, data: Partial<GeofenceInput>) {
    const res = await this.db.query(
      `UPDATE geofences
         SET name = COALESCE($2, name),
             color = COALESCE($3, color),
             alert_on = COALESCE($4, alert_on),
             active = COALESCE($5, active)
       WHERE id = $1 RETURNING *`,
      [id, data.name ?? null, data.color ?? null, data.alert_on ?? null, data.active ?? null],
    );
    return res.rows[0];
  }

  async remove(id: number) {
    await this.db.query('DELETE FROM geofences WHERE id = $1', [id]);
    return { deleted: id };
  }

  /** Geocercas activas que contienen el punto (para el motor de alertas). */
  async containing(lat: number, lon: number): Promise<{ id: number; name: string; alert_on: string }[]> {
    const res = await this.db.query(
      `SELECT id, name, alert_on FROM geofences
       WHERE active AND (
         (kind = 'circle'  AND center_lat IS NOT NULL AND
            ST_DWithin(
              ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
              ST_SetSRID(ST_MakePoint(center_lon,center_lat),4326)::geography,
              radius_m))
         OR (kind = 'polygon' AND geom IS NOT NULL AND
            ST_Contains(geom, ST_SetSRID(ST_MakePoint($1,$2),4326)))
       )`,
      [lon, lat],
    );
    return res.rows;
  }
}
