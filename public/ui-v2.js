/* ============================================================================
   DISMAP GPS · UI v2 — Interacción, accesibilidad y experiencia (Etapas 1-4).

   Progressive enhancement: se carga DESPUÉS de app.js y NO reescribe su lógica.
   Observa el DOM y reorganiza/añade, reutilizando los contratos existentes
   (ids, clases "open"/"active"/"sel", data-*). Rollback = quitar este <script>.

   Contenido:
    1. Velo móvil (tocar fuera para cerrar)          6. Filtros y fechas en alertas
    2. Escape cierra paneles y modales               7. Destello al llegar posición
    3. Pestañas accesibles (ARIA + flechas)          8. Panel lateral plegable
    4. Foco gestionado en modales                    9. Navegación inferior móvil
    5. Búsqueda local en administración             10. Búsqueda con retardo
    11. Confirmar borrado de geocerca               12. Esqueletos de carga
    13. Pestañas dentro del panel de detalle
   ========================================================================= */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  if (!app) return;

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const isMobile = () => window.matchMedia('(max-width: 900px)').matches;
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Reajusta Leaflet tras cambiar el tamaño de un panel. */
  const remap = () => { try { if (typeof map !== 'undefined' && map.invalidateSize) setTimeout(() => map.invalidateSize(), 240); } catch (_) {} };

  /* ======================================================================
     1) Velo: tocar fuera para cerrar (visible solo en móvil, vía CSS)
     ====================================================================== */
  const sidePanels = () => [$('detail'), $('alerts')].filter(Boolean);
  const scrim = document.createElement('div');
  scrim.className = 'uiv2-scrim';
  scrim.setAttribute('aria-hidden', 'true');
  (document.querySelector('main') || document.body).appendChild(scrim);

  const anyPanelOpen = () => sidePanels().some((p) => p.classList.contains('open'));
  const syncScrim = () => scrim.classList.toggle('show', anyPanelOpen());
  scrim.addEventListener('click', () => { sidePanels().forEach((p) => p.classList.remove('open')); syncScrim(); });
  sidePanels().forEach((p) => new MutationObserver(syncScrim).observe(p, { attributes: true, attributeFilter: ['class'] }));
  syncScrim();

  /* ======================================================================
     2) Escape cierra lo que esté abierto
     ====================================================================== */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    let closed = false;
    document.querySelectorAll('.modal.open').forEach((m) => { m.classList.remove('open'); closed = true; });
    ['detail', 'alerts'].forEach((id) => { const p = $(id); if (p && p.classList.contains('open')) { p.classList.remove('open'); closed = true; } });
    const player = $('player');
    if (player && player.classList.contains('open')) { const b = $('pl-close'); if (b) { b.click(); closed = true; } }
    if (closed) syncScrim();
  });

  /* ======================================================================
     3) Pestañas accesibles: roles ARIA + flechas (refleja la clase "active")
     ====================================================================== */
  function setupTablist(list) {
    const tabs = [...list.querySelectorAll('.tab')];
    if (!tabs.length) return;
    list.setAttribute('role', 'tablist');
    tabs.forEach((tab) => {
      tab.setAttribute('role', 'tab');
      const pid = tab.dataset.tab ? 'panel-' + tab.dataset.tab
                : tab.dataset.atab ? 'atab-' + tab.dataset.atab
                : tab.dataset.dtab ? 'dtab-' + tab.dataset.dtab : null;
      if (pid) { tab.setAttribute('aria-controls', pid); const p = $(pid); if (p) p.setAttribute('role', 'tabpanel'); }
      const sync = () => {
        const on = tab.classList.contains('active');
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
      };
      sync();
      new MutationObserver(sync).observe(tab, { attributes: true, attributeFilter: ['class'] });
      tab.addEventListener('keydown', (e) => {
        const i = tabs.indexOf(tab);
        let j = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = tabs.length - 1;
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tab.click(); return; }
        if (j !== null) { e.preventDefault(); tabs[j].click(); tabs[j].focus(); }
      });
    });
  }

  /* ======================================================================
     4) Modales: foco al abrir, trampa de Tab, devolución del foco al cerrar
     ====================================================================== */
  document.querySelectorAll('#app .modal').forEach((modal) => {
    let opener = null;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const t = modal.querySelector('.title');
    if (t) { if (!t.id) t.id = 'uiv2-t-' + Math.random().toString(36).slice(2, 7); modal.setAttribute('aria-labelledby', t.id); }
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const items = [...modal.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    new MutationObserver(() => {
      if (modal.classList.contains('open')) {
        opener = document.activeElement;
        modal.addEventListener('keydown', onKey);
        setTimeout(() => {
          const el = modal.querySelector('input,select,textarea,button:not(.close)') || modal.querySelector(FOCUSABLE);
          if (el) el.focus();
        }, 40);
      } else {
        modal.removeEventListener('keydown', onKey);
        if (opener && document.contains(opener)) { try { opener.focus(); } catch (_) {} }
        opener = null;
      }
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  });

  /* ======================================================================
     5) Administración: búsqueda local (no consulta al servidor)
     ====================================================================== */
  function attachLocalSearch(listId, placeholder) {
    const list = $(listId);
    if (!list || list.dataset.uiv2Search) return;
    list.dataset.uiv2Search = '1';
    const box = document.createElement('input');
    box.type = 'search'; box.className = 'uiv2-admin-search';
    box.placeholder = placeholder; box.setAttribute('aria-label', placeholder);
    list.parentNode.insertBefore(box, list);
    const apply = () => {
      const q = box.value.trim().toLowerCase();
      let shown = 0;
      list.querySelectorAll('.admin-row').forEach((row) => {
        const ok = !q || row.textContent.toLowerCase().includes(q);
        row.style.display = ok ? '' : 'none';
        if (ok) shown++;
      });
      let empty = list.querySelector('.uiv2-no-results');
      if (q && shown === 0) {
        if (!empty) { empty = document.createElement('div'); empty.className = 'al-empty uiv2-no-results'; empty.textContent = 'Sin coincidencias.'; list.appendChild(empty); }
      } else if (empty) empty.remove();
    };
    box.addEventListener('input', apply);
    new MutationObserver(() => { if (box.value) apply(); }).observe(list, { childList: true });
  }
  attachLocalSearch('dv-list', 'Buscar dispositivo por nombre, placa o ID…');
  attachLocalSearch('us-list', 'Buscar usuario por nombre o correo…');

  /* ======================================================================
     6) Alertas: filtros por severidad/estado + búsqueda + agrupación por fecha
        app.js reescribe #al-list en cada render; aquí post-procesamos.
     ====================================================================== */
  const alList = $('al-list');
  if (alList) {
    const bar = document.createElement('div');
    bar.className = 'uiv2-al-filters';
    bar.innerHTML =
      '<div class="uiv2-chips" role="group" aria-label="Filtrar alertas por severidad">' +
      '<button class="uiv2-chip active" data-sev="all">Todas</button>' +
      '<button class="uiv2-chip" data-sev="critical">Críticas</button>' +
      '<button class="uiv2-chip" data-sev="warning">Advertencias</button>' +
      '<button class="uiv2-chip" data-sev="info">Informativas</button>' +
      '<button class="uiv2-chip" data-sev="unack">Sin ver</button>' +
      '</div>' +
      '<input type="search" class="uiv2-al-search" placeholder="Buscar por vehículo o texto…" aria-label="Buscar alertas">';
    alList.parentNode.insertBefore(bar, alList);

    let sev = 'all';
    const search = bar.querySelector('.uiv2-al-search');
    bar.querySelectorAll('.uiv2-chip').forEach((c) => c.addEventListener('click', () => {
      bar.querySelectorAll('.uiv2-chip').forEach((x) => x.classList.remove('active'));
      c.classList.add('active'); sev = c.dataset.sev; applyAlerts();
    }));
    search.addEventListener('input', () => applyAlerts());

    const dayLabel = (txt) => {
      // fmtTime() produce "d/m/aaaa, hh:mm:ss" en es-CO → tomamos la fecha
      const datePart = (txt.split(',')[0] || '').trim();
      const hoy = new Date().toLocaleDateString('es-CO');
      const ayer = new Date(Date.now() - 86400000).toLocaleDateString('es-CO');
      if (datePart === hoy) return 'Hoy';
      if (datePart === ayer) return 'Ayer';
      return datePart;
    };

    function applyAlerts() {
      const q = search.value.trim().toLowerCase();
      alList.querySelectorAll('.uiv2-day').forEach((d) => d.remove());
      const items = [...alList.querySelectorAll('.al-item')];
      let visibles = 0, lastDay = null;
      items.forEach((it) => {
        const dot = it.querySelector('.al-dot');
        const sevOf = dot ? (dot.classList.contains('critical') ? 'critical' : dot.classList.contains('warning') ? 'warning' : 'info') : 'info';
        const ack = it.classList.contains('ack');
        const okSev = sev === 'all' || (sev === 'unack' ? !ack : sevOf === sev);
        const okTxt = !q || it.textContent.toLowerCase().includes(q);
        const show = okSev && okTxt;
        it.style.display = show ? '' : 'none';
        if (!show) return;
        visibles++;
        const timeTxt = (it.querySelector('.al-time') || {}).textContent || '';
        const day = dayLabel(timeTxt);
        if (day !== lastDay) {
          const h = document.createElement('div');
          h.className = 'uiv2-day'; h.textContent = day;
          alList.insertBefore(h, it);
          lastDay = day;
        }
      });
      let empty = alList.querySelector('.uiv2-al-empty');
      if (items.length && visibles === 0) {
        if (!empty) { empty = document.createElement('div'); empty.className = 'al-empty uiv2-al-empty'; empty.textContent = 'Ninguna alerta coincide con el filtro.'; alList.appendChild(empty); }
      } else if (empty) empty.remove();
    }
    // Reprocesar cada vez que app.js repinte la lista
    let alT = null;
    new MutationObserver(() => { clearTimeout(alT); alT = setTimeout(applyAlerts, 30); })
      .observe(alList, { childList: true });
    applyAlerts();
  }

  /* ======================================================================
     7) Destello sutil en la tarjeta al llegar una posición nueva
     ====================================================================== */
  const fleetBox = $('fleet');
  if (fleetBox) {
    new MutationObserver((muts) => {
      if (reduceMotion()) return;
      const rows = new Set();
      muts.forEach((m) => {
        const row = m.target.closest ? m.target.closest('.row') : null;
        if (row) rows.add(row);
      });
      rows.forEach((row) => {
        row.classList.remove('uiv2-ping');
        void row.offsetWidth;           // reinicia la animación
        row.classList.add('uiv2-ping');
        setTimeout(() => row.classList.remove('uiv2-ping'), 900);
      });
    }).observe(fleetBox, { childList: true, subtree: true });
  }

  /* ======================================================================
     8) Panel lateral plegable (escritorio) — no destruye su contenido
     ====================================================================== */
  const aside = document.querySelector('#app aside');
  if (aside) {
    const btn = document.createElement('button');
    btn.className = 'uiv2-collapse';
    btn.type = 'button';
    btn.setAttribute('aria-controls', 'uiv2-aside');
    aside.id = aside.id || 'uiv2-aside';
    const paint = () => {
      const col = document.body.classList.contains('uiv2-aside-collapsed');
      btn.setAttribute('aria-expanded', col ? 'false' : 'true');
      btn.setAttribute('aria-label', col ? 'Mostrar panel de flota' : 'Ocultar panel de flota');
      btn.title = btn.getAttribute('aria-label');
      btn.innerHTML = col
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
    };
    btn.addEventListener('click', () => {
      document.body.classList.toggle('uiv2-aside-collapsed');
      try { localStorage.setItem('dismap_ui_aside', document.body.classList.contains('uiv2-aside-collapsed') ? '1' : '0'); } catch (_) {}
      paint(); remap();
    });
    if (localStorage.getItem('dismap_ui_aside') === '1') document.body.classList.add('uiv2-aside-collapsed');
    paint();
    (document.querySelector('main') || app).appendChild(btn);
  }

  /* ======================================================================
     9) Navegación inferior en móvil: Mapa · Flota · Alertas
     ====================================================================== */
  const nav = document.createElement('nav');
  nav.className = 'uiv2-bottomnav';
  nav.setAttribute('aria-label', 'Navegación principal');
  nav.innerHTML =
    '<button type="button" data-view="map" aria-label="Ver mapa"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg><span>Mapa</span></button>' +
    '<button type="button" data-view="fleet" aria-label="Ver flota"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="7" width="15" height="10" rx="2"/><path d="M16 10h3l3 3v4h-6z"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg><span>Flota</span></button>' +
    '<button type="button" data-view="alerts" aria-label="Ver alertas"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg><span>Alertas</span><i class="uiv2-nav-badge" hidden></i></button>';
  app.appendChild(nav);

  const navBtns = [...nav.querySelectorAll('button')];
  const setView = (view) => {
    navBtns.forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.body.classList.toggle('uiv2-map-full', view === 'map');
    if (view === 'alerts') { const b = $('btn-alerts'); if (b && !$('alerts').classList.contains('open')) b.click(); }
    else { $('alerts').classList.remove('open'); syncScrim(); }
    remap();
  };
  navBtns.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  setView('fleet');
  // Espejo del contador de alertas en la barra inferior
  const badge = $('alert-badge');
  const navBadge = nav.querySelector('.uiv2-nav-badge');
  if (badge && navBadge) {
    const syncBadge = () => {
      const n = parseInt(badge.textContent || '0', 10) || 0;
      navBadge.hidden = n === 0;
      navBadge.textContent = n > 99 ? '99+' : String(n);
    };
    new MutationObserver(syncBadge).observe(badge, { childList: true, characterData: true, subtree: true });
    syncBadge();
  }

  /* ======================================================================
     10) Búsqueda de flota con retardo (evita filtrar en cada tecla)
         app.js asigna q.oninput; lo envolvemos preservando su lógica.
     ====================================================================== */
  const q = $('q');
  if (q && typeof q.oninput === 'function') {
    const original = q.oninput;
    let t = null;
    q.oninput = function (e) {
      clearTimeout(t);
      t = setTimeout(() => original.call(this, e), 160);
    };
  }

  /* ======================================================================
     11) Geocercas: confirmar antes de eliminar (captura, sin tocar app.js)
     ====================================================================== */
  const geoList = $('geo-list');
  if (geoList) {
    geoList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="del"]');
      if (!btn) return;
      if (!window.confirm('¿Eliminar esta geocerca? Esta acción no se puede deshacer.')) {
        e.stopImmediatePropagation(); e.preventDefault();
      }
    }, true);
  }

  /* ======================================================================
     12) Esqueletos mientras carga la flota
     ====================================================================== */
  if (fleetBox && !fleetBox.children.length) {
    const sk = document.createElement('div');
    sk.className = 'uiv2-skeletons';
    sk.innerHTML = '<div class="uiv2-sk-row"></div>'.repeat(3);
    fleetBox.appendChild(sk);
    const clear = new MutationObserver(() => {
      if (fleetBox.querySelector('.row')) { sk.remove(); clear.disconnect(); }
    });
    clear.observe(fleetBox, { childList: true });
    setTimeout(() => { sk.remove(); clear.disconnect(); }, 12000); // red muy lenta
  }

  /* ======================================================================
     13) Pestañas dentro del panel de detalle
         Agrupa el contenido existente por sus .dt-section y deja las acciones
         principales siempre visibles. Se MUEVEN los nodos reales (conservan
         sus manejadores de app.js); no se clona ni se recrea nada.
     ====================================================================== */
  const dtBody = document.querySelector('#detail .dt-body');
  if (dtBody && !dtBody.dataset.uiv2Tabs) {
    dtBody.dataset.uiv2Tabs = '1';

    // (a) Barra de acciones principales, siempre visible
    const actions = document.createElement('div');
    actions.className = 'uiv2-dt-actions';
    ['dt-follow', 'dt-gmaps', 'dt-route', 'dt-play'].forEach((id) => {
      const b = $(id);
      if (b) actions.appendChild(b);   // mover conserva onclick y estado
    });

    // (b) Repartir el resto en grupos delimitados por .dt-section
    const groups = [{ name: 'Resumen', key: 'sum', nodes: [] }];
    const nameMap = { 'UBICACIÓN': ['Ubicación', 'loc'], 'ACCIONES': ['Ficha', 'cfg'], 'RECORRIDO 24 H': ['Recorrido', 'trip'] };
    [...dtBody.children].forEach((node) => {
      if (node.classList.contains('dt-section')) {
        const raw = (node.textContent || '').trim().toUpperCase();
        const [label, key] = nameMap[raw] || [raw.charAt(0) + raw.slice(1).toLowerCase(), 'g' + groups.length];
        groups.push({ name: label, key, nodes: [node] });
      } else {
        groups[groups.length - 1].nodes.push(node);
      }
    });

    // (c) Construir barra de pestañas + paneles
    const tabsBar = document.createElement('div');
    tabsBar.className = 'tabs uiv2-dt-tabs';
    const panels = document.createElement('div');
    panels.className = 'uiv2-dt-panels';

    groups.forEach((g, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab' + (i === 0 ? ' active' : '');
      tab.dataset.dtab = g.key;
      tab.textContent = g.name;
      tabsBar.appendChild(tab);

      const panel = document.createElement('div');
      panel.className = 'uiv2-dt-panel' + (i === 0 ? ' active' : '');
      panel.id = 'dtab-' + g.key;
      g.nodes.forEach((n) => panel.appendChild(n));   // mover, no clonar
      panels.appendChild(panel);

      tab.addEventListener('click', () => {
        tabsBar.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        panels.querySelectorAll('.uiv2-dt-panel').forEach((x) => x.classList.remove('active'));
        tab.classList.add('active');
        panel.classList.add('active');
      });
    });

    dtBody.appendChild(actions);
    dtBody.appendChild(tabsBar);
    dtBody.appendChild(panels);
    setupTablist(tabsBar);
  }

  // Pestañas del aside y de administración (tras crear las del detalle)
  document.querySelectorAll('#app .tabs:not(.uiv2-dt-tabs)').forEach(setupTablist);
})();
