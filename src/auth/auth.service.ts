import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { JwtUser } from './roles';

@Injectable()
export class AuthService {
  constructor(private readonly users: UsersService, private readonly jwt: JwtService) {}

  /** Valida credenciales y devuelve el token + datos del usuario. */
  async login(email: string, password: string) {
    if (!email || !password) throw new UnauthorizedException('Credenciales incompletas');
    const user = await this.users.findByEmail(email);
    if (!user || !user.active) throw new UnauthorizedException('Usuario o contraseña incorrectos');
    if (!(await bcrypt.compare(password, user.password_hash)))
      throw new UnauthorizedException('Usuario o contraseña incorrectos');

    await this.users.touchLogin(user.id);
    const payload: JwtUser = { sub: user.id, email: user.email, role: user.role, name: user.name ?? undefined };
    return {
      token: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }

  /** Datos del usuario autenticado (para /auth/me). */
  async me(userId: number) {
    const u = await this.users.findById(userId);
    if (!u) throw new UnauthorizedException();
    return { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, last_login: u.last_login };
  }
}
