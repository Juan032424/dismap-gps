import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { Role } from '../auth/roles';

export interface UserRow {
  id: number;
  email: string;
  name: string | null;
  role: Role;
  active: boolean;
  created_at: string;
  last_login: string | null;
}

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Crea la tabla y siembra el super admin inicial si no hay usuarios. */
  async onModuleInit() {
    try {
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS users (
          id            SERIAL PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          name          TEXT,
          role          TEXT NOT NULL DEFAULT 'operador',
          active        BOOLEAN NOT NULL DEFAULT true,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_login    TIMESTAMPTZ
        )`);
      await this.seedSuperAdmin();
    } catch (err) {
      this.logger.warn(`No se pudo preparar users: ${(err as Error).message}`);
    }
  }

  private async seedSuperAdmin() {
    const { rows } = await this.db.query('SELECT COUNT(*)::int AS n FROM users');
    if (rows[0].n > 0) return;
    const email = (process.env.SUPERADMIN_EMAIL ?? 'sigae@discolsas.com').toLowerCase();
    // Sin SUPERADMIN_PASSWORD se genera una aleatoria y se muestra UNA vez en
    // el log. Nunca una contraseña por defecto en el código: al ser público
    // sería la misma en todos los despliegues.
    const fromEnv = process.env.SUPERADMIN_PASSWORD;
    const password = fromEnv ?? randomBytes(9).toString('base64url');
    const hash = await bcrypt.hash(password, 10);
    await this.db.query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,'super_admin')`,
      [email, hash, 'Super Admin'],
    );
    this.logger.warn('╔══════════════════════════════════════════════════════╗');
    this.logger.warn(`║ SUPER ADMIN creado → ${email}`);
    this.logger.warn(`║ Contraseña inicial → ${fromEnv ? '(definida en .env)' : password}`);
    this.logger.warn('║ CAMBIA la contraseña tras el primer ingreso.');
    this.logger.warn('╚══════════════════════════════════════════════════════╝');
  }

  async findByEmail(email: string) {
    const { rows } = await this.db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    return rows[0] as (UserRow & { password_hash: string }) | undefined;
  }

  async findById(id: number) {
    const { rows } = await this.db.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] as (UserRow & { password_hash: string }) | undefined;
  }

  async touchLogin(id: number) {
    await this.db.query('UPDATE users SET last_login = now() WHERE id = $1', [id]);
  }

  async list(): Promise<UserRow[]> {
    const { rows } = await this.db.query(
      'SELECT id, email, name, role, active, created_at, last_login FROM users ORDER BY id');
    return rows;
  }

  /** Reglas: admin solo crea operadores; super_admin crea admin/operador/super_admin. */
  async create(
    data: { email: string; name?: string; password: string; role: Role },
    actorRole: Role,
  ): Promise<UserRow> {
    if (!data.email || !data.password) throw new BadRequestException('Email y contraseña son obligatorios');
    if (data.password.length < 6) throw new BadRequestException('La contraseña debe tener al menos 6 caracteres');
    this.assertCanManageRole(actorRole, data.role);
    const hash = await bcrypt.hash(data.password, 10);
    try {
      const { rows } = await this.db.query(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1,$2,$3,$4)
         RETURNING id, email, name, role, active, created_at, last_login`,
        [data.email.toLowerCase(), hash, data.name ?? null, data.role],
      );
      return rows[0];
    } catch (err) {
      if ((err as any).code === '23505') throw new BadRequestException('Ya existe un usuario con ese email');
      throw err;
    }
  }

  async update(
    id: number,
    data: { name?: string; role?: Role; active?: boolean; password?: string },
    actorRole: Role,
  ): Promise<UserRow> {
    const target = await this.findById(id);
    if (!target) throw new NotFoundException('Usuario no encontrado');
    if (data.role) this.assertCanManageRole(actorRole, data.role);
    if (target.role === 'super_admin' && actorRole !== 'super_admin')
      throw new ForbiddenException('Solo un super admin puede modificar a otro super admin');
    const hash = data.password ? await bcrypt.hash(data.password, 10) : null;
    const { rows } = await this.db.query(
      `UPDATE users SET
         name = COALESCE($2, name),
         role = COALESCE($3, role),
         active = COALESCE($4, active),
         password_hash = COALESCE($5, password_hash)
       WHERE id = $1
       RETURNING id, email, name, role, active, created_at, last_login`,
      [id, data.name ?? null, data.role ?? null, data.active ?? null, hash],
    );
    return rows[0];
  }

  /** Cambio de contraseña propia (verifica la actual). */
  async changePassword(id: number, current: string, next: string) {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (!(await bcrypt.compare(current, user.password_hash)))
      throw new ForbiddenException('La contraseña actual no es correcta');
    if (next.length < 6) throw new BadRequestException('La nueva contraseña debe tener al menos 6 caracteres');
    await this.db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, await bcrypt.hash(next, 10)]);
    return { ok: true };
  }

  async remove(id: number, actorId: number) {
    if (id === actorId) throw new BadRequestException('No puedes eliminar tu propia cuenta');
    const target = await this.findById(id);
    if (!target) throw new NotFoundException('Usuario no encontrado');
    await this.db.query('DELETE FROM users WHERE id = $1', [id]);
    return { deleted: id };
  }

  private assertCanManageRole(actorRole: Role, targetRole: Role) {
    if (actorRole === 'super_admin') return;
    if (actorRole === 'admin' && targetRole === 'operador') return;
    throw new ForbiddenException('No tienes permiso para asignar ese rol');
  }
}
