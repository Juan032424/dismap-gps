import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { GeofencesService, GeofenceInput } from './geofences.service';
import { Roles } from '../auth/decorators';

@Controller('geofences')
export class GeofencesController {
  constructor(private readonly geofences: GeofencesService) {}

  @Get()
  list() {
    return this.geofences.list();
  }

  @Post()
  @Roles('super_admin', 'admin')
  create(@Body() body: GeofenceInput) {
    return this.geofences.create(body);
  }

  @Patch(':id')
  @Roles('super_admin', 'admin')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: Partial<GeofenceInput>) {
    return this.geofences.update(id, body);
  }

  @Delete(':id')
  @Roles('super_admin', 'admin')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.geofences.remove(id);
  }
}
