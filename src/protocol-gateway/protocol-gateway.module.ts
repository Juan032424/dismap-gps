import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { PositionsModule } from '../positions/positions.module';
import { EventsModule } from '../events/events.module';
import { H02Adapter } from './adapters/h02.adapter';
import { TcpServerService } from './tcp-server.service';

@Module({
  imports: [DevicesModule, PositionsModule, EventsModule],
  providers: [H02Adapter, TcpServerService],
  exports: [TcpServerService],
})
export class ProtocolGatewayModule {}
