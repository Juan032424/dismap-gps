/**
 * Puente HTTP → H02 para GPSLogger (y cualquier app que sepa hacer un GET).
 *
 * GPSLogger (opción "Log to Customizable URL") llama a este servicio en cada
 * punto GPS; aquí se traduce a una trama H02 y se reenvía por TCP al listener
 * de DISMAP, igual que lo haría un ST-901 físico.
 *
 * La conexión TCP se mantiene abierta y se reconecta sola: los equipos reales
 * también sostienen un socket persistente, y así el dispositivo no aparece
 * conectándose y desconectándose en cada reporte.
 */
const http = require('http');
const net = require('net');

const PORT = parseInt(process.env.BRIDGE_PORT ?? '8088', 10);
const GPS_HOST = process.env.GPS_HOST ?? 'app';
const GPS_PORT = parseInt(process.env.GPS_TCP_PORT ?? '5013', 10);
/** Token compartido: sin esto cualquiera podría inyectar posiciones falsas. */
const TOKEN = process.env.BRIDGE_TOKEN ?? '';

let sock = null;
let conectado = false;
let recibidos = 0;
const pendientes = [];

function conectar() {
  sock = new net.Socket();
  sock.setKeepAlive(true, 30000);
  sock.on('connect', () => {
    conectado = true;
    console.log(`[bridge] TCP conectado a ${GPS_HOST}:${GPS_PORT}`);
    while (pendientes.length && conectado) sock.write(pendientes.shift());
  });
  sock.on('data', () => {});
  sock.on('error', (e) => { conectado = false; console.log('[bridge] TCP error:', e.message); });
  sock.on('close', () => { conectado = false; setTimeout(conectar, 5000); });
  sock.connect(GPS_PORT, GPS_HOST);
}
conectar();

function enviar(trama) {
  if (conectado) { try { sock.write(trama); return true; } catch { /* cae a la cola */ } }
  pendientes.push(trama);
  if (pendientes.length > 500) pendientes.shift(); // no crecer sin límite
  return false;
}

const p = (v, l) => String(v).padStart(l, '0');

/** Grados decimales → DDMM.mmmm / DDDMM.mmmm que exige H02. */
function gradosMinutos(dec, digitosGrado) {
  const abs = Math.abs(dec);
  const grados = Math.floor(abs);
  const minutos = (abs - grados) * 60;
  return p(grados, digitosGrado) + minutos.toFixed(4).padStart(7, '0');
}

function tramaH02({ id, lat, lon, kmh, rumbo, fecha }) {
  const d = fecha ?? new Date();
  const hhmmss = p(d.getUTCHours(), 2) + p(d.getUTCMinutes(), 2) + p(d.getUTCSeconds(), 2);
  const ddmmyy = p(d.getUTCDate(), 2) + p(d.getUTCMonth() + 1, 2) + p(String(d.getUTCFullYear()).slice(2), 2);
  const nudos = (kmh / 1.852).toFixed(2).padStart(6, '0');
  // Bit 10 en 0 = ignición encendida (lógica invertida del protocolo).
  const estado = kmh >= 5 ? 'FFFFFBFF' : 'FFFFFFFF';
  return `*HQ,${id},V1,${hhmmss},A,${gradosMinutos(lat, 2)},${lat >= 0 ? 'N' : 'S'},`
       + `${gradosMinutos(lon, 3)},${lon >= 0 ? 'E' : 'W'},${nudos},${p(Math.round(rumbo || 0), 3)},`
       + `${ddmmyy},${estado}#\r\n`;
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/salud') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ tcp: conectado, recibidos, pendientes: pendientes.length }));
  }

  /* Lote: POST con {"id":"...","puntos":[{lat,lon,kmh,dir,timestamp}, ...]}
     Útil para recuperar tramos que quedaron sin cobertura. */
  if (url.pathname === '/gps/lote' && req.method === 'POST') {
    if (TOKEN && url.searchParams.get('token') !== TOKEN) {
      res.writeHead(401); return res.end('token invalido');
    }
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; if (cuerpo.length > 4e6) req.destroy(); });
    req.on('end', () => {
      let datos;
      try { datos = JSON.parse(cuerpo); } catch { res.writeHead(400); return res.end('json invalido'); }
      const puntos = Array.isArray(datos.puntos) ? datos.puntos : [];
      for (const pt of puntos) {
        if (pt.lat == null || pt.lon == null) continue;
        enviar(tramaH02({
          id: datos.id, lat: +pt.lat, lon: +pt.lon, kmh: +(pt.kmh ?? 0),
          rumbo: +(pt.dir ?? 0), fecha: pt.timestamp ? new Date(pt.timestamp) : new Date(),
        }));
        recibidos++;
      }
      console.log(`[bridge] lote de ${puntos.length} puntos para ${datos.id}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, recibidos: puntos.length }));
    });
    return;
  }

  if (url.pathname !== '/gps') {
    res.writeHead(404); return res.end('no encontrado');
  }

  const q = url.searchParams;

  if (TOKEN && q.get('token') !== TOKEN) {
    res.writeHead(401); return res.end('token invalido');
  }

  const id = q.get('id');
  const lat = num(q.get('lat'));
  const lon = num(q.get('lon'));
  if (!id || lat === null || lon === null) {
    res.writeHead(400); return res.end('faltan id, lat o lon');
  }

  // GPSLogger manda la velocidad en m/s; se acepta km/h por si otra app la usa así.
  const ms = num(q.get('speed'));
  const kmh = q.get('kmh') !== null ? (num(q.get('kmh')) ?? 0) : (ms !== null ? ms * 3.6 : 0);

  // "timestamp" de GPSLogger llega en segundos epoch (a veces en milisegundos).
  const ts = num(q.get('timestamp'));
  const fecha = ts ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date();

  // Se responde ANTES de tocar el socket: la app del celular libera la petición
  // en milisegundos y puede volver a reportar enseguida. Con intervalos de 1-2 s
  // esto evita que las peticiones se encolen en el teléfono.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');

  const entregado = enviar(tramaH02({
    id, lat, lon, kmh, rumbo: num(q.get('dir')) ?? 0, fecha,
  }));

  recibidos++;
  console.log(`[bridge] ${id}  ${lat.toFixed(5)},${lon.toFixed(5)}  ${Math.round(kmh)} km/h  ${entregado ? 'enviado' : 'en cola'}`);
}).listen(PORT, () => console.log(`[bridge] escuchando en :${PORT} → ${GPS_HOST}:${GPS_PORT}`));
