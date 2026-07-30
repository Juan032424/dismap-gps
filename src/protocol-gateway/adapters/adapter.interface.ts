/** Mensaje de posición ya normalizado, independiente del fabricante del GPS. */
export interface ParsedPosition {
  kind: 'position';
  protocol: string;
  uniqueId: string;
  time: Date;
  valid: boolean;      // A = fix GPS válido, V = inválido
  latitude: number;
  longitude: number;
  speedKmh: number;
  course: number;      // rumbo en grados (0-359)
  ignition: boolean | null;
  alarms: string[];
  statusRaw: string;   // campo de estado sin interpretar (auditoría)
  raw: string;         // trama original completa
}

export interface ParsedHeartbeat {
  kind: 'heartbeat';
  protocol: string;
  uniqueId: string;
  batteryLevel: number | null; // % de batería (ST-901 lo envía en HTBT)
  raw: string;
}

export interface ParsedUnknown {
  kind: 'unknown';
  protocol: string;
  uniqueId?: string;
  messageType?: string;
  raw: string;
}

export type ParsedMessage = ParsedPosition | ParsedHeartbeat | ParsedUnknown;

/**
 * Patrón Adapter: cada fabricante/protocolo GPS implementa esta interfaz.
 * Para soportar un equipo nuevo (GT06, Teltonika, Queclink...) se crea un
 * adapter nuevo y se registra en TcpServerService — sin tocar el resto.
 */
export interface ProtocolAdapter {
  readonly name: string;
  /** ¿Esta trama pertenece a este protocolo? */
  matches(frame: string): boolean;
  parse(frame: string): ParsedMessage | null;
}
