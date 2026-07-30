import { ParsedMessage } from './adapter.interface';

/**
 * Parser del protocolo H02 (texto ASCII) tal como lo habla el SinoTrack ST-901.
 *
 * Trama de posición:
 *   *HQ,<id>,V1,HHMMSS,A|V,DDMM.mmmm,N|S,DDDMM.mmmm,E|W,vel(nudos),rumbo,DDMMYY,status[,extras]#
 * Heartbeat:
 *   *HQ,<id>,HTBT,<bateria %>#
 *
 * Funciones puras y sin dependencias de NestJS → 100% testeables con
 * `npm run test:parser` y fáciles de validar contra tramas reales.
 */

const KNOTS_TO_KMH = 1.852;

/** Convierte DDMM.mmmm / DDDMM.mmmm a grados decimales. Tolera ceros a la izquierda omitidos. */
function parseCoordinate(value: string, hemisphere: string): number | null {
  const dot = value.indexOf('.');
  const degDigits = (dot === -1 ? value.length : dot) - 2; // los minutos siempre son 2 enteros
  if (degDigits <= 0) return null;
  const degrees = parseInt(value.slice(0, degDigits), 10);
  const minutes = parseFloat(value.slice(degDigits));
  if (Number.isNaN(degrees) || Number.isNaN(minutes)) return null;
  let decimal = degrees + minutes / 60;
  if (hemisphere === 'S' || hemisphere === 'W') decimal = -decimal;
  return Math.round(decimal * 1e6) / 1e6;
}

/** El ST-901 reporta en UTC: HHMMSS + DDMMYY. */
function parseDateTime(hhmmss: string, ddmmyy: string): Date | null {
  if (hhmmss.length < 6 || ddmmyy.length < 6) return null;
  const iso =
    `20${ddmmyy.slice(4, 6)}-${ddmmyy.slice(2, 4)}-${ddmmyy.slice(0, 2)}` +
    `T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Campo de estado: 8 dígitos hex con bits INVERTIDOS (0 = evento activo),
 * según la convención H02 que usa Traccar para esta familia de equipos.
 *
 * ⚠️ VALIDACIÓN PENDIENTE CON EL ST-901 REAL (paso 3 del roadmap):
 * con el equipo instalado, encender/apagar el switch y comparar el campo
 * de estado de las tramas para confirmar el bit exacto de ACC. Mientras
 * tanto `status_raw` guarda siempre el valor crudo para no perder nada.
 */
function parseStatus(statusHex: string): { ignition: boolean | null; alarms: string[] } {
  const status = parseInt(statusHex, 16);
  if (Number.isNaN(status)) return { ignition: null, alarms: [] };
  const bit = (n: number) => ((status >>> n) & 1) === 1;
  const alarms: string[] = [];
  if (!bit(0)) alarms.push('vibracion');
  if (!bit(1)) alarms.push('sos');
  if (!bit(2)) alarms.push('exceso_velocidad');
  if (!bit(19)) alarms.push('corte_energia');
  return { ignition: !bit(10), alarms };
}

export function parseH02Frame(frame: string): ParsedMessage | null {
  const raw = frame.trim();
  if (!raw.startsWith('*') || !raw.endsWith('#')) return null;

  const parts = raw.slice(1, -1).split(',');
  if (parts.length < 3) return null;
  const uniqueId = parts[1];
  const messageType = parts[2];

  // Heartbeat del ST-901 con % de batería
  if (messageType === 'HTBT') {
    const battery = parts.length > 3 ? parseInt(parts[3], 10) : NaN;
    return {
      kind: 'heartbeat',
      protocol: 'h02',
      uniqueId,
      batteryLevel: Number.isNaN(battery) ? null : battery,
      raw,
    };
  }

  // Posición V1
  if (messageType === 'V1' && parts.length >= 13) {
    const time = parseDateTime(parts[3], parts[11]);
    const latitude = parseCoordinate(parts[5], parts[6]);
    const longitude = parseCoordinate(parts[7], parts[8]);
    if (!time || latitude === null || longitude === null) {
      return { kind: 'unknown', protocol: 'h02', uniqueId, messageType, raw };
    }
    const speedKmh = Math.round((parseFloat(parts[9]) || 0) * KNOTS_TO_KMH * 10) / 10;
    const course = parseFloat(parts[10]) || 0;
    const { ignition, alarms } = parseStatus(parts[12]);

    return {
      kind: 'position',
      protocol: 'h02',
      uniqueId,
      time,
      valid: parts[4] === 'A',
      latitude,
      longitude,
      speedKmh,
      course,
      ignition,
      alarms,
      statusRaw: parts[12],
      raw,
    };
  }

  return { kind: 'unknown', protocol: 'h02', uniqueId, messageType, raw };
}
