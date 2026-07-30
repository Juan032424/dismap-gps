/* DISMAP GPS — Centro de control de flota (frontend). Sin dependencias de build. */
'use strict';

/* ============================ Mapa ============================ */
const map = L.map('map', { zoomControl: true }).setView([10.4, -75.5], 12);
const baseLayers = {
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap &copy; CARTO' }),
  sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' }),
  streets: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap &copy; CARTO' }),
};
let currentBase = 'dark';
baseLayers.dark.addTo(map);
const layerLabels = { dark: 'Oscuro', sat: 'Satélite', streets: 'Calles' };
const layerCtl = L.control({ position: 'topright' });
layerCtl.onAdd = () => {
  const d = L.DomUtil.create('div', 'leaflet-bar');
  d.innerHTML = '<a href="#" title="Cambiar mapa" style="width:auto;padding:0 8px;font:600 12px sans-serif">Mapa: Oscuro</a>';
  L.DomEvent.disableClickPropagation(d);
  d.onclick = (e) => {
    e.preventDefault();
    map.removeLayer(baseLayers[currentBase]);
    currentBase = currentBase === 'dark' ? 'sat' : currentBase === 'sat' ? 'streets' : 'dark';
    baseLayers[currentBase].addTo(map);
    d.firstChild.textContent = 'Mapa: ' + layerLabels[currentBase];
    return false;
  };
  return d;
};
layerCtl.addTo(map);

/* ============================ Estado ============================ */
const OFFLINE_MIN = 10;
const fleet = new Map();       // uniqueId -> { data, marker, trail, row }
const geofences = new Map();   // id -> { data, layer }
let events = [];
let selected = null, followUid = null, filter = 'all', query = '', centered = false, showLabels = false;
let routeLayer = null, routePoints = [];

const $ = (id) => document.getElementById(id);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

let toastT = null;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', 2800); }
function banner(msg) { const b = $('banner'); b.style.display = msg ? 'block' : 'none'; b.textContent = msg || ''; }

/* ============================ Utilidades ============================ */
function fmtTime(t) { return t ? new Date(t).toLocaleString('es-CO', { hour12: false }) : '—'; }
function fmtHM(t) { return t ? new Date(t).toLocaleTimeString('es-CO', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—'; }
function relTime(t) {
  if (!t) return '—';
  const s = Math.floor((Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return 'hace ' + s + 's';
  if (s < 3600) return 'hace ' + Math.floor(s / 60) + ' min';
  if (s < 86400) return 'hace ' + Math.floor(s / 3600) + ' h';
  return 'hace ' + Math.floor(s / 86400) + ' d';
}
function statusOf(d) {
  const last = d.time ? new Date(d.time).getTime() : 0;
  if (Date.now() - last > OFFLINE_MIN * 60000) return 'off';
  return (d.speedKmh ?? 0) > 2 ? 'mov' : 'stop';
}
function haversine(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR, la1 = a[0] * toR, la2 = b[0] * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const ALARM_LABEL = { sos: '🆘 SOS', corte_energia: '⚡ Corte energía', vibracion: '📳 Vibración', exceso_velocidad: '⚠️ Exceso vel.' };

/* ============================ Marcadores ============================ */
function vehicleIcon(d) {
  const st = statusOf(d);
  const color = st === 'off' ? '#4A5D78' : st === 'mov' ? '#16B364' : '#8497B0';
  const label = showLabels ? `<div class="label">${d.plate || d.name || d.uniqueId}</div>` : '';
  return L.divIcon({
    className: '', iconSize: [28, 28], iconAnchor: [14, 14],
    html: `<div class="veh" style="transform:rotate(${d.course || 0}deg)">
      <svg width="20" height="20" viewBox="0 0 20 20"><path d="M10 1 L16 17 L10 13 L4 17 Z" fill="${color}"/></svg>
      </div>${label}`,
  });
}
function popupHtml(d) {
  return `<b>${d.name || 'ST-901 ' + d.uniqueId}</b>${d.plate ? ' · ' + d.plate : ''}<br>
    ${d.speedKmh ?? '—'} km/h · Rumbo ${Math.round(d.course ?? 0)}°<br>
    Motor: ${d.ignition === true ? 'encendido' : d.ignition === false ? 'apagado' : '—'}${d.battery != null ? ' · 🔋 ' + d.battery + '%' : ''}<br>
    ${fmtTime(d.time)}`;
}

/* ============================ Flota ============================ */
function upsert(d) {
  let v = fleet.get(d.uniqueId);
  if (!v) {
    const row = el('div', 'row');
    row.onclick = () => select(d.uniqueId, true);
    $('fleet').appendChild(row);
    v = { data: {}, marker: null, trail: L.polyline([], { color: '#1E7FEF', weight: 3, opacity: .55 }).addTo(map), row };
    fleet.set(d.uniqueId, v);
  }
  v.data = { ...v.data, ...d };
  const { latitude, longitude } = v.data;
  if (latitude != null && longitude != null) {
    if (!v.marker) {
      v.marker = L.marker([latitude, longitude]).addTo(map);
      v.marker.on('click', () => select(d.uniqueId, false));
    }
    v.marker.setLatLng([latitude, longitude]);
    v.marker.setIcon(vehicleIcon(v.data));
    v.marker.bindPopup(popupHtml(v.data));
    v.trail.addLatLng([latitude, longitude]);
    if (v.trail.getLatLngs().length > 500) v.trail.setLatLngs(v.trail.getLatLngs().slice(-500));
    if (!centered) { map.setView([latitude, longitude], 14); centered = true; }
    if (followUid === d.uniqueId) map.panTo([latitude, longitude]);
  }
  renderRow(v);
  if (selected === d.uniqueId) renderDetail(v.data);
  refreshStats();
}

function renderRow(v) {
  const d = v.data, st = statusOf(d);
  const cls = st === 'off' ? 'off' : st === 'mov' ? 'on' : '';
  const chip = st === 'mov' ? '<span class="chip mov">MOVIMIENTO</span>' : st === 'off' ? '<span class="chip off">SIN SEÑAL</span>' : '<span class="chip stop">DETENIDO</span>';
  const alarms = (d.alarms || []).length ? ' <span class="chip off">' + (d.alarms.includes('sos') ? '🆘' : '⚠') + '</span>' : '';
  v.row.innerHTML = `
    <div class="top">
      <div class="ign ${cls}"></div>
      <div class="name">${d.name || 'ST-901 ' + d.uniqueId}</div>
      ${d.plate ? '<div class="plate">' + d.plate + '</div>' : ''}
    </div>
    <div class="sub">${chip}${alarms} <span>${d.speedKmh ?? 0} km/h</span> · <span>${relTime(d.time)}</span></div>`;
  v.row.classList.toggle('sel', selected === d.uniqueId);
  applyRowVisibility(v);
}
function applyRowVisibility(v) {
  const d = v.data;
  const q = !query || (d.name || '').toLowerCase().includes(query) || (d.plate || '').toLowerCase().includes(query) || String(d.uniqueId).includes(query);
  const f = filter === 'all' || statusOf(d) === filter;
  v.row.style.display = (q && f) ? '' : 'none';
}
function select(uid, pan) {
  selected = uid;
  fleet.forEach((v, k) => v.row.classList.toggle('sel', k === uid));
  const v = fleet.get(uid); if (!v) return;
  if (pan && v.data.latitude != null) { map.panTo([v.data.latitude, v.data.longitude]); if (v.marker) v.marker.openPopup(); }
  renderDetail(v.data);
  $('alerts').classList.remove('open');
  $('detail').classList.add('open');
}
function refreshStats() {
  let mov = 0, stop = 0, off = 0, shown = 0;
  fleet.forEach((v) => {
    const st = statusOf(v.data);
    if (st === 'off') off++; else if (st === 'mov') mov++; else stop++;
    if (v.row.style.display !== 'none') shown++;
  });
  $('s-total').textContent = fleet.size; $('s-mov').textContent = mov; $('s-stop').textContent = stop; $('s-off').textContent = off;
  $('fleet-count').textContent = shown + '/' + fleet.size;
}

/* ============================ Panel de detalle ============================ */
function selData() { const v = selected && fleet.get(selected); return v ? v.data : null; }
function renderDetail(d) {
  $('dt-name').textContent = (d.name || 'ST-901 ' + d.uniqueId) + (d.plate ? ' · ' + d.plate : '');
  const st = statusOf(d);
  $('dt-ign').className = 'ign ' + (st === 'off' ? 'off' : st === 'mov' ? 'on' : '');
  $('dt-speed').innerHTML = (d.speedKmh ?? '—') + ' <small>km/h</small>';
  $('dt-course').textContent = Math.round(d.course ?? 0) + '°';
  $('dt-compass').style.transform = `rotate(${d.course || 0}deg)`;
  $('dt-ignition').textContent = d.ignition === true ? 'Encendido' : d.ignition === false ? 'Apagado' : '—';
  $('dt-ignition').style.color = d.ignition ? 'var(--ok)' : 'var(--text)';
  $('dt-battery').textContent = d.battery != null ? d.battery + '%' : '—';
  $('dt-valid').textContent = d.valid === true ? 'Válida' : d.valid === false ? 'Sin fix' : '—';
  $('dt-valid').style.color = d.valid === false ? 'var(--danger)' : 'var(--text)';
  $('dt-since').textContent = relTime(d.time);
  $('dt-follow').textContent = followUid === d.uniqueId ? '● Siguiendo' : 'Seguir';
  $('dt-follow').classList.toggle('primary', followUid === d.uniqueId);
  // Badges: estado + conductor + límite + alarmas
  const b = [];
  b.push(`<span class="abadge ${st === 'mov' ? 'on' : ''}">${st === 'mov' ? 'En movimiento' : st === 'off' ? 'Sin señal' : 'Detenido'}</span>`);
  if (d.driver) b.push(`<span class="abadge">👤 ${d.driver}</span>`);
  if (d.speed_limit) b.push(`<span class="abadge">Límite ${d.speed_limit}</span>`);
  (d.alarms || []).forEach((a) => b.push(`<span class="abadge crit">${ALARM_LABEL[a] || a}</span>`));
  $('dt-badges').innerHTML = b.join('');
}

$('dt-close').onclick = () => $('detail').classList.remove('open');
$('dt-follow').onclick = () => {
  const d = selData(); if (!d) return;
  followUid = followUid === d.uniqueId ? null : d.uniqueId;
  if (followUid && d.latitude != null) map.setView([d.latitude, d.longitude], Math.max(map.getZoom(), 15));
  renderDetail(d); toast(followUid ? 'Siguiendo al vehículo' : 'Seguimiento desactivado');
};
$('dt-copy').onclick = () => {
  const d = selData(); if (!d || d.latitude == null) return toast('Sin coordenadas.');
  navigator.clipboard.writeText(`${d.latitude}, ${d.longitude}`).then(() => toast('Coordenadas copiadas.'));
};
$('dt-gmaps').onclick = () => {
  const d = selData(); if (!d || d.latitude == null) return toast('Sin coordenadas.');
  window.open(`https://www.google.com/maps?q=${d.latitude},${d.longitude}`, '_blank');
};
$('dt-addr-btn').onclick = async () => {
  const d = selData(); if (!d || d.latitude == null) return toast('Sin coordenadas.');
  $('dt-addr').textContent = 'Resolviendo dirección…';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${d.latitude}&lon=${d.longitude}`, { headers: { 'Accept-Language': 'es' } });
    $('dt-addr').textContent = (await r.json()).display_name || 'Dirección no disponible.';
  } catch { $('dt-addr').textContent = 'No se pudo resolver la dirección (sin internet).'; }
};

/* ---- Editar ficha ---- */
$('dt-edit-btn').onclick = () => {
  const d = selData(); if (!d) return;
  $('dt-in-name').value = d.name && !String(d.name).startsWith('ST-901') ? d.name : '';
  $('dt-in-plate').value = d.plate || '';
  $('dt-in-driver').value = d.driver || '';
  $('dt-in-limit').value = d.speed_limit || '';
  $('dt-in-notes').value = d.notes || '';
  $('dt-editform').classList.add('open');
};
$('dt-cancel').onclick = () => $('dt-editform').classList.remove('open');
$('dt-save').onclick = async () => {
  const d = selData(); if (!d || d.deviceId == null) return toast('Equipo aún no registrado en la base.');
  const body = {
    name: $('dt-in-name').value.trim() || undefined,
    plate: $('dt-in-plate').value.trim().toUpperCase() || undefined,
    driver: $('dt-in-driver').value.trim() || undefined,
    speed_limit: $('dt-in-limit').value ? parseInt($('dt-in-limit').value, 10) : undefined,
    notes: $('dt-in-notes').value.trim() || undefined,
  };
  try {
    const r = await fetch(`/devices/${d.deviceId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(r.status);
    upsert({ uniqueId: d.uniqueId, ...body });
    $('dt-editform').classList.remove('open'); toast('Ficha guardada.');
  } catch { toast('No se pudo guardar (¿base de datos apagada?).'); }
};

/* ============================ Recorrido + estadísticas ============================ */
async function loadRoute() {
  const d = selData();
  if (!d || d.deviceId == null) { toast('Selecciona un vehículo registrado.'); return null; }
  try {
    const rows = await (await fetch(`/devices/${d.deviceId}/positions?limit=5000`)).json();
    if (!rows.length) { toast('Sin posiciones en las últimas 24 h.'); return null; }
    routePoints = rows.map((p) => ({ lat: p.latitude, lon: p.longitude, t: p.time, speed: p.speed_kmh }));
    return routePoints;
  } catch { toast('No se pudo cargar el recorrido.'); return null; }
}
function drawRoute(pts) {
  if (routeLayer) map.removeLayer(routeLayer);
  const ll = pts.map((p) => [p.lat, p.lon]);
  routeLayer = L.layerGroup([
    L.polyline(ll, { color: '#1E7FEF', weight: 3, dashArray: '6 6' }),
    L.circleMarker(ll[0], { radius: 6, color: '#16B364', fillColor: '#16B364', fillOpacity: 1 }).bindTooltip('Inicio'),
    L.circleMarker(ll[ll.length - 1], { radius: 6, color: '#E5484D', fillColor: '#E5484D', fillOpacity: 1 }).bindTooltip('Fin'),
  ]).addTo(map);
  map.fitBounds(L.polyline(ll).getBounds(), { padding: [40, 40] });
}
function computeStats(pts) {
  let dist = 0, maxS = 0, sumS = 0, stops = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) dist += haversine([pts[i - 1].lat, pts[i - 1].lon], [pts[i].lat, pts[i].lon]);
    const s = pts[i].speed ?? 0; maxS = Math.max(maxS, s); sumS += s;
    if (s <= 2 && i > 0 && (pts[i - 1].speed ?? 0) > 2) stops++;
  }
  $('rs-dist').textContent = dist.toFixed(1) + ' km';
  $('rs-max').textContent = Math.round(maxS) + ' km/h';
  $('rs-avg').textContent = Math.round(sumS / pts.length) + ' km/h';
  $('rs-stops').textContent = stops;
  $('dt-route-stats').classList.add('open');
}
$('dt-route').onclick = async () => { const pts = await loadRoute(); if (!pts) return; drawRoute(pts); computeStats(pts); };
$('dt-clear').onclick = () => {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  $('dt-route-stats').classList.remove('open'); stopPlayer();
};
$('dt-export').onclick = async () => {
  const pts = routePoints.length ? routePoints : await loadRoute(); if (!pts || !pts.length) return;
  const d = selData();
  const trk = pts.map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}"><time>${p.t}</time></trkpt>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="DISMAP GPS"><trk><name>${(d.name || d.uniqueId)} 24h</name><trkseg>\n${trk}\n</trkseg></trk></gpx>`;
  downloadFile(`${(d.plate || d.uniqueId)}-recorrido.gpx`, gpx, 'application/gpx+xml');
  toast('GPX exportado.');
};
function downloadFile(name, content, type) {
  const a = el('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click();
}

/* ============================ Reproductor de viaje ============================ */
let playMarker = null, playTimer = null, playIdx = 0, playSpeed = 1, playing = false;
$('dt-play').onclick = async () => {
  const pts = routePoints.length ? routePoints : await loadRoute();
  if (!pts || pts.length < 2) return;
  if (!routeLayer) { drawRoute(pts); computeStats(pts); }
  $('pl-range').max = pts.length - 1; playIdx = 0; $('pl-range').value = 0;
  if (!playMarker) playMarker = L.marker([pts[0].lat, pts[0].lon]).addTo(map); else playMarker.addTo(map);
  $('player').classList.add('open'); renderFrame(); play();
};
function renderFrame() {
  const p = routePoints[playIdx]; if (!p) return;
  playMarker.setLatLng([p.lat, p.lon]);
  playMarker.setIcon(vehicleIcon({ course: 0, speedKmh: p.speed, time: Date.now() }));
  $('pl-clock').textContent = fmtTime(p.t); $('pl-idx').textContent = (p.speed ?? 0) + ' km/h';
  $('pl-range').value = playIdx;
  if ($('detail').classList.contains('open')) map.panTo([p.lat, p.lon]);
}
function step() { if (playIdx >= routePoints.length - 1) { pause(); return; } playIdx++; renderFrame(); }
function play() { playing = true; $('pl-play').textContent = '❚❚'; clearInterval(playTimer); playTimer = setInterval(step, 600 / playSpeed); }
function pause() { playing = false; $('pl-play').textContent = '▶'; clearInterval(playTimer); }
function stopPlayer() { pause(); $('player').classList.remove('open'); if (playMarker) { map.removeLayer(playMarker); playMarker = null; } }
$('pl-play').onclick = () => (playing ? pause() : play());
$('pl-close').onclick = stopPlayer;
$('pl-range').oninput = (e) => { playIdx = +e.target.value; renderFrame(); };
document.querySelectorAll('.spd button').forEach((btn) => btn.onclick = () => {
  document.querySelectorAll('.spd button').forEach((x) => x.classList.remove('active'));
  btn.classList.add('active'); playSpeed = +btn.dataset.spd; if (playing) play();
});

/* ============================ Reportes ============================ */
$('dt-report').onclick = async () => {
  const d = selData(); if (!d || d.deviceId == null) return toast('Selecciona un vehículo registrado.');
  $('report-modal').classList.add('open');
  $('rp-title').textContent = 'Reporte 24 h · ' + (d.name || d.uniqueId) + (d.plate ? ' (' + d.plate + ')' : '');
  $('rp-body').textContent = 'Cargando…';
  try {
    const rep = await (await fetch(`/devices/${d.deviceId}/report`)).json();
    renderReport(rep);
  } catch { $('rp-body').textContent = 'No se pudo generar el reporte (¿base de datos apagada?).'; }
};
$('rp-close').onclick = () => $('report-modal').classList.remove('open');

function renderReport(r) {
  const kpi = (k, v, u) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v} <small>${u || ''}</small></div></div>`;
  const kpis = `<div class="kpis">
    ${kpi('Distancia', r.distanceKm, 'km')}
    ${kpi('Vel. máxima', r.maxSpeed, 'km/h')}
    ${kpi('Vel. media', r.avgSpeed, 'km/h')}
    ${kpi('Paradas', r.stops, '')}
    ${kpi('En marcha', r.movingMin, 'min')}
    ${kpi('Detenido', r.stoppedMin, 'min')}
    ${kpi('Viajes', (r.trips || []).length, '')}
    ${kpi('Muestras', r.points, '')}
  </div>`;

  const chart = hourlyChart(r.hourly || []);

  const trips = (r.trips || []).length ? `
    <table class="trips"><thead><tr><th>#</th><th>Inicio</th><th>Fin</th><th>Duración</th><th>Distancia</th><th>Máx</th></tr></thead>
    <tbody>${r.trips.map((t, i) => `<tr><td>${i + 1}</td><td>${fmtHM(t.start)}</td><td>${fmtHM(t.end)}</td><td>${t.durationMin} min</td><td>${t.distanceKm} km</td><td>${t.maxSpeed} km/h</td></tr>`).join('')}</tbody></table>` :
    '<div class="al-empty">Sin viajes detectados en el período.</div>';

  $('rp-body').innerHTML = kpis +
    `<div class="chart-wrap"><div class="chart-title">Distancia por hora (km) y velocidad máxima</div>${chart}</div>` +
    `<div class="chart-title" style="margin-bottom:8px">Viajes del período</div>` + trips +
    `<div style="margin-top:14px"><button id="rp-csv">Exportar CSV de viajes</button></div>`;

  const csvBtn = $('rp-csv');
  if (csvBtn) csvBtn.onclick = () => {
    const rows = [['#', 'inicio', 'fin', 'duracion_min', 'distancia_km', 'vel_max_kmh']];
    (r.trips || []).forEach((t, i) => rows.push([i + 1, t.start, t.end, t.durationMin, t.distanceKm, t.maxSpeed]));
    downloadFile('reporte-viajes.csv', rows.map((x) => x.join(',')).join('\n'), 'text/csv');
  };
}
function hourlyChart(hourly) {
  const W = 680, H = 180, pad = 28, bw = (W - pad * 2) / 24;
  const maxDist = Math.max(1, ...hourly.map((h) => h.distanceKm));
  const maxSpd = Math.max(1, ...hourly.map((h) => h.maxSpeed));
  let bars = '', line = '', dots = '';
  hourly.forEach((h, i) => {
    const x = pad + i * bw;
    const bh = (h.distanceKm / maxDist) * (H - pad * 2);
    bars += `<rect x="${x + 2}" y="${H - pad - bh}" width="${bw - 4}" height="${bh}" rx="2" fill="#1E7FEF" opacity=".8"><title>${h.hour}:00 — ${h.distanceKm} km</title></rect>`;
    const y = H - pad - (h.maxSpeed / maxSpd) * (H - pad * 2);
    line += `${i === 0 ? 'M' : 'L'}${x + bw / 2},${y} `;
    dots += `<circle cx="${x + bw / 2}" cy="${y}" r="2.5" fill="#16B364"><title>${h.hour}:00 — ${h.maxSpeed} km/h</title></circle>`;
    if (i % 3 === 0) bars += `<text x="${x + bw / 2}" y="${H - 8}" fill="#8497B0" font-size="9" font-family="monospace" text-anchor="middle">${h.hour}h</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:100%">
    ${bars}<path d="${line}" fill="none" stroke="#16B364" stroke-width="2"/>${dots}</svg>`;
}

/* ============================ Alertas ============================ */
let unack = 0;
function severityRank(s) { return s === 'critical' ? 0 : s === 'warning' ? 1 : 2; }
function addEvent(e, live) {
  events.unshift(e);
  if (events.length > 300) events.pop();
  if (!e.acknowledged) { unack++; refreshBadge(); }
  renderAlerts();
  if (live && severityRank(e.severity) <= 1) {
    toast((e.severity === 'critical' ? '🔴 ' : '🟠 ') + e.message);
    flashDevice(e);
  }
}
function refreshBadge() {
  const b = $('alert-badge');
  b.textContent = unack; b.classList.toggle('show', unack > 0);
}
function renderAlerts() {
  const list = $('al-list');
  if (!events.length) { list.innerHTML = '<div class="al-empty">Sin alertas por ahora.</div>'; return; }
  list.innerHTML = events.map((e) => `
    <div class="al-item ${e.acknowledged ? 'ack' : ''}" data-id="${e.id ?? ''}" data-lat="${e.latitude ?? ''}" data-lon="${e.longitude ?? ''}">
      <div class="al-dot ${e.severity}"></div>
      <div><div class="al-msg">${e.message}</div><div class="al-time">${fmtTime(e.time)}${e.plate ? ' · ' + e.plate : ''}</div></div>
    </div>`).join('');
  list.querySelectorAll('.al-item').forEach((it) => it.onclick = () => {
    const lat = parseFloat(it.dataset.lat), lon = parseFloat(it.dataset.lon);
    if (!isNaN(lat) && !isNaN(lon)) { map.setView([lat, lon], 16); }
    const id = it.dataset.id; if (id) ackEvent(parseInt(id, 10), it);
  });
}
function flashDevice(e) {
  let target = null;
  fleet.forEach((v) => { if (v.data.deviceId === e.deviceId) target = v; });
  if (target && target.data.latitude != null) {
    const c = L.circle([target.data.latitude, target.data.longitude], { radius: 120, color: '#E5484D', weight: 2, fill: false }).addTo(map);
    setTimeout(() => map.removeLayer(c), 3000);
  }
}
async function ackEvent(id, node) {
  try { await fetch(`/events/${id}/ack`, { method: 'PATCH' }); } catch {}
  const ev = events.find((x) => x.id === id);
  if (ev && !ev.acknowledged) { ev.acknowledged = true; unack = Math.max(0, unack - 1); refreshBadge(); }
  if (node) node.classList.add('ack');
}
$('btn-alerts').onclick = () => { $('detail').classList.remove('open'); $('alerts').classList.toggle('open'); };
$('al-close').onclick = () => $('alerts').classList.remove('open');
$('al-ackall').onclick = async () => {
  try { await fetch('/events/ack-all', { method: 'POST' }); } catch {}
  events.forEach((e) => e.acknowledged = true); unack = 0; refreshBadge(); renderAlerts();
};

/* ============================ Geocercas ============================ */
function gfLayer(g) {
  const opts = { color: g.color || '#1E7FEF', weight: 2, fillOpacity: .12 };
  let layer;
  if (g.kind === 'circle' && g.center_lat != null) layer = L.circle([g.center_lat, g.center_lon], { radius: g.radius_m, ...opts });
  else if (g.geojson) { try { layer = L.geoJSON(JSON.parse(g.geojson), { style: opts }); } catch { return null; } }
  if (layer) layer.bindTooltip(g.name);
  return layer;
}
function addGeofence(g) {
  const layer = gfLayer(g);
  if (layer && g.active) layer.addTo(map);
  geofences.set(g.id, { data: g, layer });
  renderGeoList();
}
function renderGeoList() {
  const list = $('geo-list');
  if (!geofences.size) { list.innerHTML = '<div class="al-empty">Dibuja una zona con los botones de abajo.</div>'; $('geo-count').textContent = ''; return; }
  list.innerHTML = '';
  geofences.forEach(({ data: g }) => {
    const item = el('div', 'gf-item');
    item.innerHTML = `<div class="gf-swatch" style="background:${g.color}"></div>
      <div><div class="gf-name">${g.name}</div><div class="gf-sub">${g.kind === 'circle' ? 'Círculo · ' + Math.round(g.radius_m) + ' m' : 'Polígono'} · ${({ enter: 'entrada', exit: 'salida', both: 'entra/sale' }[g.alert_on] || g.alert_on)}</div></div>
      <div class="gf-toggle"><button data-act="toggle">${g.active ? 'Ocultar' : 'Ver'}</button> <button data-act="del" class="danger">✕</button></div>`;
    item.querySelector('[data-act="toggle"]').onclick = () => toggleGeofence(g.id);
    item.querySelector('[data-act="del"]').onclick = () => delGeofence(g.id);
    list.appendChild(item);
  });
  $('geo-count').textContent = geofences.size;
}
async function toggleGeofence(id) {
  const g = geofences.get(id); if (!g) return;
  const active = !g.data.active;
  try { await fetch(`/geofences/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }) }); } catch {}
  g.data.active = active;
  if (g.layer) { active ? g.layer.addTo(map) : map.removeLayer(g.layer); }
  renderGeoList();
}
async function delGeofence(id) {
  const g = geofences.get(id); if (!g) return;
  try { await fetch(`/geofences/${id}`, { method: 'DELETE' }); } catch {}
  if (g.layer) map.removeLayer(g.layer);
  geofences.delete(id); renderGeoList(); toast('Geocerca eliminada.');
}

/* ---- Dibujo interactivo de geocercas ---- */
let drawMode = null, drawTmp = null, polyPts = [];
function hint(msg) { const h = $('draw-hint'); h.textContent = msg || ''; h.classList.toggle('show', !!msg); }
function startDrawCircle() { cancelDraw(); drawMode = 'circle'; hint('Clic para el CENTRO del círculo'); map.getContainer().style.cursor = 'crosshair'; }
function startDrawPoly() { cancelDraw(); drawMode = 'poly'; polyPts = []; hint('Clic para añadir vértices · doble clic para cerrar'); map.getContainer().style.cursor = 'crosshair'; }
function cancelDraw() {
  drawMode = null; polyPts = []; hint(''); map.getContainer().style.cursor = '';
  if (drawTmp) { map.removeLayer(drawTmp); drawTmp = null; }
}
$('btn-draw-circle').onclick = startDrawCircle;
$('btn-draw-poly').onclick = startDrawPoly;

map.on('click', (e) => {
  if (drawMode === 'circle') {
    if (!drawTmp) { drawTmp = L.circle(e.latlng, { radius: 50, color: '#1E7FEF', fillOpacity: .12 }).addTo(map); hint('Mueve el mouse y clic para fijar el RADIO'); drawTmp._center = e.latlng; }
    else { finishCircle(drawTmp._center, drawTmp.getRadius()); }
  } else if (drawMode === 'poly') {
    polyPts.push([e.latlng.lat, e.latlng.lng]);
    if (drawTmp) map.removeLayer(drawTmp);
    drawTmp = L.polyline(polyPts.map((p) => [p[0], p[1]]), { color: '#1E7FEF' }).addTo(map);
  }
});
map.on('mousemove', (e) => {
  if (drawMode === 'circle' && drawTmp && drawTmp._center) {
    drawTmp.setRadius(drawTmp._center.distanceTo(e.latlng));
  }
});
map.on('dblclick', (e) => {
  if (drawMode === 'poly' && polyPts.length >= 3) { L.DomEvent.stop(e); finishPoly(polyPts.slice()); }
});
async function finishCircle(center, radius) {
  const name = prompt('Nombre de la zona:', 'Zona ' + (geofences.size + 1)); cancelDraw();
  if (!name) return;
  await saveGeofence({ name, kind: 'circle', center: { lat: center.lat, lon: center.lng }, radius_m: Math.round(radius), alert_on: 'both', color: '#1E7FEF' });
}
async function finishPoly(pts) {
  const name = prompt('Nombre de la zona:', 'Zona ' + (geofences.size + 1)); cancelDraw();
  if (!name) return;
  await saveGeofence({ name, kind: 'polygon', points: pts, alert_on: 'both', color: '#16B364' });
}
async function saveGeofence(g) {
  try {
    const r = await fetch('/geofences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g) });
    if (!r.ok) throw new Error(r.status);
    const saved = await r.json();
    if (saved.geom) saved.geojson = null; // el listado trae geojson; para polígono recargamos
    if (g.kind === 'polygon') { await loadGeofences(); } else { addGeofence(saved); }
    toast('Geocerca “' + g.name + '” creada.');
  } catch { toast('No se pudo guardar la geocerca (¿base de datos apagada?).'); }
}
async function loadGeofences() {
  try {
    const rows = await (await fetch('/geofences')).json();
    geofences.forEach(({ layer }) => layer && map.removeLayer(layer));
    geofences.clear();
    rows.forEach(addGeofence);
  } catch { /* silencioso */ }
}

/* ============================ Tabs / filtros / búsqueda ============================ */
document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active'); $('panel-' + t.dataset.tab).classList.add('active');
});
document.querySelectorAll('.stat').forEach((s) => s.onclick = () => {
  document.querySelectorAll('.stat').forEach((x) => x.classList.remove('active'));
  s.classList.add('active'); filter = s.dataset.filter; fleet.forEach(applyRowVisibility); refreshStats();
});
$('q').oninput = (e) => { query = e.target.value.trim().toLowerCase(); fleet.forEach(applyRowVisibility); refreshStats(); };
$('btn-fit').onclick = () => {
  const pts = []; fleet.forEach((v) => { if (v.data.latitude != null) pts.push([v.data.latitude, v.data.longitude]); });
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50] }); else toast('Aún no hay posiciones.');
};
$('btn-labels').onclick = () => { showLabels = !showLabels; fleet.forEach((v) => { if (v.marker) v.marker.setIcon(vehicleIcon(v.data)); }); toast(showLabels ? 'Etiquetas activadas' : 'Etiquetas ocultas'); };

/* ============================ Carga inicial + tiempo real ============================ */
fetch('/devices')
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then((rows) => rows.forEach((r) => upsert({
    uniqueId: r.unique_id, deviceId: r.id, name: r.name, plate: r.plate, driver: r.driver,
    speed_limit: r.speed_limit, notes: r.notes, battery: r.battery_level, time: r.position_time,
    latitude: r.latitude, longitude: r.longitude, speedKmh: r.speed_kmh, course: r.course,
    ignition: r.ignition, valid: r.valid, alarms: r.alarms,
  })))
  .catch(() => banner('No se pudo leer la flota (¿base de datos apagada?). El mapa en vivo sigue funcionando con las tramas que lleguen.'));

fetch('/events?limit=100').then((r) => r.ok ? r.json() : []).then((rows) => {
  rows.reverse().forEach((e) => addEvent({
    id: e.id, deviceId: e.device_id, type: e.type, severity: e.severity, message: e.message,
    latitude: e.latitude, longitude: e.longitude, time: e.time, plate: e.plate, acknowledged: e.acknowledged,
  }, false));
}).catch(() => {});

loadGeofences();

const socket = io();
socket.on('position', (p) => upsert(p));
socket.on('event', (e) => addEvent(e, true));
socket.on('connect', () => banner(''));
socket.on('connect_error', () => banner('Sin conexión en vivo con el servidor. Reintentando…'));

// Refresco de tiempos relativos
setInterval(() => { fleet.forEach(renderRow); const d = selData(); if (d) renderDetail(d); refreshStats(); }, 20000);
