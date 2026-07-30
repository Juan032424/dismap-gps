# Despliegue en producción (Teramont Host) — DISMAP GPS

Guía para dejar el sistema corriendo en tu servidor con Docker. Todo el stack
(app + PostgreSQL/PostGIS/TimescaleDB + Redis) queda en contenedores.

## 0. Requisitos en el servidor

- Un VPS Linux (Ubuntu/Debian recomendado) con acceso SSH.
- **Docker** y **Docker Compose** instalados. Para instalarlos:
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER    # re-inicia sesión SSH tras esto
  ```
- **Puertos abiertos** en el firewall/panel de Teramont:
  - **80** (TCP) — panel web / API.
  - **5013** (TCP) — donde reportan los GPS ST-901.
  - **22** (SSH) — administración.

## 1. Subir el proyecto al servidor

Opción A — con Git (si lo tienes en un repositorio):
```bash
ssh usuario@IP_DEL_SERVIDOR
git clone <URL_DEL_REPO> dismap-gps && cd dismap-gps
```

Opción B — copiar desde tu PC con SCP (en PowerShell, desde la carpeta del proyecto):
```powershell
scp -r . usuario@IP_DEL_SERVIDOR:/home/usuario/dismap-gps
```
> Si usas SCP, borra primero `node_modules` local para que suba rápido; el
> servidor lo reconstruye solo. `.env` no se sube (está en `.dockerignore`).

## 2. Configurar variables de producción

En el servidor, dentro de la carpeta del proyecto:
```bash
cp .env.prod.example .env
nano .env
```
Rellena:
- `POSTGRES_PASSWORD` — una clave fuerte para la base.
- `JWT_SECRET` — genera una única:  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
  (o `openssl rand -hex 48`).
- `SUPERADMIN_EMAIL` y `SUPERADMIN_PASSWORD` — el primer super admin.

## 3. Levantar el sistema

```bash
docker compose -f docker-compose.prod.yml up -d --build
```
Primera vez tarda unos minutos (construye la imagen). Comprueba que arrancó:
```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f app
```
En el log del `app` verás el recuadro con el **super admin creado**. Ya puedes
cerrar los logs con `Ctrl+C` (los contenedores siguen corriendo).

## 4. Entrar al panel

Abre en el navegador:  `http://IP_DEL_SERVIDOR`  (puerto 80).
Inicia sesión con el `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` del `.env`.
**Cambia la contraseña** al entrar (menú de usuario) y crea los admins/operadores
y registra los dispositivos desde el botón de **Administración** (⚙).

## 5. Apuntar los GPS al servidor

Por SMS a la SIM de cada ST-901 (ver README para la tabla completa):
```
804<clave> IP_DEL_SERVIDOR 5013
```
En cuanto reporten, aparecen en el mapa. Si los registraste antes en el panel,
ya salen con su placa, conductor y límite de velocidad.

## 6. (Recomendado) Dominio + HTTPS

Para usar un dominio (ej. `gps.discol.com`) con candado HTTPS, lo más simple es
poner **Caddy** como reverse proxy delante (obtiene el certificado solo):

1. Cambia en `docker-compose.prod.yml` el puerto del `app` de `"80:3000"` a
   `"3000:3000"` (deja de publicar el 80 directo).
2. Añade un servicio Caddy con un `Caddyfile`:
   ```
   gps.discol.com {
       reverse_proxy dismap-app:3000
   }
   ```
   (apunta el DNS del dominio a la IP del servidor primero).
3. El puerto **5013** de los GPS sigue igual (TCP directo, sin HTTPS).

Si quieres, te preparo el servicio de Caddy listo cuando tengas el dominio.

## Despliegue automático (CI/CD con GitHub Actions)

Desde que el proyecto vive en GitHub, cada `git push` a `main` dispara
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): sincroniza el
código al VPS por SSH (`rsync`, sin tocar el `.env` del servidor) y ejecuta
`docker compose -f docker-compose.prod.yml up -d --build`. Ya no hace falta
subir manualmente con SCP.

**Configuración única (una sola vez):**

1. Abre en el navegador, ya logueado como `Juan032424`:
   `https://github.com/Juan032424/dismap-gps/settings/secrets/actions`
2. **New repository secret** → nombre `DEPLOY_SSH_KEY` → en "Value" pega el
   contenido completo de la llave privada del servidor (incluyendo las líneas
   `-----BEGIN...` y `-----END...`). Para verla en tu PC sin exponerla en
   ningún chat:
   ```powershell
   notepad $env:USERPROFILE\.ssh\dismap_dev
   ```
   Selecciona todo (Ctrl+A), copia (Ctrl+C) y pégalo directo en GitHub.
3. Guarda. Con eso el pipeline queda armado — no se necesita ningún otro secreto
   (el host y el usuario están fijos en el propio workflow).

**Seguimiento:** pestaña **Actions** del repositorio en GitHub — cada push
muestra ahí el progreso y el log de la sincronización y el build. También se
puede lanzar a mano con el botón **Run workflow** (usa `workflow_dispatch`).

**Importante:** el `.env` real del servidor (contraseñas, `JWT_SECRET`) nunca
se toca ni se sube — está excluido del `rsync` a propósito. Si cambias
variables de entorno, sigue haciéndose a mano por SSH.

## Operación diaria

```bash
# Ver estado / logs
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f app

# Actualizar tras cambios de código
git pull   # o volver a subir por SCP
docker compose -f docker-compose.prod.yml up -d --build

# Reiniciar / detener
docker compose -f docker-compose.prod.yml restart app
docker compose -f docker-compose.prod.yml down     # detiene todo (los datos se conservan en el volumen)
```

## Respaldo de la base de datos

```bash
docker exec dismap-db pg_dump -U postgres dismap > dismap_backup_$(date +%F).sql
```
