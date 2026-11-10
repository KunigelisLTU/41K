/* 40k Codex — unit loadouts for the Army Builder.
   Every roster unit can pick its models and wargear from the options in the data (selection entries,
   groups, min / max constraints, their modifiers and "error" modifiers such as "Max 1 per 5 models").
   A roster unit stores only its explicit choices: ru.w = { nodeKey: count }. Everything else is derived:
   mandatory wargear, group defaults, and the model type that fills the unit up to its size. */
'use strict';

const Loadout = (() => {
  const trees = new Map();
  const memo = new Map();

  /* weapon keys exactly as buildSheet() names them: "name|characteristics" */
  function weaponKeys(node, scope) {
    const out = [];
    const add = (p, mods) => {
      if (!p || p.hidden) return;
      if (p.typeName !== 'Ranged Weapons' && p.typeName !== 'Melee Weapons') return;
      out.push(applyNameMods(p.name, mods) + '|' + JSON.stringify(charMap(p)));
    };
    const visit = (n, d) => {
      if (d > 6) return;
      for (const p of arr(n.profiles)) add(p, null);
      for (const il of arr(n.infoLinks)) {
        if (il.hidden || SKIP_RE.test(il.name || '')) continue;
        const t = resolve(il.targetId, scope);
        if (!t) continue;
        if (il.type === 'profile') add(Object.assign({}, t.node, { name: il.name || t.node.name }), il.modifiers);
        else if (il.type === 'infoGroup') visit(t.node, d + 1);
      }
      for (const g of arr(n.infoGroups)) if (!g.hidden && !SKIP_RE.test(g.name || '')) visit(g, d + 1);
    };
    visit(node, 0);
    return out;
  }

  /* ---------- option tree of a unit ---------- */
  function tree(u) {
    const ck = u.fac.id + '|' + u.id;
    if (trees.has(ck)) return trees.get(ck);
    const scope = u.fac.scope;
    const T = { ck, root: null, byKey: new Map(), byId: new Map(), nodes: [], cfg: false };
    const add = (raw, linkId, kind, parent) => {
      const id = linkId || raw.id || raw._targetId;
      let key = id;
      for (let i = 0; T.byKey.has(key); i++) key = id + '~' + (parent ? parent.key : '') + (i || '');
      const n = {
        key, name: raw.name, kind, raw, parent, kids: [], ids: new Set(), free: false,
        weapons: kind === 'group' ? [] : weaponKeys(raw, scope),
        defId: raw.defaultSelectionEntryId || null, mods: flattenMods(raw),
        owner: null, mp: null,
      };
      for (const x of [raw.id, raw._targetId, linkId]) if (x) n.ids.add(x);
      if (kind !== 'group') for (const l of arr(raw.categoryLinks)) n.ids.add(l.targetId);
      /* owner: nearest entry above (groups are not selections); mp: nearest model above */
      for (let p = parent; p; p = p.parent) { if (!n.owner && p.kind !== 'group') n.owner = p; if (!n.mp && p.kind === 'model') n.mp = p; }
      T.byKey.set(key, n); T.nodes.push(n);
      for (const x of n.ids) { if (!T.byId.has(x)) T.byId.set(x, []); T.byId.get(x).push(n); }
      if (parent) parent.kids.push(n);
      return n;
    };
    const build = (n, depth, stack) => {
      const raw = n.raw;
      const tid = raw._targetId || raw.id;
      if (depth > 12 || stack.includes(tid)) return;
      const st = stack.concat(tid);
      const kid = (kraw, linkId, isGroup) => {
        if (!kraw || kraw.hidden || SKIP_RE.test(kraw.name || '') || /^warlord$/i.test(kraw.name || '')) return;
        const k = add(kraw, linkId, isGroup || kraw.type === 'unit' ? 'group' : kraw.type === 'model' ? 'model' : 'upgrade', n);
        if (!isGroup && kraw.type === 'unit') k.free = true;
        build(k, depth + 1, st);
      };
      for (const e of arr(raw.selectionEntries)) kid(e, null, false);
      for (const l of arr(raw.entryLinks)) kid(deref(l, scope), l.id, l.type === 'selectionEntryGroup');
      for (const g of arr(raw.selectionEntryGroups)) kid(g, null, true);
    };
    T.root = add(u.node, null, u.node.type === 'model' ? 'model' : 'unit', null);
    build(T.root, 0, []);

    /* is there anything to choose? (judged by the base constraint values) */
    const sb = (n) => {
      let min = 0, max = Infinity;
      for (const c of arr(n.raw.constraints)) {
        if (c.field !== 'selections' || (c.scope !== 'parent' && c.scope !== 'self')) continue;
        let v = Number(c.value);
        for (const { m, extra } of n.mods) {
          if (m.field === c.id && m.type === 'set' && !extra.length && !arr(m.conditions).length && !arr(m.conditionGroups).length && !arr(m.repeats).length) v = Number(m.value);
        }
        if (c.type === 'min') min = Math.max(min, v);
        if (c.type === 'max' && v >= 0) max = Math.min(max, v);
      }
      return { min, max };
    };
    const flex = (n) => { const b = sb(n); return b.min < b.max; };
    const choice = (n) => {
      if (!flex(n)) return false;
      const g = n.parent;
      if (!g || g.kind !== 'group' || g.free) return true;
      return flat(g).length > 1 || flex(g);
    };
    /* ... that changes which weapons the unit carries */
    const armed = (n) => n.weapons.length > 0 || n.kids.some(armed);
    const tops = T.nodes.filter(n => n.kind === 'model' && n !== T.root && !n.mp);
    T.cfg = T.nodes.some(n => n.kind === 'upgrade' && armed(n) && choice(n)) || tops.filter(n => armed(n) && choice(n)).length > 1;
    trees.set(ck, T);
    return T;
  }

  /* entries of a group, through nested groups */
  function flat(g, ok) {
    const out = [];
    const visit = (x) => { for (const k of x.kids) { if (ok && !ok(k)) continue; if (k.kind === 'group') visit(k); else out.push(k); } };
    visit(g);
    return out;
  }
  const within = (x, S) => { for (let p = x; p; p = p.parent) if (p === S) return true; return false; };
  const rosterUnit = (r, x) => { const f = Data.cats[r.fac]; return f ? factionUnits(f).units.find(u => u.id === x.id) || null : null; };

  /* ---------- conditions (true / false / null = unknown) ---------- */
  function scopeNode(scope, n, T) {
    if (scope === 'self') return n;
    if (scope === 'parent') return n.owner || T.root;
    if (scope === 'root-entry' || scope === 'unit') return T.root;
    if (scope === 'model' || scope === 'model-or-unit') return n.kind === 'model' ? n : n.mp || T.root;
    if (scope === 'ancestor' || scope === 'roster' || scope === 'force' || /^primary-/.test(scope)) return null;
    for (let p = n; p; p = p.parent) if (p.ids.has(scope)) return p;
    const l = T.byId.get(scope);
    return l ? l[0] : null;
  }
  function countIn(S, childId, st) {
    const T = st.T;
    const cnt = (x) => st.C.get(x.key) || 0;
    if (childId === 'model') {
      const ctx = S.kind === 'model' ? S : S.mp;
      const ms = T.nodes.filter(m => m.kind === 'model' && m !== S && m.mp === ctx && within(m, S));
      if (ms.length) return ms.reduce((a, m) => a + cnt(m), 0);
      return S.kind === 'model' ? (S === T.root ? 1 : cnt(S)) : S.mp ? cnt(S.mp) : (T.root.kind === 'model' ? 1 : 0);
    }
    if (!childId || childId === 'any' || childId === 'unit' || childId === 'upgrade') return null;
    let sum = 0;
    for (const x of (T.byId.get(childId) || [])) {
      if (!within(x, S)) continue;
      sum += x === T.root ? 1 : x.kind === 'group' ? flat(x).reduce((a, k) => a + cnt(k), 0) : cnt(x);
    }
    return sum;
  }
  function condCount(c, n, st) {
    const r = st.r;
    if (c.percentValue) return null;
    if (c.field === 'associations') {
      if (!r || scopeNode(c.scope, n, st.T) !== st.T.root) return null;
      return r.units.filter(x => x.lead === st.ru.uid).map(x => rosterUnit(r, x)).filter(Boolean)
        .filter(a => !c.childId || c.childId === 'any' || a.id === c.childId || a.catIds.has(c.childId)).length;
    }
    if (c.field !== 'selections') return null;
    if (c.scope === 'roster' || c.scope === 'force') {
      if (!r) return null;
      let k = 0;
      if (r.size === c.childId) k++;
      if (arr(r.dets).includes(c.childId)) k++;
      for (const x of r.units) {
        if (x.enh === c.childId) k++;
        const xu = x.id === c.childId ? null : rosterUnit(r, x);
        if (x.id === c.childId || (xu && xu.catIds.has(c.childId))) k++;
      }
      return k;
    }
    const S = scopeNode(c.scope, n, st.T);
    return S ? countIn(S, c.childId, st) : null;
  }
  function evalC(c, n, st) {
    if (c.type === 'instanceOf' || c.type === 'notInstanceOf') {
      let is;
      if (c.scope === 'primary-catalogue') is = st.u.fac.id === c.childId;
      else if (c.scope === 'ancestor') { is = false; for (let p = n.parent; p; p = p.parent) if (p.ids.has(c.childId)) is = true; }
      else { const S = scopeNode(c.scope, n, st.T); if (!S) return null; is = S.ids.has(c.childId); }
      return c.type === 'instanceOf' ? is : !is;
    }
    const k = condCount(c, n, st);
    return k == null ? null : cmp(c.type, k, Number(c.value));
  }
  function evalG(g, n, st) {
    const parts = arr(g.conditions).map(c => evalC(c, n, st)).concat(arr(g.conditionGroups).map(x => evalG(x, n, st)));
    if (!parts.length) return true;
    if (g.type === 'or') return parts.some(p => p === true) ? true : parts.some(p => p === null) ? null : false;
    return parts.some(p => p === false) ? false : parts.some(p => p === null) ? null : true;
  }
  const modCond = (x, n, st) => evalG({ type: 'and', conditions: arr(x.m.conditions), conditionGroups: arr(x.m.conditionGroups).concat(x.extra) }, n, st);
  /* a constraint value after the modifiers whose conditions are known to hold */
  function modded(n, field, base, st) {
    let v = base;
    for (const x of n.mods) {
      const m = x.m;
      if (m.field !== field || modCond(x, n, st) !== true) continue;
      let times = 1;
      if (arr(m.repeats).length) {
        times = 0;
        for (const rp of m.repeats) {
          const k = condCount(rp, n, st);
          if (k == null) { times = null; break; }
          const per = Number(rp.value) || 1;
          times += (rp.roundUp ? Math.ceil(k / per) : Math.floor(k / per)) * (Number(rp.repeats) || 1);
        }
        if (times == null) continue;
      }
      const val = Number(m.value) || 0;
      if (m.type === 'set') v = val; else if (m.type === 'increment') v += val * times; else if (m.type === 'decrement') v -= val * times;
    }
    return v;
  }

  /* ---------- counts of every model / wargear entry ---------- */
  function fill(st, W, n) {
    const T = st.T;
    const N = new Map(), B = new Map(), V = new Set(), GF = new Map();
    const cnt = (x) => N.get(x.key) || 0;
    const hid = (x) => x.mods.some(m => m.m.field === 'hidden' && (m.m.value === true || m.m.value === 'true') && modCond(m, x, st) === true);
    const bnd = (x) => {
      if (B.has(x.key)) return B.get(x.key);
      /* abs: a limit counted over the whole unit (or another enclosing entry), not per parent */
      let min = 0, max = Infinity, abs = Infinity;
      if (!x.free) for (const c of arr(x.raw.constraints)) {
        if (c.field !== 'selections' || (c.type !== 'min' && c.type !== 'max')) continue;
        const near = c.scope === 'parent' || c.scope === 'self';
        if (!near && (c.type !== 'max' || x.kind === 'group' || !scopeNode(c.scope, x, T))) continue;
        const v = modded(x, c.id, Number(c.value), st);
        if (!near) { if (v >= 0) abs = Math.min(abs, v); }
        else if (c.type === 'min') min = Math.max(min, v); else if (v >= 0) max = Math.min(max, v);
      }
      const b = { min: Math.min(min, max), max, abs };
      B.set(x.key, b);
      return b;
    };
    const mul = (v, P) => (P ? v * P : 0);
    const seen = (k) => V.has(k.key);

    /* the model type that fills the unit up to its size: the default of its group, else the most flexible one */
    let F = null;
    if (T.root.kind === 'unit') {
      const vis = (x) => { for (let p = x; p && p !== T.root; p = p.parent) if (hid(p)) return false; return true; };
      const tops = T.nodes.filter(x => x.kind === 'model' && !x.mp && vis(x));
      const isDef = (x) => x.parent && x.parent.kind === 'group' && x.parent.defId && x.ids.has(x.parent.defId);
      const room = (x) => Math.min(bnd(x).max, bnd(x).abs) - bnd(x).min;
      for (const x of tops.filter(x => room(x) > 0)) if (!F || (isDef(x) && !isDef(F)) || (isDef(x) === isDef(F) && room(x) > room(F))) F = x;
    }

    const fillKids = (parent, P) => {
      let sum = 0;
      for (const k of parent.kids) {
        if (hid(k)) continue;
        V.add(k.key);
        if (k.kind === 'group') { sum += fillGroup(k, P); continue; }
        const b = bnd(k);
        let c = k !== F && W[k.key] != null ? Math.floor(Number(W[k.key])) || 0 : 0;
        c = Math.min(Math.max(c, mul(b.min, P)), mul(b.max, P), b.abs);
        N.set(k.key, c); sum += c;
      }
      return sum;
    };
    const fillGroup = (g, P) => {
      let sum = fillKids(g, P);
      if (g.free || !P) return sum;
      const b = bnd(g);
      const ents = g.kids.filter(k => k.kind !== 'group' && seen(k));
      const all = flat(g, seen);
      const filler = ents.find(k => g.defId && k.ids.has(g.defId)) || ents[0] || all[0];
      GF.set(g.key, filler);
      if (filler && sum < b.min * P) {
        const a = Math.max(0, Math.min(b.min * P - sum, Math.min(bnd(filler).max * P, bnd(filler).abs) - cnt(filler)));
        N.set(filler.key, cnt(filler) + a); sum += a;
      }
      if (sum > b.max * P) {
        let over = sum - b.max * P;
        for (const k of [filler].concat(all.filter(k => k !== filler).reverse())) {
          if (!k || over <= 0) continue;
          const cut = Math.min(over, cnt(k) - mul(bnd(k).min, k.mp && k.mp !== g.mp ? cnt(k.mp) : P));
          if (cut > 0) { N.set(k.key, cnt(k) - cut); over -= cut; sum -= cut; }
        }
      }
      return sum;
    };

    N.set(T.root.key, 1); V.add(T.root.key);
    fillKids(T.root, 1);

    /* unit size: the filler model takes what is left; too many models are cut from the end */
    const tops = T.nodes.filter(x => x.kind === 'model' && !x.mp && x !== T.root && seen(x));
    let total = tops.reduce((a, x) => a + cnt(x), 0);
    if (T.root.kind === 'unit' && tops.length) {
      /* (when the filler's group is full, the other model types take the rest) */
      if (F) for (const k of [F].concat(tops.filter(k => k !== F))) {
        if (total >= n) break;
        let a = Math.min(n - total, Math.min(bnd(k).max, bnd(k).abs) - cnt(k));
        for (let g = k.parent; g && g.kind === 'group'; g = g.parent) if (!g.free) a = Math.min(a, bnd(g).max - flat(g, seen).reduce((s, x) => s + cnt(x), 0));
        if (a > 0) { N.set(k.key, cnt(k) + a); total += a; }
      }
      if (total > n) {
        let over = total - n;
        for (const k of [F].concat(tops.filter(k => k !== F).reverse())) {
          if (!k || over <= 0) continue;
          const cut = Math.min(over, cnt(k) - bnd(k).min);
          if (cut > 0) { N.set(k.key, cnt(k) - cut); over -= cut; total -= cut; }
        }
      }
    }

    /* wargear of every model / upgrade, multiplied by how many of them there are */
    const descend = (x) => {
      const each = (p) => { for (const k of p.kids) { if (!seen(k)) continue; if (k.kind === 'group') each(k); else { fillKids(k, cnt(k)); descend(k); } } };
      each(x);
    };
    descend(T.root);
    return { C: N, B, V, GF, F, total, tops: tops.length };
  }

  function errors(st, R, n) {
    const T = st.T;
    const out = new Set();
    const cnt = (x) => R.C.get(x.key) || 0;
    if (T.root.kind === 'unit' && R.tops && R.total !== n) out.add(`${R.total} / ${n} models`);
    for (const x of T.nodes) {
      if (!R.V.has(x.key) || x === T.root) continue;
      const P = x.owner === T.root || !x.owner ? 1 : cnt(x.owner);
      if (!P) continue;
      if (x.kind === 'group' && !x.free) {
        const b = R.B.get(x.key);
        const s = flat(x, k => R.V.has(k.key)).reduce((a, k) => a + cnt(k), 0);
        if (b && (s < b.min * P || s > b.max * P)) out.add(`${x.name}: ${s} / ${b.min * P === b.max * P ? b.max * P : rng(b.min * P, b.max * P)}`);
      }
      if (x.kind !== 'group' && cnt(x) > 0) {
        /* limits that count the whole unit (or another enclosing entry) instead of the direct parent */
        for (const c of arr(x.raw.constraints)) {
          if (c.field !== 'selections' || c.type !== 'max' || c.scope === 'parent' || c.scope === 'self') continue;
          const S = scopeNode(c.scope, x, T);
          if (!S || S === x) continue;
          const v = modded(x, c.id, Number(c.value), st);
          const tot = countIn(S, x.raw._targetId || x.raw.id, st);
          if (v >= 0 && tot != null && tot > v) out.add(`${x.name}: ${tot} / max ${v}`);
        }
      }
      for (const m of x.mods) {
        if (m.m.field !== 'error' || m.m.type !== 'add' || modCond(m, x, st) !== true) continue;
        out.add(String(m.m.value || '').replace(/\{this\}/g, x.name));
      }
    }
    return [...out];
  }

  /* Counts, bounds and rule errors of a roster unit. r (the roster) is optional. W overrides ru.w. */
  function resolveUnit(u, ru, r, W, raw) {
    const T = tree(u);
    W = W || ru.w || {};
    const n = Number(ru.n) || 1;
    const mk = [T.ck, n, JSON.stringify(W), ru.uid, r ? r.id + ':' + r.updated + ':' + r.units.length : '', raw ? 1 : 0].join('|');
    if (memo.has(mk)) return memo.get(mk);
    const st = { T, u, ru, r, C: new Map() };
    let R = null;
    for (let pass = 0; pass < 3; pass++) { R = fill(st, W, n); st.C = R.C; }
    R.T = T;
    R.errs = errors(st, R, n);
    /* whatever the untouched default loadout already reports is a quirk of the data, not a wrong choice */
    if (!raw && R.errs.length) {
      const base = new Set(resolveUnit(u, ru, r, {}, true).errs);
      R.errs = R.errs.filter(e => !base.has(e));
    }
    if (memo.size > 400) memo.clear();
    memo.set(mk, R);
    return R;
  }

  const configurable = (u) => { try { return tree(u).cfg; } catch (e) { console.warn(e); return false; } };

  /* weapon key -> how many of it the unit carries (0 = part of the unit itself) */
  function weapons(u, ru, r) {
    const R = resolveUnit(u, ru, r);
    const m = new Map();
    for (const x of R.T.nodes) {
      if (!R.V.has(x.key) || x.kind === 'group') continue;
      const c = x === R.T.root ? (x.kind === 'model' ? 1 : 0) : (R.C.get(x.key) || 0);
      if (x !== R.T.root && !c) continue;
      for (const k of x.weapons) m.set(k, (m.get(k) || 0) + c);
    }
    return m;
  }

  /* text lines for the export: "4× Plague Marine w/ boltgun", "Plague Champion: Power fist, Plasma gun" */
  function summary(u, ru, r) {
    const R = resolveUnit(u, ru, r);
    const T = R.T;
    const cnt = (x) => R.C.get(x.key) || 0;
    const gear = (x) => T.nodes.filter(k => k.kind === 'upgrade' && k.owner === x && R.V.has(k.key) && cnt(k) > 0)
      .map(k => k.name + (cnt(k) > 1 && cnt(k) !== cnt(x) ? ` ×${cnt(k)}` : ''));
    const lines = [];
    if (T.root.kind === 'unit') {
      for (const m of T.nodes.filter(x => x.kind === 'model' && !x.mp && R.V.has(x.key) && cnt(x) > 0)) {
        const g = gear(m);
        lines.push(`${cnt(m)}× ${m.name}${g.length ? ': ' + g.join(', ') : ''}`);
      }
    }
    const own = gear(T.root);
    if (own.length) lines.push(own.join(', '));
    return lines;
  }

  /* ---------- changes ---------- */
  function clean(u, ru) {
    const T = tree(u);
    const w = ru.w || {};
    for (const k of Object.keys(w)) if (!T.byKey.has(k) || !(Number(w[k]) > 0)) delete w[k];
    if (Object.keys(w).length) ru.w = w; else delete ru.w;
  }
  /* would setting this entry to "target" really work, without breaking a rule or pushing out another choice? */
  function can(u, ru, r, key, target) {
    const R0 = resolveUnit(u, ru, r);
    const W = Object.assign({}, ru.w || {}, { [key]: target });
    const R1 = resolveUnit(u, ru, r, W);
    if ((R1.C.get(key) || 0) !== target) return false;
    if (R1.errs.some(e => !R0.errs.includes(e))) return false;
    for (const k of Object.keys(ru.w || {})) if (k !== key && (R1.C.get(k) || 0) < (R0.C.get(k) || 0)) return false;
    return true;
  }
  function setCount(u, ru, key, val) {
    ru.w = Object.assign({}, ru.w || {}, { [key]: Math.max(0, val) });
    clean(u, ru);
  }
  function step(u, ru, r, key, d) {
    const c = resolveUnit(u, ru, r).C.get(key) || 0;
    setCount(u, ru, key, c + d);
  }
  /* one option of a "choose one" group ('' = none) */
  function pick(u, ru, groupKey, key) {
    const g = tree(u).byKey.get(groupKey);
    if (!g) return;
    const w = Object.assign({}, ru.w || {});
    for (const k of g.kids) delete w[k.key];
    if (key && g.kids.some(k => k.key === key)) w[key] = 1;
    ru.w = w;
    clean(u, ru);
  }

  /* ---------- editor ---------- */
  function panel(u, ru, r) {
    const R = resolveUnit(u, ru, r);
    const T = R.T;
    const id = esc(ru.uid);
    const cnt = (x) => R.C.get(x.key) || 0;
    const vis = (x) => R.V.has(x.key);
    const bnd = (x) => R.B.get(x.key) || { min: 0, max: Infinity, abs: Infinity };
    const mul = (v, P) => (P ? v * P : 0);
    const wrap = (h) => (h ? `<div class="b-load-in">${h}</div>` : '');
    const chips = (fixed) => (fixed.length ? `<div class="b-load-fixed">${fixed.map(esc).join(' · ')}</div>` : '');

    const kidsHtml = (parent, P) => {
      const fixed = [];
      let h = '';
      for (const k of parent.kids) {
        if (!vis(k)) continue;
        h += k.kind === 'group' ? groupHtml(k, P, fixed) : entryHtml(k, P, null, fixed);
      }
      return chips(fixed) + h;
    };
    const groupHtml = (g, P, fixed) => {
      if (!P) return '';
      const ents = flat(g, vis);
      if (!ents.length) return '';
      const b = bnd(g);
      const lo = mul(b.min, P), hi = mul(b.max, P);
      const direct = g.kids.filter(vis);
      const simple = direct.every(k => k.kind === 'upgrade');
      if (!g.free && simple && hi === 1 && direct.length > 1) {
        const sel = direct.find(k => cnt(k) > 0);
        return `<label class="b-load-sel"><span>${esc(g.name)}</span><select data-bwsel="${id}" data-g="${esc(g.key)}">${lo === 0 ? '<option value="">—</option>' : ''}${direct.map(k =>
          `<option value="${esc(k.key)}"${k === sel ? ' selected' : ''}>${esc(k.name)}</option>`).join('')}</select></label>${sel ? wrap(kidsHtml(sel, cnt(sel))) : ''}`;
      }
      const gb = { lo, hi, n: ents.length };
      /* a container without limits of its own is not worth a heading */
      if (g.free || (lo === 0 && hi === Infinity) || (lo === hi && direct.every(k => k.kind === 'group'))) return direct.map(k => (k.kind === 'group' ? groupHtml(k, P, fixed) : entryHtml(k, P, gb, fixed))).join('');
      const own = [];
      const body = direct.map(k => (k.kind === 'group' ? groupHtml(k, P, own) : entryHtml(k, P, gb, own))).join('');
      if (!body) { fixed.push(...own); return ''; }
      const sum = ents.reduce((a, k) => a + cnt(k), 0);
      return `<div class="b-load-g"><span>${esc(g.name)}</span><span class="g">${sum}${hi < Infinity ? ' / ' + (lo === hi ? hi : rng(lo, hi)) : ''}</span></div>${wrap(chips(own) + body)}`;
    };
    const entryHtml = (k, P, gb, fixed) => {
      if (!P) return '';
      const b = bnd(k);
      const c = cnt(k);
      let lo = mul(b.min, P), hi = Math.min(mul(b.max, P), b.abs);
      if (gb) { hi = Math.min(hi, gb.hi); if (gb.n === 1 && gb.lo === gb.hi) lo = hi; }
      const sub = () => (c ? wrap(kidsHtml(k, c)) : '');
      const key = esc(k.key);
      if (lo >= hi) {
        if (!c) return '';
        if (k.kind === 'model') return `<div class="b-load-row"><span class="nm">${esc(k.name)}</span><span class="b-step"><b>×${c}</b></span></div>${sub()}`;
        fixed.push(k.name + (c > 1 && c !== P ? ` ×${c}` : ''));
        return sub();
      }
      if (k === R.F) return `<div class="b-load-row"><span class="nm">${esc(k.name)}</span><span class="b-step"><span class="g">auto</span><b>×${c}</b></span></div>${sub()}`;
      if (hi === 1) return `<label class="chk b-load-chk"><input type="checkbox" data-bwchk="${id}" data-k="${key}"${c ? ' checked' : ''}${!c && !can(u, ru, r, k.key, 1) ? ' disabled' : ''}> ${esc(k.name)}</label>${sub()}`;
      return `<div class="b-load-row"><span class="nm">${esc(k.name)}</span><span class="b-step">
          <button class="icon-btn sm" data-b="wdec" data-ruid="${id}" data-k="${key}"${c > lo && can(u, ru, r, k.key, c - 1) ? '' : ' disabled'} aria-label="Less">−</button><b>${c}</b>
          <button class="icon-btn sm" data-b="winc" data-ruid="${id}" data-k="${key}"${c < hi && can(u, ru, r, k.key, c + 1) ? '' : ' disabled'} aria-label="More">＋</button></span></div>${sub()}`;
    };
    return `<div class="b-load">${kidsHtml(T.root, 1)}${R.errs.map(e => `<div class="b-err">✕ ${esc(e)}</div>`).join('')}
      ${ru.w ? `<div class="b-load-foot"><button class="btn sm" data-b="wreset" data-ruid="${id}">Reset</button></div>` : ''}</div>`;
  }

  return { tree, resolve: resolveUnit, configurable, weapons, summary, panel, step, pick, setCount, clean };
})();
window.Loadout = Loadout;
