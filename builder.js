/* 40k Codex — Army Builder.
   Separate mode (#/b) on top of the data model and helpers in app.js.
   Rules come from the game system data: battle sizes, points / Detachment Points / Enhancements limits
   (Army Roster force constraints), unit and category maximums, Character minimum. */
'use strict';

const Builder = (() => {
  const KEY = 'rosters';
  let rosters = store.get(KEY, []);
  let cur = null;
  const ui = { q: '', cat: null, allies: false, creating: false, mode: 'edit', sel: null, form: null };

  const persist = () => { store.set(KEY, rosters); Sync.schedule(); };
  const save = () => { if (cur) cur.updated = Date.now(); persist(); };
  const newId = () => Math.random().toString(36).slice(2, 10);
  const el = () => $('#builder');

  /* =====================================================================
     Sync between devices through a private GitHub Gist.
     The token and Gist id stay in this browser only. Rosters are merged by their "updated" time;
     deleted rosters are remembered (tombstones) so a deletion also reaches the other devices.
     ===================================================================== */
  const Sync = {
    FILE: '40k-codex-rosters.json',
    API: 'https://api.github.com',
    busy: false, timer: null, last: store.get('syncLast', 0), error: '', lastPull: 0,
    token() { return store.get('ghToken', ''); },
    gistId() { return store.get('gistId', ''); },
    on() { return !!(this.token() && this.gistId()); },
    deleted() { return store.get('rosterDeleted', {}); },
    /* Play games (play.js) travel in the same Gist file */
    games() { return store.get('games', []); },
    gamesDeleted() { return store.get('gameDeleted', {}); },
    async req(path, opts) {
      const r = await fetch(this.API + path, Object.assign({}, opts, {
        headers: Object.assign({ Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + this.token() }, opts && opts.body ? { 'Content-Type': 'application/json' } : {}),
      }));
      if (!r.ok) throw new Error('GitHub ' + r.status + (r.status === 401 ? ' (token)' : r.status === 404 ? ' (Gist)' : ''));
      return r.status === 204 ? null : r.json();
    },
    payload() { return { app: '40k-codex', version: 2, updated: Date.now(), rosters, deleted: this.deleted(), games: this.games(), gamesDeleted: this.gamesDeleted() }; },
    /* finds an existing Gist with our file, otherwise creates a private one */
    async connect(token) {
      store.set('ghToken', token.trim());
      store.set('gistId', '');
      for (let page = 1; page <= 5; page++) {
        const list = await this.req(`/gists?per_page=100&page=${page}`);
        const hit = arr(list).find(g => g.files && g.files[this.FILE]);
        if (hit) { store.set('gistId', hit.id); break; }
        if (arr(list).length < 100) break;
      }
      if (!this.gistId()) {
        const g = await this.req('/gists', { method: 'POST', body: JSON.stringify({ description: '40k Codex rosters', public: false, files: { [this.FILE]: { content: JSON.stringify(this.payload(), null, 1) } } }) });
        store.set('gistId', g.id);
      }
      await this.now();
    },
    disconnect() { store.set('ghToken', ''); store.set('gistId', ''); this.error = ''; },
    async pull() {
      const g = await this.req('/gists/' + this.gistId());
      const f = g.files && g.files[this.FILE];
      if (!f) return null;
      let text = f.content;
      if (f.truncated && f.raw_url) text = await (await fetch(f.raw_url)).text();
      return JSON.parse(text || '{}');
    },
    /* items are merged by their "updated" time; tombstones remove items not changed after the deletion */
    mergeList(local, remoteList, localDel, remoteDel) {
      const del = Object.assign({}, remoteDel || {});
      for (const [id, ts] of Object.entries(localDel || {})) del[id] = Math.max(del[id] || 0, ts);
      const map = new Map(arr(local).map(r => [r.id, r]));
      for (const rr of arr(remoteList)) {
        if (del[rr.id] && del[rr.id] >= (rr.updated || 0)) continue;
        const lr = map.get(rr.id);
        if (!lr || (rr.updated || 0) > (lr.updated || 0)) map.set(rr.id, rr);
      }
      for (const [id, ts] of Object.entries(del)) { const r = map.get(id); if (r && (r.updated || 0) <= ts) map.delete(id); }
      return { list: [...map.values()], del };
    },
    merge(remote) {
      const r = this.mergeList(rosters, remote.rosters, this.deleted(), remote.deleted);
      rosters = r.list;
      store.set(KEY, rosters);
      store.set('rosterDeleted', r.del);
      const g = this.mergeList(this.games(), remote.games, this.gamesDeleted(), remote.gamesDeleted);
      store.set('games', g.list);
      store.set('gameDeleted', g.del);
    },
    /* pull, merge, push when something differs */
    async now() {
      if (!this.on()) return;
      /* a change made while a sync is running is pushed by a second run */
      if (this.busy) { this.again = true; return; }
      this.busy = true; this.error = ''; this.paint();
      try {
        const remote = await this.pull() || {};
        const before = JSON.stringify(rosters);
        const beforeGames = JSON.stringify(this.games());
        this.merge(remote);
        const changedLocal = JSON.stringify(rosters) !== before;
        const changedGames = JSON.stringify(this.games()) !== beforeGames;
        const same = JSON.stringify(arr(remote.rosters)) === JSON.stringify(rosters) && JSON.stringify(remote.deleted || {}) === JSON.stringify(this.deleted()) &&
          JSON.stringify(arr(remote.games)) === JSON.stringify(this.games()) && JSON.stringify(remote.gamesDeleted || {}) === JSON.stringify(this.gamesDeleted());
        if (!same) await this.req('/gists/' + this.gistId(), { method: 'PATCH', body: JSON.stringify({ files: { [this.FILE]: { content: JSON.stringify(this.payload(), null, 1) } } }) });
        this.last = Date.now(); store.set('syncLast', this.last); this.lastPull = Date.now();
        if (changedLocal) { const id = cur && cur.id; cur = id ? rosters.find(r => r.id === id) || null : null; if (document.body.dataset.mode === 'builder') render(); }
        if ((changedGames || changedLocal) && window.Play && document.body.dataset.mode === 'play') Play.refresh();
      } catch (e) {
        console.warn(e); this.error = e.message;
      } finally {
        this.busy = false; this.paint();
        if (this.again) { this.again = false; this.schedule(); }
      }
    },
    schedule() { if (!this.on()) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.now(), 2000); },
    label() {
      if (!this.on()) return '☁';
      if (this.busy) return '☁ …';
      if (this.error) return '☁ ✕';
      return '☁ ✓';
    },
    paint() {
      for (const b of document.querySelectorAll('[data-b="sync"], [data-pa="sync"]')) { b.textContent = this.label(); b.title = this.error || (this.last ? new Date(this.last).toLocaleString() : 'Sync'); b.classList.toggle('err', !!this.error); }
      if (modalKind === 'sync') $('#modalBody').innerHTML = renderSyncModal();
    },
  };

  /* =====================================================================
     Rules from the game system data
     ===================================================================== */
  function battleSizes() {
    if (Data._sizes) return Data._sizes;
    const link = arr(Data.gs.raw.entryLinks).find(l => l.name === 'Battle Size');
    const n = link && deref(link, Data.gs.scope);
    const g = n && arr(n.selectionEntryGroups).find(x => x.name === 'Battle Size');
    Data._sizes = { title: n ? n.name : 'Battle Size', list: g ? arr(g.selectionEntries).map(e => ({ id: e.id, name: e.name })) : [] };
    return Data._sizes;
  }
  const armyForce = () => arr(Data.gs.raw.forceEntries).find(f => f.name === 'Army Roster') || arr(Data.gs.raw.forceEntries)[0] || {};
  const costType = (name) => arr(Data.gs.raw.costTypes).find(c => c.name === name) || { name, id: null };

  /* Army Roster "max" constraints on cost types, with the modifiers that depend on the chosen battle size */
  function limits(sizeId) {
    const f = armyForce();
    const out = {};
    const evalC = (c) => { const r = cmp(c.type, c.childId === sizeId ? 1 : 0, Number(c.value)); return r == null ? false : r; };
    const evalG = (g) => {
      const parts = arr(g.conditions).map(evalC).concat(arr(g.conditionGroups).map(evalG));
      if (!parts.length) return true;
      return g.type === 'or' ? parts.some(Boolean) : parts.every(Boolean);
    };
    for (const c of arr(f.constraints)) {
      if (c.type !== 'max') continue;
      let v = Number(c.value);
      for (const m of arr(f.modifiers)) {
        if (m.field !== c.id || arr(m.repeats).length) continue;
        if (!evalG({ type: 'and', conditions: arr(m.conditions), conditionGroups: arr(m.conditionGroups) })) continue;
        if (m.type === 'set') v = Number(m.value);
        else if (m.type === 'increment') v += Number(m.value);
        else if (m.type === 'decrement') v -= Number(m.value);
      }
      const t = arr(Data.gs.raw.costTypes).find(t => t.id === c.field);
      if (t) out[t.name] = v;
    }
    return out;
  }
  /* Categories the Army Roster force requires at least once (e.g. Character) */
  /* Modifiers judged only by primary-catalogue conditions (e.g. Titan factions need no Character) */
  function facModValue(c, mods, fac) {
    let v = Number(c.value);
    const ev = (g) => {
      const parts = arr(g.conditions).map(x => x.scope === 'primary-catalogue' ? (x.type === 'notInstanceOf' ? fac.id !== x.childId : fac.id === x.childId) : null)
        .concat(arr(g.conditionGroups).map(ev)).filter(p => p !== null);
      if (!parts.length) return false;
      return g.type === 'or' ? parts.some(Boolean) : parts.every(Boolean);
    };
    for (const m of arr(mods)) {
      if (m.field !== c.id) continue;
      if (!ev({ type: 'and', conditions: arr(m.conditions), conditionGroups: arr(m.conditionGroups) })) continue;
      if (m.type === 'set') v = Number(m.value); else if (m.type === 'increment') v += Number(m.value); else if (m.type === 'decrement') v -= Number(m.value);
    }
    return v;
  }
  function requiredCategories(fac) {
    const out = [];
    for (const l of arr(armyForce().categoryLinks)) {
      const mins = arr(l.constraints).filter(c => c.type === 'min' && c.field === 'selections').map(c => facModValue(c, l.modifiers, fac));
      const min = mins.length ? Math.max(...mins) : 0;
      if (min > 0) out.push({ id: l.targetId, name: l.name, min });
    }
    return out;
  }
  /* Category maximums defined in the catalogues (e.g. one of each named character) */
  function categoryMax(fac) {
    if (fac._catMax) return fac._catMax;
    const out = new Map();
    for (const c of fac.scope) for (const ce of arr(c.raw.categoryEntries)) {
      /* -1 = no limit; limits changed by modifiers are left out (they depend on other selections) */
      if (arr(ce.modifiers).length || arr(ce.modifierGroups).length) continue;
      const m = arr(ce.constraints).filter(x => x.type === 'max' && x.field === 'selections' && (x.scope === 'force' || x.scope === 'roster') && Number(x.value) >= 0);
      if (m.length && !out.has(ce.id)) out.set(ce.id, { name: ce.name, max: Math.min(...m.map(x => Number(x.value))) });
    }
    fac._catMax = out;
    return out;
  }
  /* Unit maximum from its own constraints (base values) */
  function unitMax(u) {
    const cs = arr(u.node.constraints).filter(c => c.type === 'max' && c.field === 'selections' && (c.scope === 'force' || c.scope === 'roster') && Number(c.value) >= 0);
    return cs.length ? Math.min(...cs.map(c => Number(c.value))) : null;
  }

  /* =====================================================================
     Roster helpers
     ===================================================================== */
  const facOf = (r) => Data.cats[r.fac];
  const pool = (r) => factionUnits(facOf(r)).units;
  const unitOf = (r, ru) => pool(r).find(u => u.id === ru.id) || null;
  function sizeOptions(u) {
    const opts = [];
    for (const t of buildSheet(u).points.tiers) if (!opts.some(o => o.n === t.to)) opts.push({ n: t.to, pts: t.pts });
    return opts;
  }
  function unitPts(u, n) {
    const tiers = buildSheet(u).points.tiers;
    const t = tiers.find(t => n >= t.from && n <= t.to) || tiers[tiers.length - 1];
    return t ? t.pts : 0;
  }
  const detList = (r) => factionDetachments(facOf(r));
  function enhList(r) {
    const fac = facOf(r);
    const map = factionEnhancements(fac, detList(r));
    const out = [];
    for (const d of r.dets) for (const e of (map.get(d) || [])) if (!out.some(x => x.e.id === e.id)) out.push({ e, det: d });
    return out;
  }
  const enhById = (r, id) => enhList(r).find(x => x.e.id === id) || null;
  const isChar = (u) => u.cats.includes('Character');
  const isEpic = (u) => u.cats.includes('Epic Hero');
  function rosterPts(r) {
    let sum = 0;
    for (const ru of r.units) {
      const u = unitOf(r, ru);
      if (!u) continue;
      sum += unitPts(u, ru.n);
      const en = ru.enh && enhById(r, ru.enh);
      if (en) sum += costOf(en.e, Data.ptsId);
    }
    return sum;
  }
  function rosterDp(r) {
    const dp = costType('Detachment Points');
    const dets = detList(r);
    return r.dets.reduce((a, id) => { const d = dets.find(x => x.e.id === id); return a + (d ? costOf(d.e, dp.id) : 0); }, 0);
  }
  /* Units this unit can be attached to (Leader / Supported by associations) */
  function assocIds(u) {
    const ids = new Set();
    for (const a of arr(u && u.node.associations)) for (const t of assocTargets(a)) ids.add(t.id);
    return ids;
  }
  const canAttach = (u, target) => { const ids = assocIds(u); return !!target && [...target.catIds].some(id => ids.has(id)); };
  function attachTargets(r, ru) {
    const u = unitOf(r, ru);
    if (!u || !arr(u.node.associations).length) return [];
    return r.units.filter(x => x.uid !== ru.uid && !x.lead).map(x => ({ ru: x, u: unitOf(r, x) })).filter(x => canAttach(u, x.u));
  }
  /* "Necron Warriors #2" when the same unit is in the roster more than once */
  function dispName(r, ru) {
    const u = unitOf(r, ru);
    const name = u ? u.name : ru.id;
    const same = r.units.filter(x => x.id === ru.id);
    return same.length > 1 ? `${name} #${same.indexOf(ru) + 1}` : name;
  }
  function assocLabel(u) { const a = arr(u.node.associations)[0]; return a ? (a.label || a.name) : ''; }

  /* =====================================================================
     Validation
     ===================================================================== */
  function validate(r) {
    const errs = [], warns = [];
    const fac = facOf(r);
    const lim = limits(r.size);
    const ptsName = costTypeName(Data.ptsId);
    const pts = rosterPts(r);
    const ptsLimit = Number(r.ptsLimit) || lim[ptsName] || 0;
    const dpT = costType('Detachment Points'), enT = costType('Enhancements');
    const dp = rosterDp(r);
    const dpLimit = lim[dpT.name];
    const enhCount = r.units.filter(x => x.enh).length;
    const enhLimit = lim[enT.name];

    if (ptsLimit && pts > ptsLimit) errs.push(`${ptsName}: ${pts} / ${ptsLimit}`);
    if (!r.dets.length && detList(r).length) errs.push(`${detTitle(r)}: 0`);
    if (dpLimit != null && dp > dpLimit) errs.push(`${dpT.name}: ${dp} / ${dpLimit}`);
    if (enhLimit != null && enhCount > enhLimit) errs.push(`${enT.name}: ${enhCount} / ${enhLimit}`);

    const units = r.units.map(ru => ({ ru, u: unitOf(r, ru) })).filter(x => x.u);
    for (const rc of requiredCategories(fac)) {
      const n = units.filter(x => x.u.catIds.has(rc.id)).length;
      if (n < rc.min) errs.push(`${rc.name}: ${n} / min ${rc.min}`);
    }
    const counts = new Map();
    for (const { u } of units) counts.set(u.id, (counts.get(u.id) || 0) + 1);
    for (const [id, n] of counts) {
      const u = units.find(x => x.u.id === id).u;
      const max = unitMax(u);
      if (max != null && n > max) errs.push(`${u.name}: ${n} / max ${max}`);
    }
    for (const [cid, cm] of categoryMax(fac)) {
      const n = units.filter(x => x.u.catIds.has(cid)).length;
      if (n > cm.max) errs.push(`${cm.name}: ${n} / max ${cm.max}`);
    }
    const seenEnh = new Map();
    for (const { ru, u } of units) {
      if (!ru.enh) continue;
      const en = enhById(r, ru.enh);
      if (!en) { errs.push(`${u.name}: ${enT.name} ?`); continue; }
      seenEnh.set(en.e.id, (seenEnh.get(en.e.id) || 0) + 1);
      if (!isChar(u) || isEpic(u)) errs.push(`${u.name}: ${en.e.name}`);
    }
    for (const [id, n] of seenEnh) if (n > 1) errs.push(`${enhById(r, id).e.name}: ${n} / max 1`);
    const leadCount = new Map();
    for (const { ru, u } of units) {
      if (!ru.lead) continue;
      const tgt = units.find(x => x.ru.uid === ru.lead);
      if (!tgt) continue;
      if (!canAttach(u, tgt.u) || tgt.ru.lead) errs.push(`${u.name} → ${tgt.u.name}`);
      const k = ru.lead + '|' + assocLabel(u);
      leadCount.set(k, (leadCount.get(k) || 0) + 1);
      if (leadCount.get(k) === 2) errs.push(`${tgt.u.name}: ${assocLabel(u)} 2 / max 1`);
    }
    /* a unit and the units attached to it share one Enhancement */
    const groupEnh = new Map();
    for (const { ru } of units) {
      if (!ru.enh) continue;
      const k = ru.lead && units.some(x => x.ru.uid === ru.lead) ? ru.lead : ru.uid;
      groupEnh.set(k, (groupEnh.get(k) || 0) + 1);
    }
    for (const [uid, n] of groupEnh) if (n > 1) errs.push(`${dispName(r, units.find(x => x.ru.uid === uid).ru)}: ${enT.name} ${n} / max 1`);
    for (const { u } of units) if (u.legends) { warns.push(`${u.name}: Legends`); }
    for (const { u } of units) if (buildSheet(u).points.notes.length) warns.push(`${u.name}: ${buildSheet(u).points.notes[0]}`);
    return { errs, warns, pts, ptsLimit, dp, dpLimit, enhCount, enhLimit, ptsName, dpName: dpT.name, enhName: enT.name };
  }
  function detTitle(r) { const fu = factionUnits(facOf(r)); return fu.detachments.length ? fu.detachments[0].node.name : 'Detachment'; }


  /* =====================================================================
     Rendering
     Edit mode: rosters | unit picker | roster editor.  View mode: roster | datasheet of the selected unit.
     ===================================================================== */
  const ptsName = () => costTypeName(Data.ptsId);
  const sizeName = (r) => { const s = battleSizes().list.find(x => x.id === r.size); return s ? s.name : ''; };
  const detNames = (r) => r.dets.map(id => { const d = detList(r).find(x => x.e.id === id); return d ? d.e.name : null; }).filter(Boolean);

  /* scroll positions survive a re-render of the same screen (adding a unit, changing an option, ...) */
  const SCROLLERS = ['.b-rosters', '.b-picker .list', '.b-roster', '.b-viewlist'];
  let lastScreen = '';
  function render() {
    const root = el();
    const mode = ui.creating || !cur ? 'new' : ui.mode;
    const screen = mode + '|' + (cur ? cur.id : '');
    const keep = screen === lastScreen ? SCROLLERS.map(s => { const n = $(s, root); return n ? n.scrollTop : 0; }).concat(root.scrollTop) : null;
    lastScreen = screen;
    renderScreen(root, mode);
    if (keep) {
      SCROLLERS.forEach((s, i) => { const n = $(s, root); if (n) n.scrollTop = keep[i]; });
      root.scrollTop = keep[SCROLLERS.length];
    }
  }
  function renderScreen(root, mode) {
    root.className = 'builder b-' + mode;
    if (mode === 'new') {
      root.innerHTML = `<aside class="b-rosters">${renderRosterList()}</aside><main class="b-roster">${renderNewForm()}</main>`;
    } else if (mode === 'edit') {
      root.innerHTML = `<aside class="b-rosters">${renderRosterList()}</aside>
        <section class="b-picker">${renderPicker()}</section>
        <main class="b-roster">${renderEditor()}</main>`;
      const q = $('#bq', root);
      if (q) q.value = ui.q;
    } else {
      root.innerHTML = `<aside class="b-viewlist">${renderViewList()}</aside><main class="b-roster b-viewsheet">${renderViewSheet()}</main>`;
    }
  }

  function renderRosterList() {
    let h = `<div class="b-head"><h2>Army Rosters</h2><span class="b-headbtns"><button class="btn sync-btn${Sync.error ? ' err' : ''}" data-b="sync" title="Sync">${Sync.label()}</button><button class="btn primary" data-b="new">＋ New</button></span></div>`;
    if (!rosters.length) return h + `<div class="list-empty">—</div>`;
    for (const r of [...rosters].sort((a, b) => (b.updated || 0) - (a.updated || 0))) {
      const fac = facOf(r);
      let pts = 0;
      try { pts = rosterPts(r); } catch (e) { /* ignore */ }
      h += `<div class="urow${cur && cur.id === r.id ? ' active' : ''}" data-b="open" data-id="${esc(r.id)}">
        <span class="uname">${esc(r.name)}</span><span class="pts">${pts}</span>
        <span class="usub">${esc(fac ? facLabel(fac) : '?')}</span></div>`;
    }
    return h;
  }

  const meter = (label, val, max) => {
    const pct = max ? Math.min(100, Math.round(val / max * 100)) : 0;
    const over = max != null && val > max;
    return `<div class="b-meter${over ? ' over' : ''}"><div class="b-meter-top"><span>${esc(label)}</span><span>${val}${max != null ? ' / ' + max : ''}</span></div><div class="b-track"><div class="b-fill" style="width:${pct}%"></div></div></div>`;
  };
  const meters = (v) => `<div class="b-meters">${meter(v.ptsName, v.pts, v.ptsLimit || null)}${meter(v.dpName, v.dp, v.dpLimit)}${meter(v.enhName, v.enhCount, v.enhLimit)}</div>`;
  const issues = (v) => v.errs.length || v.warns.length
    ? `<div class="b-issues">${v.errs.map(e => `<div class="b-err">✕ ${esc(e)}</div>`).join('')}${v.warns.map(e => `<div class="b-warn">! ${esc(e)}</div>`).join('')}</div>`
    : `<div class="b-ok">✓</div>`;

  /* ---------- Battle Size / points / Detachment form (new roster and settings) ---------- */
  function configFields(f, facId) {
    const sizes = battleSizes();
    const fac = Data.cats[facId];
    const lim = limits(f.size);
    const dpT = costType('Detachment Points');
    const dets = fac ? factionDetachments(fac) : [];
    const dp = f.dets.reduce((a, id) => { const d = dets.find(x => x.e.id === id); return a + (d ? costOf(d.e, dpT.id) : 0); }, 0);
    const dpMax = lim[dpT.name];
    const title = fac ? (factionUnits(fac).detachments[0] || { node: { name: 'Detachment' } }).node.name : 'Detachment';
    return `<div class="b-config">
        <label>${esc(sizes.title)}<select data-bf="size">${sizes.list.map(s => `<option value="${esc(s.id)}"${s.id === f.size ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label>Points limit<input data-bf="ptsLimit" type="number" min="0" step="250" value="${esc(f.ptsLimit || lim[ptsName()] || '')}"></label>
      </div>
      ${dets.length ? `<div class="b-detpick"><div class="b-detpick-head"><span>${esc(title)}</span><span class="pts${dpMax != null && dp > dpMax ? ' over' : ''}">${dp}${dpMax != null ? ' / ' + dpMax : ''} DP</span></div>
        <div class="b-dets">${dets.map(({ e }) => {
          const on = f.dets.includes(e.id);
          return `<label class="b-det${on ? ' on' : ''}"><input type="checkbox" data-bf="det" value="${esc(e.id)}"${on ? ' checked' : ''}><span>${esc(e.name)}</span><span class="pts">${costOf(e, dpT.id)} DP</span></label>`;
        }).join('')}</div></div>` : ''}`;
  }

  function renderNewForm() {
    const f = ui.form;
    let groups = '', grp = null;
    for (const x of Data.factions) {
      if (x.group !== grp) { if (grp) groups += '</optgroup>'; grp = x.group; groups += `<optgroup label="${esc(grp)}">`; }
      groups += `<option value="${esc(x.cat.id)}"${f.fac === x.cat.id ? ' selected' : ''}>${esc(x.label)}${x.sub ? ' (' + esc(x.sub) + ')' : ''}</option>`;
    }
    groups += '</optgroup>';
    return `<article class="sheet"><div class="sheet-head"><div class="grow"><h2>New Roster</h2></div></div>
      <div class="b-form" id="bNewForm">
        <label>Name<input data-bf="name" type="text" value="${esc(f.name)}"></label>
        <label>Faction<select data-bf="fac">${groups}</select></label>
      </div>
      ${configFields(f, f.fac)}
      <div class="b-actions"><button class="btn primary" data-b="create">Create</button>${cur ? '<button class="btn" data-b="cancel">Cancel</button>' : ''}</div>
    </article>`;
  }

  function renderSettings() {
    return `<h2 class="b-modal-title">${esc(battleSizes().title)} · ${esc(detTitle(cur))}</h2>${configFields(cur, cur.fac)}
      <div class="b-actions"><button class="btn primary" data-b="closemodal">OK</button></div>`;
  }

  /* ---------- Edit mode ---------- */
  function renderPicker() {
    const r = cur;
    const fac = facOf(r);
    const units = pool(r).filter(u => (ui.allies || !u.ally) && (!u.legends || State.legends));
    const q = ui.q.trim().toLowerCase();
    const cats = CAT_ORDER.filter(c => units.some(u => u.primary === c || u.cats.includes(c)));
    const list = units.filter(u => (!q || u.name.toLowerCase().includes(q)) && (!ui.cat || u.primary === ui.cat || u.cats.includes(ui.cat)));
    const counts = new Map();
    for (const ru of r.units) counts.set(ru.id, (counts.get(ru.id) || 0) + 1);
    const groups = new Map();
    for (const u of list) { const g = CAT_ORDER.includes(u.primary) ? u.primary : 'Other'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(u); }
    let h = `<div class="list-head"><h1>${esc(facLabel(fac))}</h1>
      <input id="bq" type="search" class="b-search" placeholder="Search…" autocomplete="off">
      <div class="chips"><button class="chip${!ui.cat ? ' on' : ''}" data-bcat="">All</button>${cats.map(c => `<button class="chip${ui.cat === c ? ' on' : ''}" data-bcat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="filters2"><label class="chk"><input type="checkbox" id="bAllies"${ui.allies ? ' checked' : ''}> Allies</label>
      <label class="chk"><input type="checkbox" id="bLegends"${State.legends ? ' checked' : ''}> Legends</label></div></div><div class="list">`;
    for (const g of CAT_ORDER.concat(['Other']).filter(g => groups.has(g))) {
      h += `<div class="lgroup">${esc(g)} · ${groups.get(g).length}</div>`;
      for (const u of groups.get(g).sort((a, b) => a.name.localeCompare(b.name))) {
        const opts = sizeOptions(u);
        const n = counts.get(u.id) || 0;
        h += `<div class="urow b-pick">
          <span class="uname"><button class="linkish" data-b="sheet" data-uid="${esc(u.id)}">${esc(u.name)}</button>${n ? ` <span class="tag">×${n}</span>` : ''}</span>
          <button class="btn b-add" data-b="add" data-uid="${esc(u.id)}" title="Add">＋</button>
          <span class="usub">${esc(u.primary)} · ${opts.map(o => `${o.n}: ${o.pts}`).join(' / ')}${u.ally ? ` <span class="tag src">${esc(shortSrc(u.src))}</span>` : ''}</span>
        </div>`;
      }
    }
    return h + `</div>`;
  }

  /* units grouped by primary category; attached units directly below their unit */
  function orderedUnits(r) {
    const groups = new Map();
    const hasTarget = (ru) => ru.lead && r.units.some(x => x.uid === ru.lead);
    for (const ru of r.units) {
      if (hasTarget(ru)) continue;
      const u = unitOf(r, ru);
      const g = u ? (CAT_ORDER.includes(u.primary) ? u.primary : 'Other') : 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(ru);
    }
    return CAT_ORDER.concat(['Other']).filter(g => groups.has(g)).map(g => ({
      group: g,
      items: groups.get(g).flatMap(ru => [{ ru, attached: false }].concat(r.units.filter(x => x.lead === ru.uid).map(x => ({ ru: x, attached: true })))),
    }));
  }

  function renderEditor() {
    const r = cur;
    const fac = facOf(r);
    const v = validate(r);
    const enhs = enhList(r);
    let h = `<article class="sheet b-sheet">
      <div class="sheet-head"><div class="grow">
        <input class="b-name" id="bName" value="${esc(r.name)}" aria-label="Name">
        <div class="sub"><span>${esc(fac.name)}</span><span>·</span><span>${esc(sizeName(r))}</span><span>·</span><span>${esc(detNames(r).join(', ') || '—')}</span>
          <button class="btn sm" data-b="settings">⚙ ${esc(battleSizes().title)} / ${esc(detTitle(r))}</button></div>
      </div>
      <div class="sheet-actions">
        <button class="btn primary" data-b="save">✓ Save</button>
        <button class="btn" data-b="dup">Copy</button>
        <button class="btn danger" data-b="delete">Delete</button>
      </div></div>
      ${meters(v)}${issues(v)}
      <section class="sec"><h3>Units · ${r.units.length}</h3>`;
    if (!r.units.length) h += `<div class="list-empty">＋</div>`;
    for (const g of orderedUnits(r)) {
      h += `<div class="lgroup b-lgroup">${esc(g.group)}</div>`;
      for (const { ru } of g.items) h += renderUnitRow(r, ru, unitOf(r, ru), enhs);
    }
    return h + `</section></article>`;
  }

  function renderUnitRow(r, ru, u, enhs) {
    if (!u) return `<div class="b-unit missing"><span>${esc(ru.id)}</span><button class="btn" data-b="remove" data-ruid="${esc(ru.uid)}">✕</button></div>`;
    const opts = sizeOptions(u);
    const pts = unitPts(u, ru.n);
    const en = ru.enh && enhById(r, ru.enh);
    const enPts = en ? costOf(en.e, Data.ptsId) : 0;
    const used = new Set(r.units.filter(x => x.enh && x.uid !== ru.uid).map(x => x.enh));
    const canEnh = isChar(u) && !isEpic(u) && enhs.length;
    const targets = attachTargets(r, ru);
    const leader = ru.lead ? r.units.find(x => x.uid === ru.lead) : null;

    let h = `<div class="b-unit${ru.lead ? ' attached' : ''}">
      <div class="b-unit-top">
        <button class="linkish b-uname" data-b="sheet" data-uid="${esc(u.id)}">${esc(dispName(r, ru))}</button>
        <span class="pts">${pts + enPts} ${esc(ptsName())}</span>
        <button class="icon-btn sm" data-b="clone" data-ruid="${esc(ru.uid)}" title="Copy">⧉</button>
        <button class="icon-btn sm" data-b="remove" data-ruid="${esc(ru.uid)}" title="Remove">✕</button>
      </div>
      <div class="b-unit-opts">`;
    if (opts.length > 1) h += `<select data-bsize="${esc(ru.uid)}">${opts.map(o => `<option value="${o.n}"${o.n === ru.n ? ' selected' : ''}>${modelsLabel(o.n, o.n)} · ${o.pts}</option>`).join('')}</select>`;
    else h += `<span class="b-static">${modelsLabel(ru.n, ru.n)}</span>`;
    if (canEnh) {
      /* grouped by detachment, so every chosen detachment's Enhancements are listed */
      const byDet = new Map();
      for (const x of enhs) { if (!byDet.has(x.det)) byDet.set(x.det, []); byDet.get(x.det).push(x); }
      const dets = detList(r);
      h += `<select data-benh="${esc(ru.uid)}"><option value="">${esc(costType('Enhancements').name)}: —</option>${[...byDet].map(([did, list]) => {
        const d = dets.find(x => x.e.id === did);
        return `<optgroup label="${esc(d ? d.e.name : '')}">${list.map(x => `<option value="${esc(x.e.id)}"${ru.enh === x.e.id ? ' selected' : ''}${used.has(x.e.id) ? ' disabled' : ''}>${esc(x.e.name)} · +${costOf(x.e, Data.ptsId)}</option>`).join('')}</optgroup>`;
      }).join('')}</select>`;
    }
    if (targets.length || ru.lead) {
      h += `<select data-blead="${esc(ru.uid)}"><option value="">${esc(assocLabel(u))}: —</option>${targets.map(t => `<option value="${esc(t.ru.uid)}"${ru.lead === t.ru.uid ? ' selected' : ''}>${esc(dispName(r, t.ru))}</option>`).join('')}${leader && !targets.some(t => t.ru.uid === ru.lead) ? `<option value="${esc(ru.lead)}" selected>${esc(dispName(r, leader))}</option>` : ''}</select>`;
    }
    h += `</div>`;
    const att = r.units.filter(x => x.lead === ru.uid);
    if (att.length) h += `<div class="b-attached">${att.map(a => `<span class="tag">${esc(assocLabel(unitOf(r, a) || u))}: ${esc(dispName(r, a))}</span>`).join('')}</div>`;
    return h + `</div>`;
  }

  /* ---------- View mode ---------- */
  function renderViewList() {
    const r = cur;
    const fac = facOf(r);
    const v = validate(r);
    const sorted = [...rosters].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    let h = `<div class="b-head b-viewhead">
        <select id="bRosterSel" aria-label="Army Rosters">${sorted.map(x => `<option value="${esc(x.id)}"${x.id === r.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <button class="btn sync-btn${Sync.error ? ' err' : ''}" data-b="sync" title="Sync">${Sync.label()}</button>
        <button class="btn primary" data-b="new">＋ New</button>
      </div>
      <div class="b-viewinfo">
        <h2>${esc(r.name)}</h2>
        <div class="sub">${esc(facLabel(fac))} · ${esc(sizeName(r))}</div>
        <div class="b-quick">
          <button class="btn" data-b="dets">${esc(detTitle(r))}</button>
          <button class="btn" data-b="strats">Stratagems</button>
          <button class="btn" data-b="export">Export</button>
          <button class="btn primary" data-b="edit">✎ Edit</button>
        </div>
        <div class="b-detline">${detNames(r).map(n => `<span class="tag disp">${esc(n)}</span>`).join('') || '—'}</div>
        ${meters(v)}
        ${v.errs.length ? `<div class="b-issues">${v.errs.map(e => `<div class="b-err">✕ ${esc(e)}</div>`).join('')}</div>` : ''}
      </div>
      <div class="list">`;
    for (const g of orderedUnits(r)) {
      h += `<div class="lgroup">${esc(g.group)}</div>`;
      for (const { ru, attached } of g.items) {
        const u = unitOf(r, ru);
        if (!u) continue;
        const en = ru.enh && enhById(r, ru.enh);
        const p = unitPts(u, ru.n) + (en ? costOf(en.e, Data.ptsId) : 0);
        h += `<div class="urow b-vrow${attached ? ' attached' : ''}${ui.sel === ru.uid ? ' active' : ''}" data-b="select" data-ruid="${esc(ru.uid)}">
          <span class="uname">${attached ? '↳ ' : ''}${esc(dispName(r, ru))}</span><span class="pts">${p}</span>
          <span class="usub">${esc(modelsLabel(ru.n, ru.n))}${en ? ` · <span class="tag disp">${esc(en.e.name)}</span>` : ''}${attached ? ` · ${esc(assocLabel(u))}` : ''}</span>
        </div>`;
      }
    }
    if (!r.units.length) h += `<div class="list-empty">—</div>`;
    return h + `</div>`;
  }

  function renderViewSheet() {
    const r = cur;
    let ru = r.units.find(x => x.uid === ui.sel);
    if (!ru) { const first = orderedUnits(r)[0]; ru = first ? first.items[0].ru : null; ui.sel = ru ? ru.uid : null; }
    if (!ru) return `<div class="empty"><h2>${esc(r.name)}</h2><p><button class="btn primary" data-b="edit">✎ Edit</button></p></div>`;
    const u = unitOf(r, ru);
    if (!u) return '';
    let h = '';
    const en = ru.enh && enhById(r, ru.enh);
    if (en) {
      const items = abilityTexts(en.e, facOf(r));
      h += `<div class="b-enhcard"><div class="b-enhhead"><span class="stype">${esc(costType('Enhancements').name)}</span><b>${esc(en.e.name)}</b><span class="pts">+${costOf(en.e, Data.ptsId)} ${esc(ptsName())}</span></div>
        ${items.map(a => `<div class="ad">${fmt(a.desc)}</div>`).join('')}</div>`;
    }
    const att = r.units.filter(x => x.lead === ru.uid);
    const lead = ru.lead && r.units.find(x => x.uid === ru.lead);
    if (att.length || lead) {
      h += `<div class="b-attached b-attline">${lead ? `<button class="tag linkish" data-b="select" data-ruid="${esc(lead.uid)}">${esc(assocLabel(u))} → ${esc(dispName(r, lead))}</button>` : ''}
        ${att.map(a => `<button class="tag linkish" data-b="select" data-ruid="${esc(a.uid)}">${esc(assocLabel(unitOf(r, a) || u))}: ${esc(dispName(r, a))}</button>`).join('')}</div>`;
    }
    return h + renderSheet(u, true);
  }

  /* ---------- Detachment / Stratagems quick views ---------- */
  function renderDetModal() {
    const r = cur;
    const fac = facOf(r);
    const dets = detList(r).filter(d => r.dets.includes(d.e.id));
    const dpT = costType('Detachment Points');
    stratIndex.length = 0;
    if (!dets.length) return `<h2 class="b-modal-title">${esc(detTitle(r))}</h2><p class="note">—</p>`;
    return dets.map(({ e }) => `<div class="b-modal-det"><div class="b-modal-dethead"><h2 class="b-modal-title">${esc(e.name)}</h2><span class="pts">${costOf(e, dpT.id)} ${esc(dpT.name)}</span></div>
      ${detachmentBody(fac, e, null, { strats: false })}</div>`).join('') +
      `<div class="b-actions"><button class="btn" data-b="strats">Stratagems</button></div>`;
  }
  function renderStratModal() {
    const r = cur;
    const fac = facOf(r);
    const dets = detList(r).filter(d => r.dets.includes(d.e.id));
    stratIndex.length = 0;
    let h = `<h2 class="b-modal-title">Stratagems</h2>${stratFilterBar()}`;
    for (const { e } of dets) {
      const list = stratForDetachment(fac, e.name);
      if (list.length) h += `<div class="stratsec"><h5 class="b-sh">${esc(e.name)}</h5>${list.map(stratFold).join('')}</div>`;
    }
    const core = coreStratagems();
    if (core.length) h += `<div class="stratsec"><h5 class="b-sh">Core Stratagems</h5>${core.map(stratFold).join('')}</div>`;
    return h;
  }

  /* ---------- Sync settings ---------- */
  function renderSyncModal() {
    const on = Sync.on();
    let h = `<h2 class="b-modal-title">Sync · GitHub Gist</h2>`;
    if (on) {
      h += `<dl class="kv b-synckv">
          <dt>Gist</dt><dd><a href="https://gist.github.com/${esc(Sync.gistId())}" target="_blank" rel="noopener">${esc(Sync.gistId())}</a></dd>
          <dt>Last sync</dt><dd>${Sync.last ? esc(new Date(Sync.last).toLocaleString()) : '—'}</dd>
          ${Sync.error ? `<dt>Error</dt><dd class="b-err">${esc(Sync.error)}</dd>` : ''}
        </dl>
        <div class="b-actions"><button class="btn primary" data-b="syncnow"${Sync.busy ? ' disabled' : ''}>${Sync.busy ? '…' : 'Sync now'}</button><button class="btn danger" data-b="syncoff">Disconnect</button></div>`;
    } else {
      h += `<p class="note">GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens →
          Generate new token → Account permissions: <b>Gists: Read and write</b>.
          The same token on every device. It is stored in this browser only.</p>
        <div class="b-form"><label>Token<input id="bToken" type="password" autocomplete="off" spellcheck="false"></label></div>
        <div class="b-actions"><button class="btn primary" data-b="syncconnect"${Sync.busy ? ' disabled' : ''}>${Sync.busy ? '…' : 'Connect'}</button></div>
        ${Sync.error ? `<div class="b-err">${esc(Sync.error)}</div>` : ''}`;
    }
    return h;
  }

  /* ---------- Export ---------- */
  function exportText(r) {
    const fac = facOf(r);
    const v = validate(r);
    const sizes = battleSizes();
    const dets = detList(r);
    const dpT = costType('Detachment Points');
    const lines = [];
    lines.push(`${r.name}`);
    lines.push(`${fac.name} · ${v.pts}${v.ptsLimit ? ' / ' + v.ptsLimit : ''} ${v.ptsName}`);
    if (sizeName(r)) lines.push(`${sizes.title}: ${sizeName(r)}`);
    lines.push(`${detTitle(r)}: ${r.dets.map(id => { const d = dets.find(x => x.e.id === id); return d ? `${d.e.name} (${costOf(d.e, dpT.id)} DP)` : id; }).join(', ') || '—'}`);
    const line = (ru, u, indent) => {
      const en = ru.enh && enhById(r, ru.enh);
      const enPts = en ? costOf(en.e, Data.ptsId) : 0;
      let s = `${indent}${u.name}${ru.n > 1 ? ` (${ru.n})` : ''} — ${unitPts(u, ru.n) + enPts} ${v.ptsName}`;
      if (en) s += ` — ${en.e.name} (+${enPts})`;
      return s;
    };
    for (const g of orderedUnits(r)) {
      lines.push('', g.group.toUpperCase());
      for (const { ru, attached } of g.items) {
        const u = unitOf(r, ru);
        if (u) lines.push(line(ru, u, attached ? `    + ${assocLabel(u)}: ` : '  '));
      }
    }
    if (v.errs.length) lines.push('', ...v.errs.map(e => '✕ ' + e));
    return lines.join('\n');
  }

  /* ---------- Modal ---------- */
  let modalKind = null;
  function openModal(html, kind) { modalKind = kind || null; $('#modalBody').innerHTML = html; $('#modal').hidden = false; $('#modal .modal-box').scrollTop = 0; applyPhaseFilter($('#modal')); }
  function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; modalKind = null; }
  function refreshModal() { if (modalKind === 'settings') { $('#modalBody').innerHTML = renderSettings(); } }

  /* =====================================================================
     Actions
     ===================================================================== */
  function go(id) { location.hash = id ? '#/b/r/' + encodeURIComponent(id) : '#/b'; }
  function defaultForm() {
    const sizes = battleSizes().list;
    return { name: 'My Army', fac: (State.fac || Data.factions[0].cat).id, size: (sizes[1] || sizes[0] || {}).id, ptsLimit: null, dets: [] };
  }

  function addUnit(uid) {
    const u = pool(cur).find(x => x.id === uid);
    if (!u) return;
    const opts = sizeOptions(u);
    cur.units.push({ uid: newId(), id: u.id, n: opts.length ? opts[0].n : 1, enh: null, lead: null });
    save(); render();
  }
  /* unit sizes that no longer exist after a data update move to the nearest valid size */
  function fixSizes(r) {
    for (const ru of r.units) {
      const u = unitOf(r, ru);
      const opts = u ? sizeOptions(u) : [];
      if (opts.length && !opts.some(o => o.n === ru.n)) ru.n = (opts.find(o => o.n >= ru.n) || opts[opts.length - 1]).n;
    }
  }
  function cleanEnhancements(r) {
    const valid = new Set(enhList(r).map(x => x.e.id));
    for (const x of r.units) if (x.enh && !valid.has(x.enh)) x.enh = null;
  }

  function onClick(e) {
    const inModal = $('#modal').contains(e.target);
    const t = e.target.closest('[data-b], [data-bcat]');
    if (!t || !(el().contains(t) || inModal)) return;
    const a = t.dataset.b;
    if (t.dataset.bcat != null) { ui.cat = t.dataset.bcat || null; render(); return; }
    if (a === 'new') { ui.creating = true; ui.form = defaultForm(); render(); return; }
    if (a === 'cancel') { ui.creating = false; render(); return; }
    if (a === 'open') { ui.creating = false; go(t.dataset.id); return; }
    if (a === 'closemodal') { closeModal(); return; }
    if (a === 'sync') { openModal(renderSyncModal(), 'sync'); return; }
    if (a === 'syncnow') { Sync.now(); return; }
    if (a === 'syncoff') { Sync.disconnect(); Sync.paint(); render(); return; }
    if (a === 'syncconnect') {
      const tok = ($('#bToken') || {}).value || '';
      if (!tok.trim()) return;
      Sync.busy = true; Sync.error = ''; Sync.paint(); Sync.busy = false;
      Sync.connect(tok).catch(err => { Sync.error = err.message; store.set('gistId', ''); Sync.paint(); }).then(() => { render(); Sync.paint(); });
      return;
    }
    if (a === 'create') {
      const f = ui.form;
      const r = { id: newId(), name: (f.name || '').trim() || 'Army', fac: f.fac, size: f.size, ptsLimit: f.ptsLimit || null, dets: f.dets.slice(), units: [], created: Date.now(), updated: Date.now() };
      rosters.push(r); ui.creating = false; ui.q = ''; ui.cat = null; ui.mode = 'edit';
      persist(); go(r.id); return;
    }
    if (!cur) return;
    if (a === 'add') return addUnit(t.dataset.uid);
    if (a === 'sheet') { const u = pool(cur).find(x => x.id === t.dataset.uid); if (u) openModal(renderSheet(u, true)); return; }
    if (a === 'select') {
      ui.sel = t.dataset.ruid; if (inModal) closeModal(); render();
      const sheet = el().querySelector('.b-viewsheet');
      if (sheet) {
        sheet.scrollTop = 0;
        /* one-column layout: the datasheet is below the roster */
        if (getComputedStyle(el()).display === 'block') sheet.scrollIntoView({ block: 'start' });
      }
      return;
    }
    if (a === 'save') { ui.mode = 'view'; save(); render(); return; }
    if (a === 'edit') { ui.mode = 'edit'; render(); return; }
    if (a === 'settings') { openModal(renderSettings(), 'settings'); return; }
    if (a === 'dets') { openModal(renderDetModal(), 'dets'); return; }
    if (a === 'strats') { openModal(renderStratModal(), 'strats'); return; }
    if (a === 'remove') {
      const id = t.dataset.ruid;
      cur.units = cur.units.filter(x => x.uid !== id);
      for (const x of cur.units) if (x.lead === id) x.lead = null;
      save(); render(); return;
    }
    if (a === 'clone') {
      const src = cur.units.find(x => x.uid === t.dataset.ruid);
      if (src) { cur.units.splice(cur.units.indexOf(src) + 1, 0, { uid: newId(), id: src.id, n: src.n, enh: null, lead: null }); save(); render(); }
      return;
    }
    if (a === 'dup') {
      const r = JSON.parse(JSON.stringify(cur));
      r.id = newId(); r.name = cur.name + ' (2)'; r.created = r.updated = Date.now();
      rosters.push(r); persist(); go(r.id); return;
    }
    if (a === 'delete') {
      if (!confirm(`Delete "${cur.name}"?`)) return;
      const del = Sync.deleted(); del[cur.id] = Date.now(); store.set('rosterDeleted', del);
      rosters = rosters.filter(x => x.id !== cur.id); persist(); cur = null; go(null); return;
    }
    if (a === 'export') {
      openModal(`<h2 class="b-modal-title">Export</h2><textarea class="b-export" id="bExport" readonly>${esc(exportText(cur))}</textarea><div class="b-actions"><button class="btn primary" data-b="copy">Copy</button><span class="note" id="bCopied"></span></div>`, 'export');
      return;
    }
    if (a === 'copy') {
      const ta = $('#bExport');
      const done = () => { $('#bCopied').textContent = '✓'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, () => { ta.select(); document.execCommand('copy'); done(); });
      else { ta.select(); document.execCommand('copy'); done(); }
    }
  }

  /* form fields of the new roster form and the settings modal */
  function onFormField(t) {
    const target = ui.creating ? ui.form : cur;
    const k = t.dataset.bf;
    if (k === 'name') { target.name = t.value; return false; }
    if (k === 'fac') { target.fac = t.value; target.dets = []; }
    if (k === 'size') { target.size = t.value; target.ptsLimit = null; }
    if (k === 'ptsLimit') target.ptsLimit = Number(t.value) || null;
    if (k === 'det') { if (t.checked) { if (!target.dets.includes(t.value)) target.dets.push(t.value); } else target.dets = target.dets.filter(x => x !== t.value); }
    if (!ui.creating) { cleanEnhancements(cur); save(); }
    return true;
  }

  function onChange(e) {
    const t = e.target;
    const inModal = $('#modal').contains(t);
    if (!el().contains(t) && !inModal) return;
    if (t.dataset.bf) { if (onFormField(t)) { render(); if (inModal) refreshModal(); } return; }
    if (t.id === 'bAllies') { ui.allies = t.checked; render(); return; }
    if (t.id === 'bLegends') { State.legends = t.checked; store.set('legends', State.legends); render(); return; }
    if (t.id === 'bRosterSel') { go(t.value); return; }
    if (!cur) return;
    if (t.id === 'bName') { cur.name = t.value.trim() || cur.name; save(); const l = $('.b-rosters', el()); if (l) l.innerHTML = renderRosterList(); return; }
    const find = (id) => cur.units.find(x => x.uid === id);
    if (t.dataset.bsize) { const ru = find(t.dataset.bsize); if (ru) { ru.n = Number(t.value); save(); render(); } return; }
    if (t.dataset.benh) { const ru = find(t.dataset.benh); if (ru) { ru.enh = t.value || null; save(); render(); } return; }
    if (t.dataset.blead) { const ru = find(t.dataset.blead); if (ru) { ru.lead = t.value || null; save(); render(); } return; }
  }

  let qTimer;
  function onInput(e) {
    if (e.target.dataset && e.target.dataset.bf === 'name') { onFormField(e.target); return; }
    if (e.target.id !== 'bq') return;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      ui.q = e.target.value;
      const pos = e.target.selectionStart;
      $('.b-picker', el()).innerHTML = renderPicker();
      const q = $('#bq', el());
      q.value = ui.q; q.focus(); q.setSelectionRange(pos, pos);
    }, 120);
  }

  let bound = false;
  function bindOnce() {
    if (bound) return;
    bound = true;
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    $('#modal').addEventListener('click', (e) => { if (e.target.closest('.modal-x') || e.target === $('#modal')) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && /^(builder|play)$/.test(document.body.dataset.mode)) Sync.now(); });
    $('#codexLink').addEventListener('click', (e) => { e.preventDefault(); location.hash = State.codexHash && !/^#\/b/.test(State.codexHash) ? State.codexHash : '#/'; });
  }

  function route() {
    bindOnce();
    rosters = store.get(KEY, []);
    const m = /^#\/b\/r\/([^/]+)/.exec(location.hash);
    const next = m ? rosters.find(r => r.id === decodeURIComponent(m[1])) || null : null;
    if (!cur || !next || cur.id !== next.id) { ui.sel = null; if (next && ui.mode !== 'edit') ui.mode = next.units.length ? 'view' : 'edit'; }
    cur = next;
    if (!cur && !m && rosters.length && !ui.creating) {
      const last = [...rosters].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
      history.replaceState(null, '', '#/b/r/' + encodeURIComponent(last.id));
      cur = last;
      ui.mode = cur.units.length ? 'view' : 'edit';
    }
    if (cur && !Data.cats[cur.fac]) cur = null;
    if (cur) fixSizes(cur);
    if (!cur && !rosters.length) { ui.creating = true; }
    if (ui.creating && !ui.form) ui.form = defaultForm();
    render();
    if (Sync.on() && Date.now() - Sync.lastPull > 20000) Sync.now();
  }

  /* the Sync settings modal, also opened from Play */
  function openSync() { bindOnce(); openModal(renderSyncModal(), 'sync'); }

  return { route, exportText, validate, sync: Sync, openSync };
})();
window.Builder = Builder;
