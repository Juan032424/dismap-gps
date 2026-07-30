import { Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** GET /events?deviceId&severity&limit&unack=1 */
  @Get()
  list(
    @Query('deviceId') deviceId?: string,
    @Query('severity') severity?: string,
    @Query('limit') limit?: string,
    @Query('unack') unack?: string,
  ) {
    return this.events.list({
      deviceId: deviceId ? parseInt(deviceId, 10) : undefined,
      severity,
      limit: limit ? parseInt(limit, 10) : undefined,
      unackOnly: unack === '1' || unack === 'true',
    });
  }

  @Patch(':id/ack')
  ack(@Param('id', ParseIntPipe) id: number) {
    return this.events.acknowledge(id);
  }

  @Post('ack-all')
  ackAll() {
    return this.events.acknowledgeAll();
  }
}
