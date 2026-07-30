import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { Public, CurrentUser } from './decorators';
import { JwtUser } from './roles';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly users: UsersService) {}

  @Public()
  @Post('login')
  login(@Body() body: { email: string; password: string }) {
    return this.auth.login(body?.email, body?.password);
  }

  @Get('me')
  me(@CurrentUser() user: JwtUser) {
    return this.auth.me(user.sub);
  }

  @Post('change-password')
  changePassword(@CurrentUser() user: JwtUser, @Body() body: { current: string; next: string }) {
    return this.users.changePassword(user.sub, body?.current, body?.next);
  }
}
