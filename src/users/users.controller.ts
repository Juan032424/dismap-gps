import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { UsersService } from './users.service';
import { Roles, CurrentUser } from '../auth/decorators';
import { JwtUser, Role } from '../auth/roles';

@Controller('users')
@Roles('super_admin', 'admin') // operadores no gestionan usuarios
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  create(
    @CurrentUser() actor: JwtUser,
    @Body() body: { email: string; name?: string; password: string; role: Role },
  ) {
    return this.users.create(body, actor.role);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: JwtUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; role?: Role; active?: boolean; password?: string },
  ) {
    return this.users.update(id, body, actor.role);
  }

  @Delete(':id')
  remove(@CurrentUser() actor: JwtUser, @Param('id', ParseIntPipe) id: number) {
    return this.users.remove(id, actor.sub);
  }
}
