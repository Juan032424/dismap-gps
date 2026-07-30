import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { DevicesModule } from './devices/devices.module';
import { PositionsModule } from './positions/positions.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ProtocolGatewayModule } from './protocol-gateway/protocol-gateway.module';
import { GeofencesModule } from './geofences/geofences.module';
import { EventsModule } from './events/events.module';
import { ReportsModule } from './reports/reports.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    RedisModule,
    UsersModule,
    AuthModule,
    DevicesModule,
    PositionsModule,
    RealtimeModule,
    GeofencesModule,
    EventsModule,
    ReportsModule,
    ProtocolGatewayModule,
  ],
})
export class AppModule {}
