(function () {
  'use strict';

  // ——— Calendrier paies 2026 (début fin inclusifs) ———
  const PERIODES_2026 = [
    { id: 'janvier', label: 'Janvier 2026', start: '2025-12-29', end: '2026-01-18' },
    { id: 'fevrier', label: 'Février 2026', start: '2026-01-19', end: '2026-02-15' },
    { id: 'mars', label: 'Mars 2026', start: '2026-02-16', end: '2026-03-15' },
    { id: 'avril', label: 'Avril 2026', start: '2026-03-16', end: '2026-04-19' },
    { id: 'mai', label: 'Mai 2026', start: '2026-04-20', end: '2026-05-17' },
    { id: 'juin', label: 'Juin 2026', start: '2026-05-18', end: '2026-06-14' },
    { id: 'juillet', label: 'Juillet 2026', start: '2026-06-15', end: '2026-07-19' },
    { id: 'aout', label: 'Août 2026', start: '2026-07-20', end: '2026-08-16' },
    { id: 'septembre', label: 'Septembre 2026', start: '2026-08-17', end: '2026-09-13' },
    { id: 'octobre', label: 'Octobre 2026', start: '2026-09-14', end: '2026-10-18' },
    { id: 'novembre', label: 'Novembre 2026', start: '2026-10-19', end: '2026-11-15' },
    { id: 'decembre', label: 'Décembre 2026', start: '2026-11-16', end: '2026-12-27' }
  ];

  // ——— Utilitaires dates (sans lib externe) ———
  function parseDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function toDateKey(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), j = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + j;
  }
  function formatDateFR(str) {
    const d = typeof str === 'string' ? parseDate(str) : str;
    return d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }
  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }
  function startOfISOWeek(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    date.setDate(diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }
  function endOfISOWeek(d) {
    return addDays(startOfISOWeek(d), 6);
  }
  function isoWeekNumber(d) {
    const start = startOfISOWeek(d);
    const jan1 = new Date(start.getFullYear(), 0, 1);
    const firstMonday = startOfISOWeek(jan1);
    const diff = Math.round((start - firstMonday) / (24 * 60 * 60 * 1000));
    return Math.floor(diff / 7) + 1;
  }
  function iterateDays(startStr, endStr) {
    const out = [];
    let d = parseDate(startStr);
    const end = parseDate(endStr);
    while (d <= end) {
      out.push(toDateKey(d));
      d = addDays(d, 1);
    }
    return out;
  }
  function weekMondayKey(d) { return toDateKey(startOfISOWeek(typeof d === 'string' ? parseDate(d) : d)); }

  // ——— Données applicatives ———
  let state = {
    entries: {},   
    seuilHebdo: 35
  };
  let currentWeekMonday = null;
  let currentPeriodIndex = 0;
  const DB_NAME = 'PointageHeuresDB';
  const STORE = 'data';
  const KEY = 'state';
  let saveTimeout = null;
  const DEBOUNCE_MS = 400;

  function initCurrentWeek() {
    const today = new Date();
    currentWeekMonday = startOfISOWeek(today);
  }

  function getSeuilMinutes() { return state.seuilHebdo * 60; }

  // ——— Calculs HS par semaine (clé = lundi en YYYY-MM-DD) ———
  // Tranches : normal ≤35h ; 36h-43h = 25% ; >43h = 50%. Case "50%" sur un jour => heures en HS 50%.
  const SEUIL_NORMAL_MIN = 35 * 60;
  const SEUIL_43H_MIN = 43 * 60;
  const BANDE_25_MIN = 8 * 60; // 36h à 43h

  function getHoursByWeek() {
    const byWeek = {};
    for (const dateKey of Object.keys(state.entries)) {
      const e = state.entries[dateKey];
      const min = e.minutesWorked || 0;
      const mon = weekMondayKey(dateKey);
      if (!byWeek[mon]) byWeek[mon] = { minutes: 0, forced50Minutes: 0, chantier: 0, depot: 0, gd: 0 };
      byWeek[mon].minutes += min;
      if (e.hs50) byWeek[mon].forced50Minutes += min;
      const p = (e.panier || 'none').toLowerCase();
      if (p === 'chantier') byWeek[mon].chantier++;
      else if (p === 'depot') byWeek[mon].depot++;
      else if (p === 'gd') { byWeek[mon].gd++; byWeek[mon].chantier++; }
    }
    for (const mon of Object.keys(byWeek)) {
      const w = byWeek[mon];
      const totalMin = w.minutes;
      const forced50 = w.forced50Minutes || 0;
      const otherMin = totalMin - forced50;
      w.normalMinutes = Math.min(otherMin, SEUIL_NORMAL_MIN);
      w.hs25Minutes = Math.min(Math.max(0, otherMin - SEUIL_NORMAL_MIN), BANDE_25_MIN);
      w.hs50Minutes = Math.max(0, otherMin - SEUIL_43H_MIN) + forced50;
      w.hsMinutes = w.hs25Minutes + w.hs50Minutes;
    }
    return byWeek;
  }

  function getWeekRecap(mondayDate) {
    const key = toDateKey(mondayDate);
    const byWeek = getHoursByWeek();
    const w = byWeek[key] || { minutes: 0, normalMinutes: 0, hs25Minutes: 0, hs50Minutes: 0, hsMinutes: 0, chantier: 0, depot: 0, gd: 0 };
    return {
      totalHours: w.minutes / 60,
      normalHours: w.normalMinutes / 60,
      hs25Hours: (w.hs25Minutes || 0) / 60,
      hs50Hours: (w.hs50Minutes || 0) / 60,
      hsHours: w.hsMinutes / 60,
      chantier: w.chantier,
      depot: w.depot,
      gd: w.gd
    };
  }

  // ——— Semaine dans période : lundi >= start et dimanche <= end ———
  function weekInPeriod(weekMondayStr, periodStartStr, periodEndStr) {
    const mon = parseDate(weekMondayStr);
    const sun = addDays(mon, 6);
    const start = parseDate(periodStartStr);
    const end = parseDate(periodEndStr);
    return mon >= start && sun <= end;
  }

  function getPeriodWeeks(period) {
    const list = [];
    const byWeek = getHoursByWeek();
    const start = parseDate(period.start);
    const end = parseDate(period.end);
    let d = startOfISOWeek(start);
    while (d <= end) {
      const sun = addDays(d, 6);
      if (d >= start && sun <= end) {
        const key = toDateKey(d);
        const w = byWeek[key] || { minutes: 0, normalMinutes: 0, hs25Minutes: 0, hs50Minutes: 0, hsMinutes: 0, chantier: 0, depot: 0, gd: 0 };
        list.push({
          monday: key,
          label: 'S' + isoWeekNumber(d) + ' ' + toDateKey(d) + ' → ' + toDateKey(sun),
          totalHours: w.minutes / 60,
          hsHours: w.hsMinutes / 60,
          normalHours: (w.normalMinutes || 0) / 60,
          hs25Hours: (w.hs25Minutes || 0) / 60,
          hs50Hours: (w.hs50Minutes || 0) / 60
        });
      }
      d = addDays(d, 7);
    }
    return list;
  }

  function getPeriodStats(periodIndex) {
    const period = PERIODES_2026[periodIndex];
    if (!period) return null;
    const weeks = getPeriodWeeks(period);
    let totalMinutes = 0, totalHS = 0, totalNormal = 0, totalHS25 = 0, totalHS50 = 0, chantier = 0, depot = 0, gd = 0;
    for (const w of weeks) {
      totalMinutes += w.totalHours * 60;
      totalHS += w.hsHours * 60;
      totalNormal += w.normalHours * 60;
      totalHS25 += w.hs25Hours * 60;
      totalHS50 += w.hs50Hours * 60;
    }
    for (const dateKey of iterateDays(period.start, period.end)) {
      const e = state.entries[dateKey];
      if (!e) continue;
      const p = (e.panier || 'none').toLowerCase();
      if (p === 'chantier') chantier++;
      else if (p === 'depot') depot++;
      else if (p === 'gd') { gd++; chantier++; }
    }
    const prevPeriod = periodIndex > 0 ? PERIODES_2026[periodIndex - 1] : null;
    let hsAPayer = 0;
    if (prevPeriod) {
      const prevWeeks = getPeriodWeeks(prevPeriod);
      for (const w of prevWeeks) hsAPayer += w.hsHours * 60;
    }
    return {
      label: period.label,
      start: period.start,
      end: period.end,
      totalHours: totalMinutes / 60,
      normalHours: totalNormal / 60,
      hs25Hours: totalHS25 / 60,
      hs50Hours: totalHS50 / 60,
      hsGagnees: totalHS / 60,
      hsAPayer: hsAPayer / 60,
      chantier, depot, gd,
      weeks
    };
  }

  // ——— IndexedDB ———
  function openDB() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => resolve(r.result);
      r.onupgradeneeded = (e) => {
        if (!e.target.result.objectStoreNames.contains(STORE)) e.target.result.createObjectStore(STORE);
      };
    });
  }
  function loadState() {
    return openDB().then(db => {
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    });
  }
  function saveState() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      openDB().then(db => {
        return new Promise((resolve, reject) => {
          const t = db.transaction(STORE, 'readwrite');
          const req = t.objectStore(STORE).put(state, KEY);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      }).catch(console.error);
      saveTimeout = null;
    }, DEBOUNCE_MS);
  }



  // ——— UI : Onglets ———
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      const id = 'view-' + btn.getAttribute('data-tab');
      document.getElementById(id).classList.add('active');
      if (btn.getAttribute('data-tab') === 'semaine') renderSemaine();
      if (btn.getAttribute('data-tab') === 'periode') renderPeriode();
      if (btn.getAttribute('data-tab') === 'annee') renderAnnee();
      if (btn.getAttribute('data-tab') === 'params') renderParams();
    });
  });

  // ——— Vue Semaine ———
  function getWeekDays(monday) {
    const out = [];
    for (let i = 0; i < 7; i++) out.push(addDays(monday, i));
    return out;
  }

  function renderSemaine() {
    const monday = currentWeekMonday;
    const weekKey = toDateKey(monday);
    const sun = endOfISOWeek(monday);
    document.getElementById('weekRangeLabel').textContent = 'Semaine ISO ' + isoWeekNumber(monday) + ' — ' + toDateKey(monday) + ' → ' + toDateKey(sun);
    const recap = getWeekRecap(monday);
    document.getElementById('rsTotal').textContent = recap.totalHours.toFixed(2) + ' h';
    document.getElementById('rsNormales').textContent = recap.normalHours.toFixed(2) + ' h';
    document.getElementById('rsHS25').textContent = recap.hs25Hours.toFixed(2) + ' h';
    document.getElementById('rsHS50').textContent = recap.hs50Hours.toFixed(2) + ' h';
    document.getElementById('rsChantier').textContent = recap.chantier;
    document.getElementById('rsDepot').textContent = recap.depot;
    document.getElementById('rsGD').textContent = recap.gd;

    const jours = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
    const container = document.getElementById('dayCards');
    container.innerHTML = '';
    getWeekDays(monday).forEach((day, i) => {
      const dateKey = toDateKey(day);
      const e = state.entries[dateKey] || { date: dateKey, minutesWorked: 0, panier: 'none', notes: '', hs50: false };
      const hoursVal = (e.minutesWorked / 60).toFixed(2);
      const hs50Checked = e.hs50 ? ' checked' : '';
      const card = document.createElement('div');
      card.className = 'day-card';
      card.innerHTML =
        '<div class="date-label">' + formatDateFR(day) + '</div>' +
        '<div class="day-name">' + jours[i] + ' ' + dateKey + '</div>' +
        '<label>Heures</label><input type="number" step="0.25" min="0" max="24" data-date="' + dateKey + '" data-field="hours" value="' + (e.minutesWorked ? hoursVal : '') + '" placeholder="ex: 7.5">' +
        '<label class="checkbox-label"><input type="checkbox" data-date="' + dateKey + '" data-field="hs50"' + hs50Checked + '> 50% (HS à 50%)</label>' +
        '<div class="panier-btns">' +
        ['none', 'chantier', 'depot', 'gd'].map(p => {
          const lab = { none: 'Aucun', chantier: 'Chantier', depot: 'Dépôt', gd: 'Grand déplacement' }[p];
          const sel = (e.panier || 'none').toLowerCase() === p ? 'selected' : '';
          return '<button type="button" data-date="' + dateKey + '" data-panier="' + p + '" class="' + (sel ? 'selected' : '') + '">' + lab + '</button>';
        }).join('') +
        '</div>' +
        '<label>Notes</label><input type="text" data-date="' + dateKey + '" data-field="notes" value="' + (e.notes || '').replace(/"/g, '&quot;') + '" placeholder="Notes">';
      container.appendChild(card);
    });

    container.querySelectorAll('input[data-field="hours"]').forEach(inp => {
      inp.addEventListener('change', () => {
        const dateKey = inp.getAttribute('data-date');
        const h = parseFloat(inp.value) || 0;
        if (!state.entries[dateKey]) state.entries[dateKey] = { date: dateKey, minutesWorked: 0, panier: 'none', notes: '', hs50: false };
        state.entries[dateKey].minutesWorked = Math.round(h * 60);
        saveState();
        renderSemaine();
      });
    });
    container.querySelectorAll('input[data-field="notes"]').forEach(inp => {
      inp.addEventListener('change', () => {
        const dateKey = inp.getAttribute('data-date');
        if (!state.entries[dateKey]) state.entries[dateKey] = { date: dateKey, minutesWorked: 0, panier: 'none', notes: '', hs50: false };
        state.entries[dateKey].notes = inp.value.trim();
        saveState();
      });
    });
    container.querySelectorAll('input[data-field="hs50"]').forEach(inp => {
      inp.addEventListener('change', () => {
        const dateKey = inp.getAttribute('data-date');
        if (!state.entries[dateKey]) state.entries[dateKey] = { date: dateKey, minutesWorked: 0, panier: 'none', notes: '', hs50: false };
        state.entries[dateKey].hs50 = inp.checked;
        saveState();
        renderSemaine();
      });
    });
    container.querySelectorAll('.panier-btns button').forEach(btn => {
      btn.addEventListener('click', () => {
        const dateKey = btn.getAttribute('data-date');
        const panier = btn.getAttribute('data-panier');
        if (!state.entries[dateKey]) state.entries[dateKey] = { date: dateKey, minutesWorked: 0, panier: 'none', notes: '', hs50: false };
        state.entries[dateKey].panier = panier;
        saveState();
        renderSemaine();
      });
    });
  }

  document.getElementById('prevWeek').addEventListener('click', () => { currentWeekMonday = addDays(currentWeekMonday, -7); renderSemaine(); });
  document.getElementById('nextWeek').addEventListener('click', () => { currentWeekMonday = addDays(currentWeekMonday, 7); renderSemaine(); });
  document.getElementById('todayWeek').addEventListener('click', () => { initCurrentWeek(); renderSemaine(); });

  // ——— Vue Période ———
  function renderPeriode() {
    const idx = currentPeriodIndex;
    const prevBtn = document.getElementById('prevPeriod');
    const nextBtn = document.getElementById('nextPeriod');
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= PERIODES_2026.length - 1;
    document.getElementById('periodCarouselLabel').textContent = (idx + 1) + ' / ' + PERIODES_2026.length;

    const s = getPeriodStats(idx);
    if (!s) return;
    document.getElementById('periodScreen').innerHTML =
      '<h2>' + s.label + ' (' + s.start + ' → ' + s.end + ')</h2>' +
      '<div class="stats">' +
      '<div><span>Total heures</span><strong>' + s.totalHours.toFixed(2) + ' h</strong></div>' +
      '<div><span>Heures normales (≤35h/sem.)</span><strong>' + s.normalHours.toFixed(2) + ' h</strong></div>' +
      '<div><span>Heures à 25% (36-43h/sem.)</span><strong class="hs">' + s.hs25Hours.toFixed(2) + ' h</strong></div>' +
      '<div><span>Heures à 50% (&gt;43h/sem.)</span><strong class="hs">' + s.hs50Hours.toFixed(2) + ' h</strong></div>' +
      '<div><span>HS gagnées (période)</span><strong class="hs">' + s.hsGagnees.toFixed(2) + ' h</strong></div>' +
      '<div><span>Paniers chantier / dépôt / GD</span><strong>' + s.chantier + ' / ' + s.depot + ' / ' + s.gd + '</strong></div>' +
      '</div>' +
      '<h3>Semaines incluses</h3>' +
      '<div class="weeks-list">' +
      s.weeks.map(w => w.label + ' — ' + w.totalHours.toFixed(2) + ' h (norm. ' + w.normalHours.toFixed(2) + ' · 25% ' + w.hs25Hours.toFixed(2) + ' · 50% ' + w.hs50Hours.toFixed(2) + ' h)').join('<br>') +
      '</div>';
  }

  document.getElementById('prevPeriod').addEventListener('click', () => { if (currentPeriodIndex > 0) { currentPeriodIndex--; renderPeriode(); } });
  document.getElementById('nextPeriod').addEventListener('click', () => { if (currentPeriodIndex < PERIODES_2026.length - 1) { currentPeriodIndex++; renderPeriode(); } });

  // ——— Vue Année ———
  function renderAnnee() {
    let totalH = 0, totalHS = 0, totalChantier = 0, totalDepot = 0, totalGD = 0;
    const rows = [];
    for (let i = 0; i < PERIODES_2026.length; i++) {
      const s = getPeriodStats(i);
      if (!s) continue;
      totalH += s.totalHours;
      totalHS += s.hsGagnees;
      totalChantier += s.chantier;
      totalDepot += s.depot;
      totalGD += s.gd;
      rows.push(
        '<tr><td>' + s.label + '</td><td>' + s.totalHours.toFixed(2) + '</td><td>' + s.hsGagnees.toFixed(2) + '</td><td>' + s.chantier + '</td><td>' + s.depot + '</td><td>' + s.gd + '</td></tr>'
      );
    }
    document.getElementById('recapAnnee').innerHTML =
      '<span>Heures totales: <strong>' + totalH.toFixed(2) + ' h</strong></span>' +
      '<span class="hs">HS: <strong>' + totalHS.toFixed(2) + ' h</strong></span>' +
      '<span class="paniers">Chantier: <strong>' + totalChantier + '</strong></span>' +
      '<span class="paniers">Dépôt: <strong>' + totalDepot + '</strong></span>' +
      '<span class="paniers">GD: <strong>' + totalGD + '</strong></span>';
    document.getElementById('tbodyAnnee').innerHTML = rows.join('');
  }

  // ——— Paramètres ———
  function renderParams() {
    document.getElementById('seuilHebdo').value = state.seuilHebdo;
    document.getElementById('seuilHebdo').onchange = () => {
      const v = parseFloat(document.getElementById('seuilHebdo').value);
      if (!isNaN(v) && v >= 1 && v <= 60) { state.seuilHebdo = v; saveState(); }
    };
  }

  document.getElementById('exportJson').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ entries: state.entries, seuilHebdo: state.seuilHebdo }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pointage-' + toDateKey(new Date()) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('downloadPdf').addEventListener('click', () => {
    let totalH = 0, totalHS = 0, totalChantier = 0, totalDepot = 0, totalGD = 0;
    const rows = [];
    for (let i = 0; i < PERIODES_2026.length; i++) {
      const s = getPeriodStats(i);
      if (!s) continue;
      totalH += s.totalHours;
      totalHS += s.hsGagnees;
      totalChantier += s.chantier;
      totalDepot += s.depot;
      totalGD += s.gd;
      rows.push('<tr><td>' + s.label + '</td><td>' + s.totalHours.toFixed(2) + '</td><td>' + s.hsGagnees.toFixed(2) + '</td><td>' + s.chantier + '</td><td>' + s.depot + '</td><td>' + s.gd + '</td></tr>');
    }
    const html = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Pointage Heures - Synthèse 2026</title>' +
      '<style>body{font-family:Segoe UI,sans-serif;padding:1.5rem;color:#1a1b26;} h1{font-size:1.25rem;} table{width:100%;border-collapse:collapse;margin-top:1rem;} th,td{padding:0.5rem;text-align:left;border:1px solid #ccc;} th{background:#eee;} .recap{margin:1rem 0;padding:0.75rem;background:#f5f5f5;border-radius:6px;} .recap strong{margin-right:1rem;} @media print{body{padding:0;} .no-print{display:none;}}</style></head><body>' +
      '<h1>Pointage Heures — Synthèse 2026</h1>' +
      '<p>Généré le ' + formatDateFR(new Date()) + '</p>' +
      '<div class="recap"><strong>Heures totales:</strong> ' + totalH.toFixed(2) + ' h — <strong>HS:</strong> ' + totalHS.toFixed(2) + ' h — <strong>Chantier:</strong> ' + totalChantier + ' — <strong>Dépôt:</strong> ' + totalDepot + ' — <strong>GD:</strong> ' + totalGD + '</div>' +
      '<table><thead><tr><th>Période</th><th>Heures</th><th>HS gagnées</th><th>Chantier</th><th>Dépôt</th><th>GD</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>' +
      '<p class="no-print" style="margin-top:1.5rem;font-size:0.9rem;color:#666;">Dans la boîte de dialogue d\'impression, choisissez « Enregistrer au format PDF » pour télécharger en PDF.</p>' +
      '</body></html>';
    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(function () { win.print(); win.onafterprint = function () { win.close(); }; }, 250);
  });

  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (data.entries && typeof data.entries === 'object') state.entries = data.entries;
        if (typeof data.seuilHebdo === 'number') state.seuilHebdo = data.seuilHebdo;
        saveState();
        renderSemaine();
        renderPeriode();
        renderAnnee();
        alert('Import réussi.');
      } catch (err) { alert('Fichier JSON invalide.'); }
    };
    r.readAsText(f);
    e.target.value = '';
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Réinitialiser toutes les données ? Cette action est irréversible.')) return;
    state.entries = {};
    state.seuilHebdo = 35;
    saveState();
    initCurrentWeek();
    renderSemaine();
    renderPeriode();
    renderAnnee();
    renderParams();
    alert('Données réinitialisées.');
  });

  // ——— Démarrage ———
  initCurrentWeek();
  loadState().then(saved => {
    if (saved && saved.entries) state.entries = saved.entries;
    if (saved && typeof saved.seuilHebdo === 'number') state.seuilHebdo = saved.seuilHebdo;
    maybeSeedDemo();
    renderSemaine();
  }).catch(() => {
    maybeSeedDemo();
    renderSemaine();
  });
})();
