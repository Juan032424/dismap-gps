import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { GeofencesModule } from '../geofences/geofences.module';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';

@Module({
  imports: [RealtimeModule, GeofencesModule],
  providers: [EventsService],
  controllers: [EventsController],
  exports: [EventsService],
})
export class EventsModule {}
