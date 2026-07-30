import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

/**
 * WebSocket (Socket.IO) para el mapa en vivo. Requiere un token JWT válido
 * en el handshake (`auth.token`) — el mismo que usa el resto de la API.
 * Emite `position` (posiciones) y `event` (alertas).
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(private readonly jwt: JwtService) {}

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    const token = client.handshake.auth?.token || client.handshake.query?.token;
    try {
      const user = this.jwt.verify(String(token));
      (client.data as any).user = user;
      this.logger.log(`Cliente en vivo conectado: ${client.id} (${(user as any).email})`);
    } catch {
      this.logger.warn(`Cliente rechazado (token inválido): ${client.id}`);
      client.emit('unauthorized', { message: 'Token inválido o ausente' });
      client.disconnect(true);
    }
  }

  emitPosition(payload: unknown) {
    this.server?.emit('position', payload);
  }

  /** Alerta en vivo (exceso de velocidad, SOS, geocerca, batería…). */
  emitEvent(payload: unknown) {
    this.server?.emit('event', payload);
  }
}
