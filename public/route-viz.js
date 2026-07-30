/* ============================================================================
   DISMAP GPS · Route Viz — Historial de recorrido premium
   ----------------------------------------------------------------------------
   Reemplaza el render del RECORRIDO y el REPRODUCTOR por una experiencia de
   navegación tipo Google Maps / Uber, sin tocar app.js ni el tiempo real.

   Estrategia (idéntica a ui-v2): se carga DESPUÉS de app.js y reengancha los
   mismos botones (#dt-route, #dt-play, #dt-clear, #pl-*) sobreescribiendo sus
   manejadores. Comparte el mapa global `map`, `selData()`, `fmtTime()`,
   `toast()` y la variable `routePoints` (para que "Exportar GPX" siga vivo).
   Rollback = quitar route-viz.css/route-viz.js del index.html.

   Render:
    · Ruta en un <canvas> propio (aguanta miles de puntos; se simplifica con
      Douglas-Peucker y se recorta al viewport). Doble trazo: borde blanco +
      núcleo azul, uniones redondeadas, curvas suavizadas.
    · Sentido del recorrido por DEGRADADO (verde→azul) y opacidad, sin flechas.
    · Progreso dinámico: lo recorrido intenso, lo pendiente apagado.
    · Vehículo SVG cenital como marcador Leaflet: rota con el rumbo, escala con
      el zoom, sombra suave, giro suavizado por interpolación.
    · Paradas = círculos cuyo tamaño crece con el tiempo detenido, con el
      tiempo escrito dentro (5 min / 2 h …). Zoom inteligente: se ocultan de
      lejos y aparecen al acercarse.
    · Reproducción con requestAnimationFrame e interpolación temporal:
      aceleración/desaceleración naturales, seguimiento de cámara, scrubbing.
   ========================================================================= */
(function () {
  'use strict';
  if (typeof L === 'undefined' || typeof map === 'undefined') return;

  const $ = (id) => document.getElementById(id);
  const TAU = Math.PI * 2;
  const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- Umbrales de "zoom inteligente" y de detección ---------------------- */
  const Z_STOPS = 13;         // a este zoom o más se muestran paradas
  const STOP_SPEED = 2;       // km/h por debajo = detenido
  const MIN_STOP_MS = 3 * 60000;  // parada válida a partir de 3 min
  const GAP_MS = 20 * 60000;  // salto temporal que corta el trazo

  /* ======================================================================
     Utilidades geométricas
     ====================================================================== */
  function bearing(a, b) {
    const y = Math.sin((b.lon - a.lon) * toRad) * Math.cos(b.lat * toRad);
    const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
      Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lon - a.lon) * toRad);
    return (Math.atan2(y, x) * toDeg + 360) % 360;
  }
  function lerpAngle(a, b, t) {
    let d = ((b - a + 540) % 360) - 180;   // diferencia mínima con signo
    return (a + d * t + 360) % 360;
  }
  function mix(a, b, t) { return a + (b - a) * t; }
  function mixColor(c1, c2, t) {
    const r = Math.round(mix(c1[0], c2[0], t));
    const g = Math.round(mix(c1[1], c2[1], t));
    const b = Math.round(mix(c1[2], c2[2], t));
    return `rgb(${r},${g},${b})`;
  }
  const C_GREEN = [22, 179, 100], C_BLUE = [46, 125, 246];

  /** Douglas-Peucker iterativo (sin recursión → seguro con muchos puntos). */
  function simplify(pts, epsMeters) {
    const n = pts.length;
    if (n < 3) return pts.slice();
    // grados aproximados por metro (a esta latitud) para el umbral
    const latRef = pts[Math.floor(n / 2)].lat * toRad;
    const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos(latRef);
    const eps2 = epsMeters * epsMeters;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop();
      const ax = pts[i0].lon * mPerDegLon, ay = pts[i0].lat * mPerDegLat;
      const bx = pts[i1].lon * mPerDegLon, by = pts[i1].lat * mPerDegLat;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      let idx = -1, maxD = eps2;
      for (let i = i0 + 1; i < i1; i++) {
        const px = pts[i].lon * mPerDegLon, py = pts[i].lat * mPerDegLat;
        const tt = ((px - ax) * dx + (py - ay) * dy) / len2;
        const cx = ax + clamp(tt, 0, 1) * dx, cy = ay + clamp(tt, 0, 1) * dy;
        const d2 = (px - cx) ** 2 + (py - cy) ** 2;
        if (d2 > maxD) { maxD = d2; idx = i; }
      }
      if (idx !== -1) { keep[idx] = 1; stack.push([i0, idx], [idx, i1]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  /** Separa los cortes usando los puntos crudos y simplifica cada tramo por
   *  separado. Así, Douglas-Peucker nunca convierte un trayecto continuo y
   *  largo en dos extremos que luego parezcan un salto temporal. */
  function prepareRoute(pts, maxPoints = 6000) {
    const chunks = [];
    let start = 0;
    for (let i = 1; i <= pts.length; i++) {
      const atEnd = i === pts.length;
      const hasGap = !atEnd && pts[i].t - pts[i - 1].t > GAP_MS;
      if (atEnd || hasGap) {
        if (i > start) chunks.push(pts.slice(start, i));
        start = i;
      }
    }

    let prepared = [];
    chunks.forEach((chunk, segmentId) => {
      const compact = simplify(chunk, 6);
      prepared.push(...compact.map((p) => ({ ...p, segmentId })));
    });

    if (prepared.length > maxPoints) {
      const stride = Math.ceil(prepared.length / maxPoints);
      prepared = prepared.filter((p, i, all) => {
        const boundary = i === 0 || i === all.length - 1 ||
          all[i - 1].segmentId !== p.segmentId ||
          all[i + 1].segmentId !== p.segmentId;
        return boundary || i % stride === 0;
      });
    }
    return prepared;
  }

  /* ======================================================================
     Estado del módulo
     ====================================================================== */
  const state = {
    pts: [],            // recorrido a dibujar {lat,lon,t,speed,course}
    stops: [],          // paradas detectadas
    progress: 1,        // 0..1 (1 = ruta completa; <1 durante reproducción)
    markers: [],        // marcadores auxiliares (inicio/fin/paradas)
    vehMarker: null,    // marcador del vehículo en reproducción
    playing: false,
    speed: 1,
    clock: 0,           // reloj virtual de reproducción (ms)
    total: 0,           // duración virtual total (ms)
    timeline: [],       // ms acumulados por punto (con topes en paradas)
    raf: null,
    lastTs: 0,
    heading: 0,
  };

  /* ======================================================================
     Lienzo de la ruta (canvas propio pegado al contenedor del mapa)
     ====================================================================== */
  const canvas = document.createElement('canvas');
  /* Va DENTRO del overlayPane (no como hijo del contenedor): así queda sobre
     los tiles y bajo los marcadores. Como hijo directo del contenedor quedaba
     detrás de .leaflet-map-pane (z-index 400) y la ruta no se veía.
     leaflet-zoom-hide lo oculta durante la animación de zoom. */
  canvas.className = 'rv-canvas leaflet-zoom-hide';
  map.getPane('overlayPane').appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  /** Esquina superior izquierda del lienzo en coordenadas de capa. */
  let originLayer = L.point(0, 0);

  function sizeCanvas() {
    const s = map.getSize();
    if (!s.x || !s.y) return false;          // el mapa aún está oculto
    dpr = window.devicePixelRatio || 1;
    canvas.width = s.x * dpr;
    canvas.height = s.y * dpr;
    canvas.style.width = s.x + 'px';
    canvas.style.height = s.y + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }
  /** Ancla el lienzo al mapa; al arrastrar, el pane lo mueve por transform. */
  function placeCanvas() {
    originLayer = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(canvas, originLayer);
  }
  function refresh() {
    if (!sizeCanvas()) return;
    placeCanvas();
    draw();
  }
  refresh();

  /** Puntos → coordenadas de pantalla, recortando lo que queda fuera del
   *  viewport (con margen) para no dibujar de más con recorridos largos. */
  function toScreen() {
    const size = map.getSize();
    const m = 80;   // margen para no cortar trazos que entran/salen
    const P = new Array(state.pts.length);
    for (let i = 0; i < state.pts.length; i++) {
      // Coordenadas de CAPA menos el origen del lienzo: se mantienen estables
      // mientras el pane se desplaza por transform (arrastre y animaciones).
      const p = map.latLngToLayerPoint([state.pts[i].lat, state.pts[i].lon]);
      const x = p.x - originLayer.x, y = p.y - originLayer.y;
      P[i] = { x, y, on: x >= -m && x <= size.x + m && y >= -m && y <= size.y + m };
    }
    return P;
  }

  /** Traza una polilínea suavizada (quadratic por puntos medios). */
  function smoothPath(P, from, to) {
    ctx.beginPath();
    ctx.moveTo(P[from].x, P[from].y);
    for (let i = from + 1; i < to - 1; i++) {
      const mx = (P[i].x + P[i + 1].x) / 2, my = (P[i].y + P[i + 1].y) / 2;
      ctx.quadraticCurveTo(P[i].x, P[i].y, mx, my);
    }
    ctx.lineTo(P[to - 1].x, P[to - 1].y);
  }

  function draw() {
    // Autocorrección: si el mapa estaba oculto al cargar (login), el lienzo
    // quedó sin dimensionar. En cuanto haya tamaño real, se ajusta y recoloca.
    const size = map.getSize();
    if (size.x && size.y && (canvas.style.width !== size.x + 'px' || canvas.style.height !== size.y + 'px')) {
      sizeCanvas();
      placeCanvas();
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const n = state.pts.length;
    if (n < 2) return;
    const P = toScreen();
    const z = map.getZoom();
    // Grosores según zoom (navegación premium, no hilo fino)
    const coreW = clamp(2.6 + (z - 11) * 0.9, 3.5, 9);
    const caseW = coreW + 4.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const split = Math.round(clamp(state.progress, 0, 1) * (n - 1));

    // Los segmentos se definieron antes de simplificar. Comparar aquí los
    // tiempos simplificados volvería a ocultar tramos rectos de larga duración.
    const segments = [];
    let segStart = 0;
    for (let i = 1; i < n; i++) {
      if (state.pts[i].segmentId !== state.pts[i - 1].segmentId) {
        if (i - segStart >= 2) segments.push([segStart, i]);
        segStart = i;
      }
    }
    if (n - segStart >= 2) segments.push([segStart, n]);

    const drawBand = (from, to, traveled) => {
      if (to - from < 2) return;
      // ¿algo visible en este tramo?
      let vis = false;
      for (let i = from; i < to; i++) if (P[i].on) { vis = true; break; }
      if (!vis) return;
      // Borde blanco (casing)
      ctx.globalAlpha = traveled ? 0.9 : 0.28;
      ctx.strokeStyle = getVar('--rv-casing', '#F7F9FB');
      ctx.lineWidth = caseW;
      smoothPath(P, from, to);
      ctx.stroke();
      // Núcleo
      if (traveled) {
        // Degradado verde→azul a lo largo del tramo = sentido del recorrido
        const g = ctx.createLinearGradient(P[from].x, P[from].y, P[to - 1].x, P[to - 1].y);
        g.addColorStop(0, mixColor(C_GREEN, C_BLUE, from / n));
        g.addColorStop(1, mixColor(C_GREEN, C_BLUE, (to - 1) / n));
        ctx.strokeStyle = g;
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = getVar('--rv-blue-lo', '#3E5F86');
        ctx.globalAlpha = 0.5;
      }
      ctx.lineWidth = coreW;
      smoothPath(P, from, to);
      ctx.stroke();
    };

    // 1) Pendiente (apagado)  2) Recorrido (intenso)
    for (const [a, b] of segments) {
      if (split <= a) { drawBand(a, b, false); }
      else if (split >= b - 1) { drawBand(a, b, true); }
      else { drawBand(a, split + 1, true); drawBand(split, b, false); }
    }

    // Punto-cabeza luminoso en el frente de avance (durante reproducción)
    if (state.progress < 1 && split > 0 && split < n && P[split].on) {
      const hp = P[split];
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, coreW * 1.5, 0, TAU);
      ctx.fillStyle = 'rgba(46,125,246,.25)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, coreW * 0.7, 0, TAU);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function getVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  /* Redibujado eficiente: rAF durante pan; limpieza durante el zoom animado */
  let drawRaf = null;
  function schedule() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => {
      drawRaf = null;
      placeCanvas();
      draw();
    });
  }
  map.on('move', schedule);
  map.on('moveend zoomend viewreset resize', () => { refresh(); onZoom(); });
  map.on('zoomstart', () => ctx.clearRect(0, 0, canvas.width, canvas.height));
  window.addEventListener('resize', refresh);

  /* ======================================================================
     Vehículo SVG cenital (marcador Leaflet, rota y escala)
     ====================================================================== */
  function carSvg() {
    // Coche visto desde arriba, morro hacia el norte (0°). Colores de marca.
    return `
      <svg viewBox="0 0 44 44" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="rvBody" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#3E8BFF"/><stop offset="1" stop-color="#1E6BE0"/>
          </linearGradient>
        </defs>
        <rect x="13" y="6" width="18" height="32" rx="7" fill="url(#rvBody)" stroke="#0B1626" stroke-width="1.2"/>
        <path d="M15.5 12 Q22 8.5 28.5 12 L27 16.5 Q22 14.8 17 16.5 Z" fill="#BFE0FF" opacity="0.92"/>
        <rect x="16.5" y="20" width="11" height="9" rx="2.4" fill="#12233A"/>
        <path d="M16 33 Q22 35 28 33 L27 36 Q22 37 17 36 Z" fill="#0E1A2B" opacity="0.85"/>
        <circle cx="22" cy="7.5" r="1.5" fill="#EAF4FF"/>
      </svg>`;
  }
  function vehSizeForZoom() {
    const z = map.getZoom();
    return clamp(Math.round(20 + (z - 11) * 6), 22, 56);
  }
  function makeVehIcon() {
    const s = vehSizeForZoom();
    return L.divIcon({
      className: 'rv-veh',
      iconSize: [s, s],
      iconAnchor: [s / 2, s / 2],
      html: `<div class="rv-veh-halo"></div><div class="rv-veh-inner" style="transform:rotate(${state.heading}deg)">${carSvg()}</div>`,
    });
  }
  function ensureVeh(latlng) {
    if (!state.vehMarker) {
      state.vehMarker = L.marker(latlng, { icon: makeVehIcon(), interactive: false, zIndexOffset: 1000, keyboard: false }).addTo(map);
    } else {
      state.vehMarker.setLatLng(latlng).addTo(map);
    }
  }
  function paintVeh(latlng, heading) {
    if (!state.vehMarker) return;
    state.vehMarker.setLatLng(latlng);
    const inner = state.vehMarker.getElement() && state.vehMarker.getElement().querySelector('.rv-veh-inner');
    if (inner) inner.style.transform = `rotate(${heading}deg)`;
  }

  /* ======================================================================
     Inicio / fin y paradas (marcadores con tarjeta flotante)
     ====================================================================== */
  const card = document.createElement('div');
  card.className = 'rv-card';
  card.style.display = 'none';
  map.getContainer().appendChild(card);
  function showCard(latlng, html) {
    card._ll = latlng; card.innerHTML = html; card.style.display = 'block';
    positionCard();
  }
  function hideCard() { card.style.display = 'none'; card._ll = null; }
  function positionCard() {
    if (!card._ll) return;
    const p = map.latLngToContainerPoint(card._ll);
    card.style.left = p.x + 'px';
    card.style.top = p.y + 'px';
  }
  map.on('move zoom', () => { if (card._ll) positionCard(); });
  map.on('click', hideCard);

  const ICO_START = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18"/><path d="M5 4h11l-2 4 2 4H5"/></svg>';
  const ICO_END = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 2a1 1 0 0 0-1 1v18a1 1 0 0 0 2 0v-6h11l-2-4 2-4H7V3a1 1 0 0 0-1-1z"/></svg>';
  const ICO_STOP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  function endpointIcon(kind) {
    const color = kind === 'start' ? '#16B364' : '#F0455B';
    const inner = kind === 'start'
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18"/><path d="M5 4h11l-2 4 2 4H5"/></svg>'
      : '<svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';
    return L.divIcon({
      className: 'rv-endpt is-' + kind,
      iconSize: [30, 30], iconAnchor: [15, 15],
      html: `<div class="rv-endpt-dot rv-appear"><span class="rv-endpt-pulse"></span>
        <span style="width:26px;height:26px;border-radius:50%;background:${color};display:grid;place-items:center;box-shadow:0 2px 8px rgba(0,0,0,.5)">${inner}</span></div>`,
    });
  }

  function stopIcon(stop) {
    const min = stop.dwellMs / 60000;
    const r = clamp(Math.round(13 + 7 * Math.log2(1 + min / 4)), 15, 34);
    const d = r * 2;
    const fs = clamp(Math.round(r * 0.42), 8, 13);
    return L.divIcon({
      className: 'rv-stop',
      iconSize: [d, d], iconAnchor: [r, r],
      html: `<div class="rv-stop-bubble rv-appear" style="font-size:${fs}px">${fmtDwell(stop.dwellMs)}</div>`,
    });
  }

  function fmtDwell(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return m + ' min';
    const h = m / 60;
    return (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10) + ' h';
  }
  function fmtDur(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  /** Detecta paradas: tramos por debajo de STOP_SPEED con dwell ≥ MIN_STOP_MS. */
  function detectStops(pts) {
    const stops = [];
    let i = 0;
    while (i < pts.length) {
      if ((pts[i].speed ?? 0) <= STOP_SPEED) {
        let j = i;
        let sumLat = 0, sumLon = 0, cnt = 0;
        while (j < pts.length && (pts[j].speed ?? 0) <= STOP_SPEED &&
               (j === i || pts[j].t - pts[j - 1].t <= GAP_MS)) {
          sumLat += pts[j].lat; sumLon += pts[j].lon; cnt++; j++;
        }
        const dwell = pts[j - 1].t - pts[i].t;
        if (dwell >= MIN_STOP_MS) {
          stops.push({ lat: sumLat / cnt, lon: sumLon / cnt, dwellMs: dwell, start: pts[i].t, end: pts[j - 1].t });
        }
        i = j;
      } else i++;
    }
    return stops;
  }

  /* ======================================================================
     Carga y montaje del recorrido
     ====================================================================== */
  async function loadData() {
    const d = (typeof selData === 'function') ? selData() : null;
    if (!d || d.deviceId == null) { toastMsg('Selecciona un vehículo registrado.'); return null; }
    try {
      const response = await fetch(`/devices/${d.deviceId}/positions?limit=10000`);
      if (!response.ok) throw new Error(`Historial HTTP ${response.status}`);
      const rows = await response.json();
      if (!Array.isArray(rows) || !rows.length) { toastMsg('Sin posiciones en las últimas 24 h.'); return null; }
      const pts = rows
        .filter((p) => p && p.latitude != null && p.longitude != null && p.time != null)
        .map((p) => {
          const course = Number(p.course);
          const speed = Number(p.speed_kmh ?? 0);
          return {
            lat: Number(p.latitude),
            lon: Number(p.longitude),
            t: new Date(p.time).getTime(),
            speed: Number.isFinite(speed) ? speed : 0,
            course: p.course == null || !Number.isFinite(course) ? null : course,
          };
        })
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t) &&
          p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180)
        .sort((a, b) => a.t - b.t);
      if (pts.length < 2) { toastMsg('Se necesitan al menos dos posiciones válidas para mostrar el recorrido.'); return null; }
      const simplified = prepareRoute(pts);
      // Guardamos ambos: detección de paradas sobre el crudo (dwell exacto)
      state.raw = pts;
      state.pts = simplified;
      // Compat: "Exportar GPX" de app.js lee la variable global routePoints
      try { routePoints = pts.map((p) => ({ lat: p.lat, lon: p.lon, t: new Date(p.t).toISOString(), speed: p.speed })); } catch (_) {}
      return simplified;
    } catch (err) {
      console.error('[RouteViz] No se pudo cargar el recorrido:', err);
      toastMsg('No se pudo cargar el recorrido.');
      return null;
    }
  }

  function buildTimeline() {
    // Reloj virtual: respeta el tiempo real pero comprime paradas y saltos,
    // para que la reproducción se sienta continua (aceleración natural en
    // tramos rápidos, sin esperas de horas en las detenciones).
    const p = state.pts, n = p.length;
    state.timeline = new Array(n);
    state.timeline[0] = 0;
    const CAP = 3500;   // ms máx. por segmento en tiempo virtual
    const MINSEG = 60;  // ms mín. (da un mínimo de movimiento perceptible)
    for (let i = 1; i < n; i++) {
      let dt = p[i].t - p[i - 1].t;
      dt = clamp(dt, MINSEG, CAP);
      state.timeline[i] = state.timeline[i - 1] + dt;
    }
    state.total = state.timeline[n - 1] || 1;
  }

  function clearAll() {
    state.markers.forEach((m) => map.removeLayer(m));
    state.markers = [];
    if (state.vehMarker) { map.removeLayer(state.vehMarker); state.vehMarker = null; }
    state.pts = []; state.stops = []; state.progress = 1;
    hideCard();
    draw();
  }

  function mountRoute(pts) {
    // Limpia marcadores previos pero conserva pts recién cargados
    state.markers.forEach((m) => map.removeLayer(m));
    state.markers = [];
    state.progress = 1;
    state.stops = detectStops(state.raw || pts);

    const first = pts[0], last = pts[pts.length - 1];
    // Inicio
    const mStart = L.marker([first.lat, first.lon], { icon: endpointIcon('start'), zIndexOffset: 800 }).addTo(map);
    mStart.on('click', (e) => { L.DomEvent.stop(e); cardEndpoint('start', first); });
    // Fin
    const mEnd = L.marker([last.lat, last.lon], { icon: endpointIcon('end'), zIndexOffset: 800 }).addTo(map);
    mEnd.on('click', (e) => { L.DomEvent.stop(e); cardEndpoint('end', last); });
    state.markers.push(mStart, mEnd);

    // Paradas
    state.stops.forEach((s) => {
      const m = L.marker([s.lat, s.lon], { icon: stopIcon(s), zIndexOffset: 700 });
      m._stop = s;
      m.on('click', (e) => { L.DomEvent.stop(e); cardStop(s); });
      state.markers.push(m);
      m.addTo(map);
    });

    onZoom();
    draw();
    // Encuadre al recorrido
    const b = L.latLngBounds(pts.map((p) => [p.lat, p.lon]));
    map.fitBounds(b, { padding: [60, 60], maxZoom: 16 });
  }

  function cardEndpoint(kind, p) {
    const title = kind === 'start' ? 'Inicio del recorrido' : 'Fin del recorrido';
    showCard([p.lat, p.lon], `
      <div class="rv-card-head"><span class="rv-card-ico is-${kind}">${kind === 'start' ? ICO_START : ICO_END}</span>${title}</div>
      <div class="rv-card-rows">
        <div class="rv-card-row"><span class="k">Hora</span><span class="v">${fmtTimeSafe(p.t)}</span></div>
        <div class="rv-card-row"><span class="k">Velocidad</span><span class="v">${Math.round(p.speed || 0)} km/h</span></div>
        <div class="rv-card-row"><span class="k">Coordenadas</span><span class="v">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span></div>
      </div>`);
  }
  function cardStop(s) {
    showCard([s.lat, s.lon], `
      <div class="rv-card-head"><span class="rv-card-ico is-stop">${ICO_STOP}</span>Parada · ${fmtDwell(s.dwellMs)}</div>
      <div class="rv-card-rows">
        <div class="rv-card-row"><span class="k">Desde</span><span class="v">${fmtTimeSafe(s.start)}</span></div>
        <div class="rv-card-row"><span class="k">Hasta</span><span class="v">${fmtTimeSafe(s.end)}</span></div>
        <div class="rv-card-row"><span class="k">Detenido</span><span class="v">${fmtDur(s.dwellMs)}</span></div>
      </div>`);
  }

  /* Zoom inteligente: paradas visibles solo de cerca */
  function onZoom() {
    const showStops = map.getZoom() >= Z_STOPS;
    state.markers.forEach((m) => {
      if (m._stop) {
        const el = m.getElement();
        if (el) el.style.display = showStops ? '' : 'none';
      }
    });
  }

  /* ======================================================================
     Reproducción (interpolación con requestAnimationFrame)
     ====================================================================== */
  function sampleAt(clock) {
    // localiza el segmento del reloj virtual y devuelve pos+rumbo interpolados
    const tl = state.timeline, p = state.pts, n = p.length;
    if (clock <= 0) return { lat: p[0].lat, lon: p[0].lon, heading: segHeading(0), speed: p[0].speed, t: p[0].t, idx: 0 };
    if (clock >= state.total) { const k = n - 1; return { lat: p[k].lat, lon: p[k].lon, heading: segHeading(k - 1), speed: p[k].speed, t: p[k].t, idx: k }; }
    // búsqueda lineal desde el último índice (monótona → barata)
    let i = state._i || 1;
    if (tl[i - 1] > clock) i = 1;
    while (i < n && tl[i] < clock) i++;
    state._i = i;
    const t0 = tl[i - 1], t1 = tl[i];
    const f = t1 > t0 ? (clock - t0) / (t1 - t0) : 0;
    const a = p[i - 1], b = p[i];
    return {
      lat: mix(a.lat, b.lat, f),
      lon: mix(a.lon, b.lon, f),
      heading: segHeading(i - 1),
      speed: mix(a.speed || 0, b.speed || 0, f),
      t: mix(a.t, b.t, f),
      idx: (i - 1) + f,
    };
  }
  function segHeading(i) {
    const p = state.pts;
    const a = p[Math.max(0, i)], b = p[Math.min(p.length - 1, i + 1)];
    if (a.course != null && (a.speed || 0) < STOP_SPEED) return a.course; // detenido: usa rumbo del equipo
    return bearing(a, b);
  }

  function frame(ts) {
    if (!state.playing) return;
    const dt = state.lastTs ? ts - state.lastTs : 16;
    state.lastTs = ts;
    state.clock = clamp(state.clock + dt * state.speed, 0, state.total);
    render();
    if (state.clock >= state.total) { pause(); return; }
    state.raf = requestAnimationFrame(frame);
  }

  function render() {
    const s = sampleAt(state.clock);
    ensureVeh([s.lat, s.lon]);
    // giro suavizado (interpolación de ángulo, sin transición CSS)
    state.heading = reduceMotion() ? s.heading : lerpAngle(state.heading, s.heading, 0.35);
    paintVeh([s.lat, s.lon], state.heading);
    state.progress = clamp(s.idx / (state.pts.length - 1), 0, 1);
    draw();
    // Seguimiento de cámara suave (si el panel de detalle está abierto)
    if (autoFollow()) map.panTo([s.lat, s.lon], { animate: true, duration: 0.25, easeLinearity: 0.5, noMoveStart: true });
    // HUD
    updateHud(s);
  }
  function autoFollow() {
    const d = $('detail');
    return d && d.classList.contains('open') && state.playing;
  }

  function play() {
    if (state.pts.length < 2) return;
    if (state.clock >= state.total) state.clock = 0;
    state.playing = true;
    state.lastTs = 0;
    setPlayIcon(true);
    state.raf = requestAnimationFrame(frame);
  }
  function pause() {
    state.playing = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = null;
    setPlayIcon(false);
  }
  function stop() {
    pause();
    state.clock = 0; state.progress = 1; state._i = 1;
    $('player') && $('player').classList.remove('open');
    if (state.vehMarker) { map.removeLayer(state.vehMarker); state.vehMarker = null; }
    draw();
  }

  /* ======================================================================
     Reproductor: HUD y controles (reusa el #player existente)
     ====================================================================== */
  let hudBuilt = false;
  function buildHud() {
    if (hudBuilt) return; hudBuilt = true;
    const player = $('player');
    if (!player) return;
    player.classList.add('rv-player');

    // HUD sobre los controles
    const hud = document.createElement('div');
    hud.className = 'rv-hud';
    hud.innerHTML = `
      <div class="rv-hud-gauge" id="rv-gauge"><b id="rv-gauge-pct">0%</b><span>AVANCE</span></div>
      <div class="rv-hud-facts">
        <div class="rv-hud-fact"><div class="k">Hora</div><div class="v" id="rv-fact-time">—</div></div>
        <div class="rv-hud-fact"><div class="k">Velocidad</div><div class="v" id="rv-fact-spd">— <small>km/h</small></div></div>
        <div class="rv-hud-fact"><div class="k">Rumbo</div><div class="v" id="rv-fact-hdg">—</div></div>
      </div>`;
    player.insertBefore(hud, player.firstChild);

    // Envolvemos el range con pista + relleno de avance
    const range = $('pl-range');
    if (range && !range.parentNode.classList.contains('rv-progress')) {
      const wrap = document.createElement('div');
      wrap.className = 'rv-progress';
      wrap.innerHTML = '<div class="rv-progress-track"><div class="rv-progress-fill" id="rv-fill"></div></div>';
      range.parentNode.insertBefore(wrap, range);
      wrap.appendChild(range);
      range.min = 0; range.max = 1000; range.step = 1;
    }
  }
  function updateHud(s) {
    const pct = Math.round(state.progress * 100);
    const g = $('rv-gauge'), gp = $('rv-gauge-pct');
    if (g) g.style.setProperty('--v', pct);
    if (gp) gp.textContent = pct + '%';
    const ft = $('rv-fact-time'), fs = $('rv-fact-spd'), fh = $('rv-fact-hdg');
    if (ft) ft.textContent = fmtHMSafe(s.t);
    if (fs) fs.innerHTML = Math.round(s.speed || 0) + ' <small>km/h</small>';
    if (fh) fh.textContent = Math.round(s.heading) + '°';
    const range = $('pl-range'), fill = $('rv-fill');
    if (range) range.value = Math.round(state.progress * 1000);
    if (fill) fill.style.width = (state.progress * 100) + '%';
    // reloj clásico existente
    const clk = $('pl-clock'); if (clk) clk.textContent = fmtTimeSafe(s.t);
    const idx = $('pl-idx'); if (idx) idx.textContent = Math.round(s.speed || 0) + ' km/h';
  }
  function setPlayIcon(playing) {
    const b = $('pl-play');
    if (b) b.textContent = playing ? '❚❚' : '▶';
  }

  /* ======================================================================
     Enganche a los botones existentes (sobreescribe a app.js)
     ====================================================================== */
  async function onShowRoute() {
    const pts = await loadData();
    if (!pts) return;
    buildTimeline();
    mountRoute(pts);
    // Estadísticas del panel: reutiliza computeStats() de app.js si existe
    if (typeof computeStats === 'function') {
      try { computeStats(state.pts.map((p) => ({ lat: p.lat, lon: p.lon, speed: p.speed, t: p.t }))); } catch (_) {}
    }
  }
  async function onPlay() {
    if (state.pts.length < 2) {
      const pts = await loadData();
      if (!pts) return;
      buildTimeline();
      mountRoute(pts);
    }
    buildHud();
    $('player').classList.add('open');
    if (state.playing) pause(); else play();
  }

  function bind() {
    const route = $('dt-route'), playBtn = $('dt-play'), clear = $('dt-clear');
    if (route) route.onclick = onShowRoute;
    if (playBtn) playBtn.onclick = onPlay;
    if (clear) clear.onclick = () => {
      stop(); clearAll();
      const rs = $('dt-route-stats'); if (rs) rs.classList.remove('open');
    };
    const plPlay = $('pl-play'); if (plPlay) plPlay.onclick = () => (state.playing ? pause() : play());
    const plClose = $('pl-close'); if (plClose) plClose.onclick = stop;
    const range = $('pl-range');
    if (range) range.oninput = (e) => {
      const wasPlaying = state.playing;
      pause();
      state.clock = clamp((+e.target.value / 1000) * state.total, 0, state.total);
      state._i = 1;
      render();
      if (wasPlaying) play();
    };
    document.querySelectorAll('.spd button').forEach((btn) => btn.onclick = () => {
      document.querySelectorAll('.spd button').forEach((x) => x.classList.remove('active'));
      btn.classList.add('active');
      state.speed = +btn.dataset.spd;
    });
  }
  bind();
  // ui-v2.js reubica #dt-route/#dt-play dentro de una barra de acciones; los
  // nodos conservan estos onclick al moverse, pero por si el orden de carga
  // cambia, re-enganchamos tras el arranque.
  setTimeout(bind, 300);

  /* ---- Helpers tolerantes a que app.js aún no exista ---------------------- */
  function toastMsg(m) { if (typeof toast === 'function') toast(m); }
  function fmtTimeSafe(t) { return typeof fmtTime === 'function' ? fmtTime(t) : new Date(t).toLocaleString('es-CO', { hour12: false }); }
  function fmtHMSafe(t) { return typeof fmtHM === 'function' ? fmtHM(t) : new Date(t).toLocaleTimeString('es-CO', { hour12: false, hour: '2-digit', minute: '2-digit' }); }

  // Reescala el vehículo al hacer zoom (mantiene proporción nítida)
  map.on('zoomend', () => { if (state.vehMarker) state.vehMarker.setIcon(makeVehIcon()); });
})();
