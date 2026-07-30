import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { Roles } from '../auth/decorators';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** GET /devices — flota completa con última posición (cualquier usuario autenticado). */
  @Get()
  list() {
    return this.devices.list();
  }

  /** GET /devices/config — datos del servidor para armar los SMS de configuración
   *  del equipo (IP/puerto donde debe reportar). Va antes de las rutas :id. */
  @Get('config')
  config() {
    return {
      gpsHost: process.env.PUBLIC_HOST || null, // si es null, el panel usa el host del navegador
      gpsPort: parseInt(process.env.TCP_H02_PORT ?? '5013', 10),
      smsPassword: process.env.GPS_SMS_PASSWORD ?? '0000', // clave por defecto del ST-901
    };
  }

  /** POST /devices — registrar/provisionar un GPS con su configuración (solo admin). */
  @Post()
  @Roles('super_admin', 'admin')
  provision(
    @Body() body: {
      unique_id: string; name?: string; plate?: string; model?: string; protocol?: string;
      sim_number?: string; apn?: string; speed_limit?: number; driver?: string; notes?: string;
    },
  ) {
    return this.devices.provision(body);
  }

  /** PATCH /devices/:id — editar ficha del vehículo (solo admin). */
  @Patch(':id')
  @Roles('super_admin', 'admin')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; plate?: string; speed_limit?: number; driver?: string; notes?: string },
  ) {
    return this.devices.update(id, body);
  }

  /** DELETE /devices/:id — eliminar un vehículo y su historial (solo admin). */
  @Delete(':id')
  @Roles('super_admin', 'admin')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.devices.remove(id);
  }
}
