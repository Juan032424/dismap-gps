import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as net from 'net';
import { H02Adapter } from './adapters/h02.adapter';
import { ProtocolAdapter } from './adapters/adapter.interface';
import { PositionsService } from '../positions/positions.service';
import { DevicesService } from '../devices/devices.service';
import { EventsService } from '../events/events.service';

/**
 * Servidor TCP crudo donde los GPS de la flota envían sus tramas.
 * El ST-901 se apunta aquí con el SMS: 804<clave> <IP> <puerto>.
 *
 * Diseño: el socket solo trocea tramas ('*' ... '#') y delega en el
 * adapter que reconozca el formato. TODO lo recibido se registra en
 * crudo (nivel debug) — esa evidencia es la base para validar la
 * compatibilidad exacta con el equipo real.
 */
@Injectable()
export class TcpServerService implements OnModuleDestroy {
  private readonly logger = new Logger(TcpServerService.name);
  private server?: net.Server;
  private readonly adapters: ProtocolAdapter[];

  constructor(
    private readonly h02: H02Adapter,
    private readonly positions: PositionsService,
    private readonly devices: DevicesService,
    private readonly events: EventsService,
  ) {
    // Registrar aquí futuros adapters (GT06, Teltonika, Queclink...)
    this.adapters = [h02];
  }

  listen() {
    const port = parseInt(process.env.TCP_H02_PORT ?? '5013', 10);
    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.listen(port, () =>
      this.logger.log(`Servidor TCP GPS escuchando en puerto ${port}`),
    );
  }

  private handleConnection(socket: net.Socket) {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.log(`GPS conectado: ${remote}`);
    let buffer = '';

    socket.setTimeout(10 * 60 * 1000); // 10 min sin datos → cerrar
    socket.on('timeout', () => socket.destroy());
    socket.on('error', (err) => this.logger.warn(`Socket ${remote}: ${err.message}`));
    socket.on('close', () => this.logger.log(`GPS desconectado: ${remote}`));

    socket.on('data', (chunk) => {
      const text = chunk.toString('ascii');
      this.logger.debug(`RAW ${remote} → ${text.trim()}`); // evidencia cruda, siempre
      buffer += text;
      if (buffer.length > 8192) buffer = ''; // protección contra basura

      let end: number;
      while ((end = buffer.indexOf('#')) !== -1) {
        const start = buffer.indexOf('*');
        const frame = start !== -1 && start < end ? buffer.slice(start, end + 1) : '';
        buffer = buffer.slice(end + 1);
        if (frame) void this.handleFrame(frame, socket, remote);
      }
    });
  }

  private async handleFrame(frame: string, socket: net.Socket, remote: string) {
    const adapter = this.adapters.find((a) => a.matches(frame));
    if (!adapter) {
      this.logger.warn(`Trama sin adapter (${remote}): ${frame}`);
      return;
    }

    const message = adapter.parse(frame);
    if (!message) {
      this.logger.warn(`Trama inválida ${adapter.name} (${remote}): ${frame}`);
      return;
    }

    try {
      switch (message.kind) {
        case 'position':
          if (!message.valid) {
            this.logger.warn(`Posición sin fix GPS (${message.uniqueId}), guardada igual`);
          }
          await this.positions.ingest(message);
          break;

        case 'heartbeat':
          this.logger.log(`Heartbeat ${message.uniqueId} — batería ${message.batteryLevel ?? '?'}%`);
          // ACK primero: la respuesta al equipo no depende de la BD
          if ((process.env.H02_ACK_HEARTBEAT ?? 'true') === 'true') {
            socket.write(this.h02.heartbeatAck(message.uniqueId));
          }
          {
            const dev = await this.devices.heartbeat(message.uniqueId, message.batteryLevel);
            if (dev?.id != null) {
              await this.events.evaluateBattery(message.uniqueId, dev.id, message.batteryLevel);
            }
          }
          break;

        default:
          this.logger.warn(`Tipo de mensaje no soportado (${message.messageType ?? '?'}): ${message.raw}`);
      }
    } catch (err) {
      this.logger.error(`Error procesando trama: ${(err as Error).message}`, (err as Error).stack);
    }
  }

  onModuleDestroy() {
    this.server?.close();
  }
}
