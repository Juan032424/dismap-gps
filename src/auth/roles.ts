/** Roles del sistema DISMAP (jerarquía: super_admin > admin > operador). */
export type Role = 'super_admin' | 'admin' | 'operador';

export const ROLES: Role[] = ['super_admin', 'admin', 'operador'];

/** Etiqueta legible para la interfaz. */
export const ROLE_LABEL: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Administrador',
  operador: 'Operador',
};

export interface JwtUser {
  sub: number;
  email: string;
  role: Role;
  name?: string;
}
