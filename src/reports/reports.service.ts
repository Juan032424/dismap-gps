import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

interface Pt { time: string; latitude: number; longitude: number; speed_kmh: number; ignition: boolean | null; }

function haversineKm(a: Pt, b: Pt): number {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toR;
  const dLon = (b.longitude - a.longitude) * toR;
  const la1 = a.latitude * toR, la2 = b.latitude * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Reportes: convierte el historial crudo de posiciones en información de valor
 * — resumen del período, segmentación en viajes, y perfil de velocidad por hora.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly db: DatabaseService) {}

  private async fetchPositions(deviceId: number, from?: string, to?: string): Promise<Pt[]> {
    const res = await this.db.query(
      `SELECT time, latitude, longitude, speed_kmh, ignition
       FROM positions
       WHERE device_id = $1
         AND time >= COALESCE($2::timestamptz, now() - interval '24 hours')
         AND time <= COALESCE($3::timestamptz, now())
       ORDER BY time ASC LIMIT 20000`,
      [deviceId, from ?? null, to ?? null],
    );
    return res.rows;
  }

  /** Resumen del período + lista de viajes + histograma horario. */
  async summary(deviceId: number, from?: string, to?: string) {
    const pts = await this.fetchPositions(deviceId, from, to);
    if (pts.length < 2) {
      return { deviceId, points: pts.length, distanceKm: 0, maxSpeed: 0, avgSpeed: 0,
        movingMin: 0, stoppedMin: 0, stops: 0, trips: [], hourly: [], first: null, last: null };
    }

    let distanceKm = 0, maxSpeed = 0, sumSpeed = 0, movingSamples = 0;
    let movingMs = 0, stoppedMs = 0, stops = 0;
    const hourly: { hour: number; distanceKm: number; maxSpeed: number; samples: number }[] =
      Array.from({ length: 24 }, (_, h) => ({ hour: h, distanceKm: 0, maxSpeed: 0, samples: 0 }));

    // Segmentación en viajes: un viaje es movimiento continuo; se corta con
    // >5 min detenido o un salto temporal >30 min.
    const trips: any[] = [];
    let trip: any = null;
    const STOP_GAP_MS = 5 * 60 * 1000;
    const TIME_GAP_MS = 30 * 60 * 1000;
    let stoppedSince: number | null = null;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const t = new Date(p.time).getTime();
      const spd = p.speed_kmh ?? 0;
      maxSpeed = Math.max(maxSpeed, spd);
      sumSpeed += spd; movingSamples++;
      const h = new Date(p.time).getHours();
      hourly[h].samples++;
      hourly[h].maxSpeed = Math.max(hourly[h].maxSpeed, spd);

      if (i > 0) {
        const prev = pts[i - 1];
        const dt = t - new Date(prev.time).getTime();
        const d = haversineKm(prev, p);
        distanceKm += d;
        hourly[h].distanceKm += d;
        if (dt < TIME_GAP_MS) {
          if (spd > 2) movingMs += dt; else stoppedMs += dt;
        }
      }

      const moving = spd > 2;
      if (moving) {
        stoppedSince = null;
        if (!trip) trip = { start: p.time, end: p.time, distanceKm: 0, maxSpeed: spd, points: 1,
          startLat: p.latitude, startLon: p.longitude };
        else {
          trip.end = p.time; trip.points++;
          trip.maxSpeed = Math.max(trip.maxSpeed, spd);
          if (i > 0) trip.distanceKm += haversineKm(pts[i - 1], p);
        }
        trip.endLat = p.latitude; trip.endLon = p.longitude;
      } else {
        if (stoppedSince === null) stoppedSince = t;
        if (trip && t - stoppedSince > STOP_GAP_MS) {
          stops++;
          const durMin = (new Date(trip.end).getTime() - new Date(trip.start).getTime()) / 60000;
          trips.push({ ...trip, durationMin: Math.round(durMin), distanceKm: Math.round(trip.distanceKm * 10) / 10, maxSpeed: Math.round(trip.maxSpeed) });
          trip = null;
        }
      }
    }
    if (trip) {
      const durMin = (new Date(trip.end).getTime() - new Date(trip.start).getTime()) / 60000;
      trips.push({ ...trip, durationMin: Math.round(durMin), distanceKm: Math.round(trip.distanceKm * 10) / 10, maxSpeed: Math.round(trip.maxSpeed) });
    }

    return {
      deviceId,
      points: pts.length,
      distanceKm: Math.round(distanceKm * 10) / 10,
      maxSpeed: Math.round(maxSpeed),
      avgSpeed: Math.round(sumSpeed / movingSamples),
      movingMin: Math.round(movingMs / 60000),
      stoppedMin: Math.round(stoppedMs / 60000),
      stops,
      first: pts[0].time,
      last: pts[pts.length - 1].time,
      trips,
      hourly: hourly.map((h) => ({ ...h, distanceKm: Math.round(h.distanceKm * 10) / 10 })),
    };
  }
}
