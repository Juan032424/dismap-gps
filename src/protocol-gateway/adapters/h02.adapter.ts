import { Injectable } from '@nestjs/common';
import { ParsedMessage, ProtocolAdapter } from './adapter.interface';
import { parseH02Frame } from './h02.parser';

/** Adapter del protocolo H02 — SinoTrack ST-901 y familia. */
@Injectable()
export class H02Adapter implements ProtocolAdapter {
  readonly name = 'h02';

  matches(frame: string): boolean {
    return frame.startsWith('*HQ,') || frame.startsWith('*TH,');
  }

  parse(frame: string): ParsedMessage | null {
    return parseH02Frame(frame);
  }

  /**
   * ACK al heartbeat, misma convención de respuesta que usa Traccar:
   * *HQ,<id>,HTBT,HHMMSS#  (hora UTC actual del servidor)
   * Si el equipo real se comporta raro tras el ACK, desactivar con
   * H02_ACK_HEARTBEAT=false y comparar.
   */
  heartbeatAck(uniqueId: string): string {
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const hhmmss = `${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}`;
    return `*HQ,${uniqueId},HTBT,${hhmmss}#`;
  }
}
