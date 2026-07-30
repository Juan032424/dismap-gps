/* ============================================================================
   DISMAP GPS · Pantalla de acceso — mapa vivo y microinteracciones.
   Sin librerías: canvas 2D + Web Animations nativas. Todo el movimiento usa
   transform/opacity y delta-time, así se ve igual de fluido a 60 o 240 Hz.
   Módulos: [Mapa vivo] [Parallax] [Botón magnético + ripple] [Campos] [Estado]
   ========================================================================= */
'use strict';

(function () {
  const login = document.getElementById('login');
  if (!login) return;
  const $id = (s) => document.getElementById(s);
  const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ==========================================================================
     MAPA VIVO — ciudad generativa con flota en movimiento
     Capa estática (calles) pre-renderizada una vez; cada frame solo dibuja
     cámara + vehículos + efectos. Se pausa si el login no está visible.
     ======================================================================== */
  const canvas = $id('lg-canvas');
  const ctx = canvas.getContext('2d');

  // --- Mundo ---------------------------------------------------------------
  const W = 2200, H = 1500;                 // unidades de mundo
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  // Retícula urbana: avenidas mayores y calles menores con separación irregular
  function buildAxes(total, min, max) {
    const out = [rnd(30, 90)];
    while (out[out.length - 1] < total - 120) out.push(out[out.length - 1] + rnd(min, max));
    return out;
  }
  const xs = buildAxes(W, 90, 210);
  const ys = buildAxes(H, 90, 200);
  const majorX = xs.filter((_, i) => i % 4 === 1);
  const majorY = ys.filter((_, i) => i % 4 === 2);

  // Capa estática: se dibuja una sola vez
  const staticLayer = document.createElement('canvas');
  staticLayer.width = W; staticLayer.height = H;
  (function paintStatic() {
    const s = staticLayer.getContext('2d');
    const bg = s.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#081120'); bg.addColorStop(.55, '#0A1424'); bg.addColorStop(1, '#070E1A');
    s.fillStyle = bg; s.fillRect(0, 0, W, H);

    // Manzanas apenas insinuadas
    s.fillStyle = 'rgba(148,190,240,0.016)';
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
      if (Math.random() < .5) s.fillRect(xs[i] + 7, ys[j] + 7, xs[i + 1] - xs[i] - 14, ys[j + 1] - ys[j] - 14);
    }
    // Calles menores
    s.strokeStyle = 'rgba(96,165,250,0.075)'; s.lineWidth = 1.1;
    s.beginPath();
    xs.forEach((x) => { s.moveTo(x, 0); s.lineTo(x, H); });
    ys.forEach((y) => { s.moveTo(0, y); s.lineTo(W, y); });
    s.stroke();
    // Avenidas
    s.strokeStyle = 'rgba(96,165,250,0.16)'; s.lineWidth = 2.4;
    s.beginPath();
    majorX.forEach((x) => { s.moveTo(x, 0); s.lineTo(x, H); });
    majorY.forEach((y) => { s.moveTo(0, y); s.lineTo(W, y); });
    s.stroke();
    // Una diagonal, como toda ciudad real tiene
    s.strokeStyle = 'rgba(96,165,250,0.10)'; s.lineWidth = 2;
    s.beginPath(); s.moveTo(W * .08, H * .95); s.lineTo(W * .8, H * .06); s.stroke();
    // Luz ambiental
    const gl = s.createRadialGradient(W * .3, H * .35, 60, W * .3, H * .35, W * .55);
    gl.addColorStop(0, 'rgba(30,127,239,0.07)'); gl.addColorStop(1, 'rgba(30,127,239,0)');
    s.fillStyle = gl; s.fillRect(0, 0, W, H);
  })();

  // --- Flota ---------------------------------------------------------------
  const snap = (arr, v) => arr.reduce((p, c) => Math.abs(c - v) < Math.abs(p - v) ? c : p);

  function manhattanPath(x, y, steps) {
    const pts = [{ x, y }];
    let horizontal = Math.random() < .5;
    for (let i = 0; i < steps; i++) {
      const last = pts[pts.length - 1];
      let nx = last.x, ny = last.y;
      if (horizontal) {
        nx = snap(xs, last.x + pick([-1, 1]) * rnd(140, 420));
        nx = Math.max(xs[0], Math.min(xs[xs.length - 1], nx));
      } else {
        ny = snap(ys, last.y + pick([-1, 1]) * rnd(120, 380));
        ny = Math.max(ys[0], Math.min(ys[ys.length - 1], ny));
      }
      if (nx !== last.x || ny !== last.y) pts.push({ x: nx, y: ny });
      horizontal = !horizontal;
    }
    return pts;
  }

  const BLUE = '#3B82F6', LIVE = '#16B364';
  const vehicles = Array.from({ length: 9 }, (_, i) => {
    const x = snap(xs, rnd(W * .1, W * .9)), y = snap(ys, rnd(H * .1, H * .9));
    return {
      path: manhattanPath(x, y, 9), seg: 0, t: 0,
      speed: rnd(46, 92), color: i % 3 === 0 ? LIVE : BLUE,
      trail: [], trailTimer: 0, x, y, heading: 0,
    };
  });

  // Puntos de interés (sedes) con pulso
  const pois = Array.from({ length: 4 }, () => ({
    x: snap(majorX.length ? majorX : xs, rnd(W * .15, W * .85)),
    y: snap(majorY.length ? majorY : ys, rnd(H * .2, H * .8)),
    phase: rnd(0, Math.PI * 2),
  }));

  // Geocercas: un círculo y un polígono
  const fenceC = { x: pois[0].x, y: pois[0].y, r: 150 };
  const fenceP = (() => {
    const cx = pois[2].x, cy = pois[2].y;
    return [[-170, -90], [120, -150], [200, 60], [30, 160], [-150, 110]]
      .map(([dx, dy]) => ({ x: cx + dx, y: cy + dy }));
  })();

  // Partículas de atmósfera
  const parts = Array.from({ length: 34 }, () => ({
    x: rnd(0, W), y: rnd(0, H), vx: rnd(-4, 4), vy: rnd(-3, 3),
    r: rnd(.8, 2), ph: rnd(0, Math.PI * 2),
  }));

  // --- Cámara y render -------------------------------------------------------
  let dpr = 1, vw = 0, vh = 0;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = canvas.clientWidth; vh = canvas.clientHeight;
    canvas.width = Math.max(1, vw * dpr);
    canvas.height = Math.max(1, vh * dpr);
  }
  resize();
  window.addEventListener('resize', resize);

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };   // parallax de cámara (lerp)
  let dashShift = 0;

  function stepVehicle(v, dt) {
    const a = v.path[v.seg], b = v.path[v.seg + 1];
    if (!b) { v.path = manhattanPath(v.x, v.y, 9); v.seg = 0; v.t = 0; return; }
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    v.t += (v.speed * dt) / len;
    if (v.t >= 1) { v.seg++; v.t = 0; return; }
    v.x = a.x + dx * v.t; v.y = a.y + dy * v.t;
    v.heading = Math.atan2(dy, dx);
    v.trailTimer += dt;
    if (v.trailTimer > .07) {
      v.trailTimer = 0;
      v.trail.push({ x: v.x, y: v.y });
      if (v.trail.length > 46) v.trail.shift();
    }
  }

  function render(now, dt) {
    const t = now / 1000;

    // Cámara: paneo y respiración de zoom (Ken Burns permanente)
    mouse.x += (mouse.tx - mouse.x) * Math.min(1, dt * 3);
    mouse.y += (mouse.ty - mouse.y) * Math.min(1, dt * 3);
    const cx = W / 2 + Math.sin(t * .05) * 170 + mouse.x * 60;
    const cy = H / 2 + Math.cos(t * .038) * 130 + mouse.y * 45;
    const cover = Math.max(vw / W, vh / H);
    const zoom = cover * (1.14 + Math.sin(t * .042) * .05);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.translate(vw / 2, vh / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-cx, -cy);

    ctx.drawImage(staticLayer, 0, 0);

    // Geocerca circular (pulso lento de opacidad)
    const fa = .5 + Math.sin(t * .9) * .18;
    ctx.strokeStyle = `rgba(22,179,100,${.35 * fa})`;
    ctx.fillStyle = `rgba(22,179,100,${.05 * fa})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(fenceC.x, fenceC.y, fenceC.r, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();

    // Geocerca poligonal
    ctx.strokeStyle = `rgba(96,165,250,${.32 * fa})`;
    ctx.fillStyle = `rgba(59,130,246,${.045 * fa})`;
    ctx.beginPath();
    fenceP.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // Líneas de enlace vehículo → sede más cercana (flujo de datos)
    dashShift -= dt * 26;
    ctx.save();
    ctx.setLineDash([5, 11]); ctx.lineDashOffset = dashShift;
    ctx.strokeStyle = 'rgba(96,165,250,0.10)'; ctx.lineWidth = 1;
    vehicles.slice(0, 5).forEach((v) => {
      let best = pois[0], bd = Infinity;
      pois.forEach((p) => { const d = (p.x - v.x) ** 2 + (p.y - v.y) ** 2; if (d < bd) { bd = d; best = p; } });
      ctx.beginPath(); ctx.moveTo(v.x, v.y); ctx.lineTo(best.x, best.y); ctx.stroke();
    });
    ctx.restore();

    // Sedes con anillos de pulso
    pois.forEach((p) => {
      const k = ((t + p.phase) % 2.6) / 2.6;
      ctx.strokeStyle = `rgba(96,165,250,${(1 - k) * .5})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 8 + k * 46, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#93C5FD';
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
    });

    // Estelas y vehículos
    vehicles.forEach((v) => {
      stepVehicle(v, dt);
      if (v.trail.length > 1) {
        for (let i = 1; i < v.trail.length; i++) {
          const a = v.trail[i - 1], b = v.trail[i];
          ctx.strokeStyle = v.color === LIVE
            ? `rgba(22,179,100,${(i / v.trail.length) * .5})`
            : `rgba(59,130,246,${(i / v.trail.length) * .5})`;
          ctx.lineWidth = 2.2 * (i / v.trail.length) + .4;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      // Halo + flecha orientada al rumbo
      ctx.save();
      ctx.translate(v.x, v.y); ctx.rotate(v.heading + Math.PI / 2);
      ctx.shadowColor = v.color; ctx.shadowBlur = 14;
      ctx.fillStyle = v.color;
      ctx.beginPath();
      ctx.moveTo(0, -8); ctx.lineTo(5.5, 7); ctx.lineTo(0, 3.5); ctx.lineTo(-5.5, 7);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    });

    // Partículas
    parts.forEach((p) => {
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.fillStyle = `rgba(147,197,253,${.10 + Math.sin(t * 1.4 + p.ph) * .07})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    });
  }

  // Bucle con delta-time; se detiene si el login deja de estar visible
  let raf = 0, last = 0;
  function loop(now) {
    if (login.style.display === 'none') { raf = 0; watchReturn(); return; }
    const dt = Math.min((now - last) / 1000 || .016, .05);
    last = now;
    if (!document.hidden) render(now, dt);
    raf = requestAnimationFrame(loop);
  }
  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); } }
  function watchReturn() {
    const mo = new MutationObserver(() => {
      if (login.style.display !== 'none') { mo.disconnect(); resize(); start(); }
    });
    mo.observe(login, { attributes: true, attributeFilter: ['style'] });
  }

  if (REDUCE) {
    // Sin movimiento: un solo cuadro estático, igual de cuidado
    render(performance.now(), 0);
  } else {
    start();
  }

  /* ==========================================================================
     PARALLAX — el escenario y la tarjeta responden al puntero
     ======================================================================== */
  const story = $id('lg-story');
  const card = $id('login-form');
  if (!REDUCE && window.matchMedia('(pointer:fine)').matches) {
    let px = 0, py = 0, tx = 0, ty = 0, parRaf = 0;
    login.addEventListener('pointermove', (e) => {
      tx = (e.clientX / window.innerWidth - .5);
      ty = (e.clientY / window.innerHeight - .5);
      mouse.tx = tx; mouse.ty = ty;              // también inclina la cámara del mapa
      if (!parRaf) parRaf = requestAnimationFrame(applyParallax);
    });
    function applyParallax() {
      parRaf = 0;
      px += (tx - px) * .08; py += (ty - py) * .08;
      if (story) story.style.transform = `translate3d(${px * -10}px, ${py * -7}px, 0)`;
      if (card) card.style.transform = `translate3d(${px * 7}px, ${py * 5}px, 0)`;
      if (Math.abs(tx - px) > .001 || Math.abs(ty - py) > .001) parRaf = requestAnimationFrame(applyParallax);
    }
  }

  /* ==========================================================================
     BOTÓN — magnético, con onda al pulsar
     ======================================================================== */
  const btn = $id('login-btn');
  if (btn && !REDUCE && window.matchMedia('(pointer:fine)').matches) {
    let pressed = false;
    const setT = (x, y) => { btn.style.transform = `translate3d(${x}px,${y}px,0) scale(${pressed ? .985 : 1})`; };
    card.addEventListener('pointermove', (e) => {
      const r = btn.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy);
      if (d < 130) setT(dx * .12, dy * .18); else setT(0, 0);
    });
    card.addEventListener('pointerleave', () => setT(0, 0));
    btn.addEventListener('pointerdown', () => { pressed = true; });
    window.addEventListener('pointerup', () => { if (pressed) { pressed = false; setT(0, 0); } });
  }
  if (btn) {
    btn.addEventListener('pointerdown', (e) => {
      if (REDUCE) return;
      const r = btn.getBoundingClientRect();
      const rip = document.createElement('span');
      rip.className = 'lg-ripple';
      const size = Math.max(r.width, r.height);
      rip.style.width = rip.style.height = size + 'px';
      rip.style.left = (e.clientX - r.left - size / 2) + 'px';
      rip.style.top = (e.clientY - r.top - size / 2) + 'px';
      btn.appendChild(rip);
      rip.addEventListener('animationend', () => rip.remove());
    });
  }

  /* ==========================================================================
     CAMPOS — ver contraseña, sacudida en error, recuperación
     ======================================================================== */
  const peek = $id('lg-peek');
  const pass = $id('login-pass');
  const EYE = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.9 10.9 0 0 1 12 19c-6.5 0-10-7-10-7a19.8 19.8 0 0 1 4.2-4.9M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a19.9 19.9 0 0 1-2.6 3.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>';
  if (peek && pass) {
    peek.addEventListener('click', () => {
      const show = pass.type === 'password';
      pass.type = show ? 'text' : 'password';
      peek.innerHTML = show ? EYE_OFF : EYE;
      peek.setAttribute('aria-pressed', String(show));
      peek.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
      pass.focus({ preventScroll: true });
    });
  }

  // La lógica de acceso vive en app.js y escribe en #login-error;
  // aquí solo se añade la sacudida cuando aparece un error nuevo.
  const note = $id('login-error');
  if (note) {
    new MutationObserver(() => {
      if (note.textContent && !note.classList.contains('is-info')) {
        note.classList.remove('is-shake');
        void note.offsetWidth;                  // reinicia la animación
        note.classList.add('is-shake');
      }
    }).observe(note, { childList: true, characterData: true, subtree: true });
  }

  const forgot = $id('lg-forgot');
  if (forgot && note) {
    forgot.addEventListener('click', () => {
      note.classList.add('is-info');
      note.classList.remove('is-shake');
      note.textContent = 'Pídele al administrador del sistema que restablezca tu contraseña desde el panel de usuarios.';
      setTimeout(() => { if (note.classList.contains('is-info')) { note.textContent = ''; note.classList.remove('is-info'); } }, 9000);
    });
  }
  // Cualquier intento nuevo limpia el modo informativo
  const form = $id('login-form');
  if (form && note) form.addEventListener('submit', () => note.classList.remove('is-info'));

  /* ==========================================================================
     ESTADO DEL SERVIDOR — latido cada 30 s mientras el login esté visible
     ======================================================================== */
  const statusBox = $id('lg-status');
  const statusTxt = $id('lg-status-txt');
  async function ping() {
    if (!statusBox || login.style.display === 'none') return;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 6000);
    try {
      await fetch('/', { method: 'HEAD', cache: 'no-store', signal: ac.signal });
      statusBox.classList.add('is-online'); statusBox.classList.remove('is-offline');
      statusTxt.textContent = 'Servidor en línea';
    } catch {
      statusBox.classList.add('is-offline'); statusBox.classList.remove('is-online');
      statusTxt.textContent = 'Sin conexión';
    } finally {
      clearTimeout(to);
    }
  }
  ping();
  setInterval(ping, 30000);
})();
