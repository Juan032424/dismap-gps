/**
 * Simulador de un SinoTrack ST-901: envía tramas H02 reales al servidor TCP.
 * Permite probar TODO el pipeline (TCP → parser → BD → Redis → WebSocket)
 * sin tener el equipo físico todavía.
 *
 * Uso: node scripts/simulate-st901.js [host] [puerto]
 */
const net = require('net');

const host = process.argv[2] || '127.0.0.1';
const port = parseInt(process.argv[3] || '5013', 10);
const DEVICE_ID = '9170001234';

// Recorrido simulado por la Av. Pedro de Heredia, Cartagena
const route = [
  [10.39972, -75.51444],
  [10.4008, -75.5123],
  [10.40195, -75.5101],
  [10.4031, -75.5079],
  [10.4043, -75.5056],
  [10.4055, -75.5033],
];

const p2 = (n) => String(n).padStart(2, '0');

function toH02(lat, lon) {
  const now = new Date();
  const hhmmss = `${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}`;
  const ddmmyy = `${p2(now.getUTCDate())}${p2(now.getUTCMonth() + 1)}${String(now.getUTCFullYear()).slice(2)}`;
  const coord = (v, degLen) => {
    const abs = Math.abs(v);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return `${String(deg).padStart(degLen, '0')}${min.toFixed(4).padStart(7, '0')}`;
  };
  const speedKnots = (Math.random() * 20 + 5).toFixed(2);
  const course = String(Math.floor(Math.random() * 360)).padStart(3, '0');
  return `*HQ,${DEVICE_ID},V1,${hhmmss},A,${coord(lat, 2)},${lat >= 0 ? 'N' : 'S'},${coord(lon, 3)},${lon >= 0 ? 'E' : 'W'},${speedKnots},${course},${ddmmyy},FFFFFBFF#`;
}

const socket = net.createConnection({ host, port }, () => {
  console.log(`Conectado a ${host}:${port} — enviando una trama cada 5 s (Ctrl+C para salir)`);
  socket.write(`*HQ,${DEVICE_ID},HTBT,93#`); // heartbeat inicial con batería
  let i = 0;
  setInterval(() => {
    const [lat, lon] = route[i % route.length];
    const frame = toH02(lat, lon);
    console.log('→', frame);
    socket.write(frame);
    i++;
  }, 5000);
});

socket.on('data', (d) => console.log('← respuesta del servidor:', d.toString()));
socket.on('error', (e) => console.error('Error:', e.message));
socket.on('close', () => process.exit(0));
