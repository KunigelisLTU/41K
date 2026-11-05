/* 40k Codex — Change Log.
   Separate mode (#/log) on top of the helpers in app.js.
   A version is one BSData commit (or one day of commits). For each version the changed data files are downloaded
   from GitHub at the version and at its parent, compared entry by entry (by BSData id) and listed per army.
   Commit lists and computed changes are kept in IndexedDB, so a version is only downloaded once. */
'use strict';

const Changelog = (() => {
  const DIFF_V = 3;                             /* bump when the stored change format changes */
  const COMMITS_TTL = 10 * 60 * 1000;
  const MAX_ITEMS = 25;                           /* changes shown per entry before "… more" */
  const st = {
    commits: null, fetched: 0, more: true, loadingList: false, listErr: '',
    group: store.get('logGroup', 'commit'), army: store.get('logArmy', ''),
    key: null, diffs: new Map(), busy: null, err: '', token: 0,
  };
  const el = () => $('#changelog');
  const raw = new Map();                          /* "sha:path" -> parsed JSON (last few only) */

  /* ---------------------------------------------------------------- GitHub */
  async function gh(path) {
    const tok = store.get('ghToken', '');
    const h = { Accept: 'application/vnd.github+json' };
    let r = await fetch('https://api.github.com' + path, { headers: tok ? Object.assign({ Authorization: 'Bearer ' + tok }, h) : h });
    if (tok && (r.status === 401 || r.status === 403)) r = await fetch('https://api.github.com' + path, { headers: h });
    if (!r.ok) {
      const limit = r.headers.get('x-ratelimit-remaining') === '0';
      throw new Error('GitHub ' + r.status + (limit ? ' — hourly request limit reached, try again later' : ''));
    }
    return r.json();
  }
  const toCommit = c => ({
    sha: c.sha, parent: c.parents && c.parents[0] ? c.parents[0].sha : null,
    date: c.commit.committer.date, msg: c.commit.message, author: c.commit.author ? c.commit.author.name : '',
  });

  async function loadCommits(force) {
    if (!st.commits) {
      try { const c = await idbGet('log:commits'); if (c) { st.commits = c.list; st.fetched = c.at; st.more = c.more; } } catch (e) { /* ignore */ }
    }
    if (!force && st.commits && Date.now() - st.fetched < COMMITS_TTL) return;
    const page = arr(await gh(`/repos/${REPO}/commits?sha=${BRANCH}&per_page=100`)).map(toCommit);
    const old = st.commits || [];
    const last = page.length ? page[page.length - 1].sha : null;
    const i = old.findIndex(c => c.sha === last);
    if (i >= 0) st.commits = page.concat(old.slice(i + 1));
    else { st.commits = page; st.more = page.length === 100; }
    st.fetched = Date.now();
    saveCommits();
  }
  async function loadOlder() {
    const last = st.commits && st.commits[st.commits.length - 1];
    if (!last || !last.parent) { st.more = false; return; }
    const page = arr(await gh(`/repos/${REPO}/commits?sha=${last.parent}&per_page=100`)).map(toCommit);
    const have = new Set(st.commits.map(c => c.sha));
    st.commits = st.commits.concat(page.filter(c => !have.has(c.sha)));
    st.more = page.length === 100;
    saveCommits();
  }
  function saveCommits() { idbPut('log:commits', { list: st.commits, at: st.fetched, more: st.more }).catch(() => {}); }

  /* One data file at one commit. The loaded version is taken from memory. */
  async function getJson(sha, path) {
    const name = path.split('/').pop();
    const cur = window.BSDATA_VERSION || {};
    if (cur.sha === sha && Array.isArray(window.BSDATA)) {
      const f = window.BSDATA.find(x => x.file === name);
      if (f) return f.data;
    }
    const k = sha + ':' + path;
    if (raw.has(k)) return raw.get(k);
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`);
    if (!res.ok) throw new Error(name + ': ' + res.status);
    const data = JSON.parse(await res.text());
    raw.set(k, data);
    while (raw.size > 8) raw.delete(raw.keys().next().value);
    return data;
  }

  /* ---------------------------------------------------------------- versions */
  const localDay = d => { const t = new Date(d); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  const localTime = d => { const t = new Date(d); return `${localDay(d)} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };

  function versions() {
    const c = st.commits || [];
    if (st.group !== 'day') return c.map(x => ({ key: x.sha, head: x.sha, base: x.parent, commits: [x], date: x.date }));
    const out = [];
    let cur = null;
    for (const x of c) {
      const d = localDay(x.date);
      if (!cur || cur.day !== d) { cur = { key: 'd' + d, day: d, head: x.sha, commits: [], date: x.date }; out.push(cur); }
      cur.commits.push(x);
      cur.base = x.parent;
    }
    if (out.length && st.more) out[out.length - 1].partial = true;
    return out;
  }
  const loadedSha = () => (window.BSDATA_VERSION || {}).sha || '';
  const isLoaded = v => v.commits.some(c => c.sha === loadedSha());
  const isNew = v => { const cur = window.BSDATA_VERSION; return !!(cur && cur.date && new Date(v.date) > new Date(cur.date)) && !isLoaded(v); };

  function findVersion(vs, key) {
    if (!key) return null;
    let v = vs.find(x => x.key === key);
    if (v) return v;
    if (/^d\d{4}-/.test(key)) return vs.find(x => x.commits.some(c => localDay(c.date) === key.slice(1))) || null;
    return vs.find(x => x.commits.some(c => c.sha === key || c.sha.startsWith(key))) || null;
  }

  /* ---------------------------------------------------------------- diff */
  const SKIP_F = new Set(['id', 'sortIndex', 'comment']);
  const hasIdItems = v => Array.isArray(v) && v.some(x => x && typeof x === 'object' && x.id);

  /* every object with an id: key -> { o, parent, owner (top-level entry), coll (array it is in) } */
  function index(root) {
    const m = new Map();
    const walk = (o, parent, owner) => {
      for (const k in o) {
        const v = o[k];
        if (!hasIdItems(v)) continue;
        for (const c of v) {
          if (!c || typeof c !== 'object' || !c.id) continue;
          let key = c.id;
          if (m.has(key)) { let n = 2; while (m.has(key + '#' + n)) n++; key += '#' + n; }
          m.set(key, { key, o: c, parent, owner: owner || key, coll: k });
          walk(c, key, owner || key);
        }
      }
    };
    walk(root, null, null);
    return m;
  }

  let gsNames = null;
  function gsName(id) {
    if (!gsNames) {
      gsNames = new Map();
      const g = Data.gs && Data.gs.raw;
      if (g) {
        for (const t of arr(g.costTypes)) gsNames.set(t.id, t.name);
        for (const p of arr(g.profileTypes)) { gsNames.set(p.id, p.name); for (const c of arr(p.characteristicTypes)) gsNames.set(c.id, c.name); }
        for (const c of arr(g.categoryEntries)) gsNames.set(c.id, c.name);
        for (const c of arr(g.sharedRules)) gsNames.set(c.id, c.name);
      }
    }
    return gsNames.get(id);
  }

  function kindOf(o, coll) {
    if (o.typeName) return o.typeName;
    switch (coll) {
      case 'constraints': return 'limit';
      case 'categoryLinks': case 'categoryEntries': return 'keyword';
      case 'infoLinks': return o.type === 'rule' ? 'rule' : o.type === 'profile' ? 'profile' : 'info';
      case 'entryLinks': return o.type === 'selectionEntryGroup' ? 'option group' : 'option';
      case 'selectionEntries': case 'sharedSelectionEntries': return o.type || 'entry';
      case 'selectionEntryGroups': case 'sharedSelectionEntryGroups': return 'option group';
      case 'rules': case 'sharedRules': return 'rule';
      case 'forceEntries': return 'force';
      case 'associations': return 'association';
      case 'publications': return 'publication';
      case 'costTypes': return 'cost type';
      case 'profileTypes': return 'profile type';
    }
    return coll ? coll.replace(/ies$/, 'y').replace(/s$/, '') : '';
  }
  function groupOf(o, coll) {
    switch (coll) {
      case 'sharedSelectionEntries': case 'selectionEntries':
        return o.type === 'unit' || o.type === 'model' ? 'Units' : 'Wargear, upgrades & detachments';
      case 'sharedSelectionEntryGroups': case 'selectionEntryGroups': return 'Wargear, upgrades & detachments';
      case 'entryLinks': return 'Army list';
      case 'sharedRules': case 'rules': return 'Rules';
      case 'sharedProfiles': case 'profiles': return 'Abilities & profiles';
      case 'categoryEntries': return 'Keywords';
      case 'forceEntries': return 'Army roster';
    }
    return 'Other';
  }
  const GROUP_ORDER = ['Units', 'Army list', 'Wargear, upgrades & detachments', 'Abilities & profiles', 'Rules', 'Keywords', 'Army roster', 'Other'];

  function makeNamer(A, B) {
    return id => {
      if (id == null) return '';
      const r = B.get(id) || A.get(id);
      if (r && r.o.name) return r.o.name;
      const g = gsName(id);
      if (g) return g;
      for (const c of Data.list) { const n = ensureIndex(c).get(id); if (n && n.name) return n.name; }
      return id;
    };
  }

  const ID_RE = /^[0-9a-f]{1,4}(-[0-9a-f]{1,4}){3}$/i;
  const OPS = { equalTo: '=', notEqualTo: '≠', atLeast: '≥', atMost: '≤', greaterThan: '>', lessThan: '<' };
  function descCond(c, nm) {
    const child = c.childName || nm(c.childId);
    if (c.type === 'instanceOf') return `is ${child}`;
    if (c.type === 'notInstanceOf') return `is not ${child}`;
    const scope = c.scope && c.scope !== 'self' ? ` in ${c.scope === 'parent' || c.scope === 'roster' || c.scope === 'force' ? c.scope : nm(c.scope)}` : '';
    const field = c.field && c.field !== 'selections' ? ` ${nm(c.field)}` : '';
    return `${child}${field}${scope} ${OPS[c.type] || c.type} ${c.value}`;
  }
  function descGroup(g, nm) {
    const parts = arr(g.conditions).map(c => descCond(c, nm)).concat(arr(g.conditionGroups).map(x => `(${descGroup(x, nm)})`));
    return parts.join(` ${g.type || 'and'} `);
  }
  function descWhen(o, nm) {
    const parts = arr(o.conditions).map(c => descCond(c, nm)).concat(arr(o.conditionGroups).map(g => descGroup(g, nm)));
    return parts.length ? ` if ${parts.join(' and ')}` : '';
  }
  function descMod(m, nm) {
    const field = m.field === 'hidden' || m.field === 'name' || m.field === 'category' ? m.field : nm(m.field);
    const val = m.field === 'category' || (typeof m.value === 'string' && ID_RE.test(m.value)) ? nm(m.value) : m.value;
    const rep = arr(m.repeats).map(r => ` (repeat ×${r.repeats} per ${r.value} ${r.childName || nm(r.childId)})`).join('');
    return `${m.type} ${field}${val !== undefined ? ' ' + val : ''}${rep}${descWhen(m, nm)}`;
  }
  function descModGroup(g, nm) {
    return arr(g.modifiers).map(m => descMod(m, nm) + descWhen(g, nm)).concat(arr(g.modifierGroups).flatMap(x => descModGroup(x, nm).map(s => s + descWhen(g, nm))));
  }
  function descConstraint(o, nm) {
    const field = o.field && o.field !== 'selections' ? ' ' + nm(o.field) : '';
    return `${o.type} ${o.value}${field}${o.scope ? ` per ${o.scope === 'parent' || o.scope === 'roster' || o.scope === 'force' ? o.scope : nm(o.scope)}` : ''}`;
  }
  const isLong = s => typeof s === 'string' && (s.length > 60 || /\n/.test(s));
  const show = v => v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v);

  /* field-level changes between two versions of the same object */
  function fieldChanges(a, b, nm) {
    const out = [];
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const k of keys) {
      if (SKIP_F.has(k) || hasIdItems(a[k]) || hasIdItems(b[k])) continue;
      if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
      if (k === 'characteristics') {
        const ma = new Map(arr(a[k]).map(c => [c.name, c.$text])), mb = new Map(arr(b[k]).map(c => [c.name, c.$text]));
        for (const n of new Set([...ma.keys(), ...mb.keys()])) {
          const x = ma.get(n), y = mb.get(n);
          if (x === y) continue;
          out.push(isLong(x) || isLong(y) ? { t: 'text', l: n, a: x || '', b: y || '' } : { t: 'pair', l: n, a: x, b: y });
        }
      } else if (k === 'costs') {
        const ma = new Map(arr(a[k]).map(c => [c.name || nm(c.typeId), c.value])), mb = new Map(arr(b[k]).map(c => [c.name || nm(c.typeId), c.value]));
        for (const n of new Set([...ma.keys(), ...mb.keys()])) if (ma.get(n) !== mb.get(n)) out.push({ t: 'pair', l: n, a: ma.get(n), b: mb.get(n), cost: true });
      } else if (k === 'modifiers' || k === 'modifierGroups' || k === 'conditions' || k === 'conditionGroups' || k === 'repeats' || k === 'localConditionGroups') {
        const list = o => k === 'modifiers' ? arr(o[k]).map(m => descMod(m, nm))
          : k === 'modifierGroups' ? arr(o[k]).flatMap(g => descModGroup(g, nm))
          : k === 'conditions' ? arr(o[k]).map(c => descCond(c, nm))
          : k === 'conditionGroups' || k === 'localConditionGroups' ? arr(o[k]).map(g => descGroup(g, nm))
          : arr(o[k]).map(r => JSON.stringify(r));
        const la = list(a), lb = list(b);
        const rem = la.filter(x => !lb.includes(x)), add = lb.filter(x => !la.includes(x));
        if (rem.length || add.length) out.push({ t: 'list', l: k.replace(/([A-Z])/g, ' $1').toLowerCase(), rem, add });
      } else if (k === 'targetId') {
        out.push({ t: 'pair', l: 'links to', a: nm(a[k]), b: nm(b[k]) });
      } else if (k === 'hidden') {
        out.push({ t: 'pair', l: 'visibility', a: a[k] ? 'hidden' : 'shown', b: b[k] ? 'hidden' : 'shown' });
      } else if (isLong(a[k]) || isLong(b[k])) {
        out.push({ t: 'text', l: k, a: show(a[k]), b: show(b[k]) });
      } else {
        out.push({ t: 'pair', l: k, a: show(a[k]), b: show(b[k]) });
      }
    }
    return out;
  }

  function titleOf(rec, nm) {
    const o = rec.o;
    if (rec.coll === 'constraints') return descConstraint(o, nm);
    return o.name || (o.targetId ? nm(o.targetId) : '') || rec.coll || '';
  }
  /* short facts shown for added / removed entries */
  function factsOf(o) {
    const f = [];
    for (const c of arr(o.costs)) if (c.value) f.push(`${c.name || 'cost'} ${c.value}`);
    if (o.characteristics) {
      const ch = arr(o.characteristics).filter(c => !isLong(c.$text));
      if (ch.length) f.push(ch.map(c => `${c.name} ${c.$text}`).join(' · '));
      const d = arr(o.characteristics).find(c => isLong(c.$text));
      if (d && !ch.length) f.push({ text: d.$text });
    }
    if (o.description) f.push({ text: o.description });
    return f;
  }

  function diffFile(a, b, f) {
    const ra = a && (a.catalogue || a.gameSystem), rb = b && (b.catalogue || b.gameSystem);
    const r = rb || ra || {};
    const res = {
      file: f.filename.split('/').pop(), name: r.name || f.filename, id: r.id || '', library: !!r.library,
      gs: !!((b && b.gameSystem) || (a && a.gameSystem)), status: f.status,
      rev: [ra ? ra.revision : null, rb ? rb.revision : null], owners: [], counts: { added: 0, removed: 0, changed: 0 },
    };
    if (!ra || !rb) return res;
    const A = index(ra), B = index(rb);
    const nm = makeNamer(A, B);
    const owners = new Map();
    const ownerFor = (rec, M) => {
      const k = rec.owner;
      if (!owners.has(k)) {
        const or = M.get(k);
        owners.set(k, { name: titleOf(or, nm), kind: kindOf(or.o, or.coll), group: groupOf(or.o, or.coll), status: 'changed', items: [] });
      }
      return owners.get(k);
    };
    const pathOf = (rec, M) => {
      const p = [];
      let cur = rec.parent ? M.get(rec.parent) : null;
      while (cur && cur.key !== rec.owner) {
        if (cur.coll !== 'constraints' && cur.o.name) p.unshift(cur.o.name);
        cur = cur.parent ? M.get(cur.parent) : null;
      }
      return p;
    };
    const push = (rec, M, status, changes) => {
      const own = ownerFor(rec, M);
      if (rec.key === rec.owner) {
        if (status !== 'changed') { own.status = status; own.facts = factsOf(rec.o); return; }
        own.items.unshift({ self: true, status, changes });
        return;
      }
      own.items.push({ path: pathOf(rec, M), name: titleOf(rec, nm), kind: kindOf(rec.o, rec.coll), status, changes, facts: status === 'changed' ? null : factsOf(rec.o) });
    };
    for (const [k, rec] of B) {
      const old = A.get(k);
      if (!old) {
        if (rec.parent && !A.has(rec.parent)) continue;          /* inside something that is new as a whole */
        push(rec, B, 'added');
      } else {
        const ch = fieldChanges(old.o, rec.o, nm);
        if (ch.length) push(rec, B, 'changed', ch);
      }
    }
    for (const [k, rec] of A) {
      if (B.has(k)) continue;
      if (rec.parent && !B.has(rec.parent)) continue;
      push(rec, A, 'removed');
    }
    /* catalogue-level fields (revision is shown in the header) */
    const top = fieldChanges(Object.assign({}, ra, { revision: 0 }), Object.assign({}, rb, { revision: 0 }), nm);
    if (top.length) res.top = top;
    res.owners = [...owners.values()].filter(o => o.status !== 'changed' || o.items.length);
    for (const o of res.owners) res.counts[o.status]++;
    res.owners.sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group) || x.name.localeCompare(y.name));
    return res;
  }

  async function diffFor(v, onProgress) {
    const key = `log:d${DIFF_V}:${v.base}..${v.head}`;
    if (st.diffs.has(key)) return st.diffs.get(key);
    try { const c = await idbGet(key); if (c) { st.diffs.set(key, c); return c; } } catch (e) { /* ignore */ }
    if (!v.base) { const r = { files: [], initial: true }; st.diffs.set(key, r); return r; }
    onProgress('Reading the list of changed files…');
    const cmp = await gh(`/repos/${REPO}/compare/${v.base}...${v.head}`);
    const all = arr(cmp.files);
    const files = all.filter(f => /\.json$/i.test(f.filename) && !/^\.github\//.test(f.filename));
    const out = { files: [], other: all.filter(f => !files.includes(f)).map(f => f.filename), truncated: all.length >= 300 };
    let i = 0;
    for (const f of files) {
      onProgress(`Comparing ${f.filename.replace(/\.json$/i, '')} (${++i}/${files.length})…`);
      const oldPath = f.status === 'added' ? null : (f.previous_filename || f.filename);
      const newPath = f.status === 'removed' ? null : f.filename;
      const [a, b] = await Promise.all([oldPath ? getJson(v.base, oldPath) : null, newPath ? getJson(v.head, newPath) : null]);
      await new Promise(r => setTimeout(r, 0));
      out.files.push(diffFile(a, b, f));
    }
    out.files.sort((x, y) => (x.gs ? 0 : 1) - (y.gs ? 0 : 1) || x.name.localeCompare(y.name));
    st.diffs.set(key, out);
    idbPut(key, out).catch(() => {});
    return out;
  }

  /* ---------------------------------------------------------------- word diff */
  const clean = s => String(s == null ? '' : s).replace(/\*\*|\^\^/g, '');
  function wordDiff(a, b) {
    const x = clean(a).split(/(\s+)/), y = clean(b).split(/(\s+)/);
    const n = x.length, m = y.length;
    if (n * m > 400000) return `<div class="ld-old"><del>${esc(clean(a))}</del></div><div class="ld-new"><ins>${esc(clean(b))}</ins></div>`;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0, same = 0;
    const ops = [];
    while (i < n && j < m) {
      if (x[i] === y[j]) { ops.push(['=', x[i]]); if (/\S/.test(x[i])) same++; i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) ops.push(['-', x[i++]]);
      else ops.push(['+', y[j++]]);
    }
    while (i < n) ops.push(['-', x[i++]]);
    while (j < m) ops.push(['+', y[j++]]);
    const words = Math.max(x.filter(s => /\S/.test(s)).length, y.filter(s => /\S/.test(s)).length);
    /* mostly rewritten: old and new text one under the other */
    if (words > 6 && same / words < 0.4) return `<div class="ld-old"><del>${esc(clean(a)).replace(/\n/g, '<br>')}</del></div><div class="ld-new"><ins>${esc(clean(b)).replace(/\n/g, '<br>')}</ins></div>`;
    /* changed runs: all removed words first, then all added words */
    let h = '', del = '', ins = '';
    const flush = () => { if (del) h += `<del>${esc(del)}</del>`; if (ins) h += `<ins>${esc(ins)}</ins>`; del = ins = ''; };
    ops.forEach(([t, s], k) => {
      if (t === '-') del += s;
      else if (t === '+') ins += s;
      else if (!/\S/.test(s) && (del || ins) && ops[k + 1] && ops[k + 1][0] !== '=') { del += s; ins += s; }
      else { flush(); h += esc(s); }
    });
    flush();
    return h.replace(/\n/g, '<br>');
  }

  /* ---------------------------------------------------------------- render */
  const STATUS = { added: 'Added', removed: 'Removed', changed: 'Changed' };
  function armyLabel(fd) {
    if (fd.gs) return { name: 'Core rules', sub: fd.name + ' · all armies' };
    const parts = fd.name.split(' - ');
    const name = parts.length > 1 ? parts.slice(1).join(' - ').replace(/^Adeptus Astartes - /, '') : fd.name;
    let sub = parts.length > 1 ? parts[0] : '';
    if (fd.library) {
      const users = Data.factions.filter(f => arr(f.cat.raw.catalogueLinks).some(l => l.targetId === fd.id)).map(f => f.label);
      sub = 'Library' + (users.length ? ' · used by ' + users.join(', ') : '');
    }
    return { name, sub };
  }
  /* does this file matter for the chosen army (its own catalogue, its libraries, the core rules)? */
  function forArmy(fd) {
    if (!st.army) return true;
    const c = Data.cats[st.army];
    if (!c) return true;
    return (c.scope || []).some(x => x.id === fd.id);
  }

  function changeHtml(c) {
    if (c.t === 'pair') {
      let d = '';
      const na = Number(c.a), nb = Number(c.b);
      if (c.cost && !isNaN(na) && !isNaN(nb)) d = ` <span class="ld-delta ${nb > na ? 'up' : 'down'}">${nb > na ? '+' : ''}${nb - na}</span>`;
      return `<span class="ld-pair"><span class="ld-l">${esc(c.l)}</span> <del>${esc(c.a == null ? '—' : clean(c.a))}</del> → <ins>${esc(c.b == null ? '—' : clean(c.b))}</ins>${d}</span>`;
    }
    if (c.t === 'text') return `<div class="ld-text"><span class="ld-l">${esc(c.l)}</span><div class="ld-words">${wordDiff(c.a, c.b)}</div></div>`;
    if (c.t === 'list') return `<div class="ld-list"><span class="ld-l">${esc(c.l)}</span>${c.rem.map(s => `<div><del>− ${esc(clean(s))}</del></div>`).join('')}${c.add.map(s => `<div><ins>+ ${esc(clean(s))}</ins></div>`).join('')}</div>`;
    return '';
  }
  function factsHtml(facts) {
    if (!facts || !facts.length) return '';
    return `<div class="ld-facts">${facts.map(f => typeof f === 'string' ? `<span>${esc(clean(f))}</span>` : `<div class="ld-desc">${fmt(f.text)}</div>`).join('')}</div>`;
  }
  function itemHtml(it) {
    const path = it.path && it.path.length ? `<span class="ld-path">${it.path.slice(-3).map(esc).join(' › ')} › </span>` : '';
    const head = it.self ? '' : `<span class="ld-st ${it.status}">${it.status === 'added' ? '+' : it.status === 'removed' ? '−' : '~'}</span>${path}<b>${esc(clean(it.name))}</b>${it.kind ? ` <span class="ld-kind">${esc(it.kind)}</span>` : ''}`;
    const body = it.changes ? `<div class="ld-changes">${it.changes.map(changeHtml).join('')}</div>` : factsHtml(it.facts);
    return `<li class="ld-item ${it.status}${it.self ? ' self' : ''}">${head}${body}</li>`;
  }
  function ownerHtml(o) {
    const items = o.items;
    const shown = items.slice(0, MAX_ITEMS).map(itemHtml).join('');
    const rest = items.length > MAX_ITEMS ? `<details class="ld-more"><summary>${items.length - MAX_ITEMS} more changes</summary><ul>${items.slice(MAX_ITEMS).map(itemHtml).join('')}</ul></details>` : '';
    return `<div class="ld-entry ${o.status}">
      <div class="ld-head"><span class="ld-badge ${o.status}">${STATUS[o.status]}</span><span class="ld-name">${esc(clean(o.name))}</span><span class="ld-kind">${esc(o.kind)}</span></div>
      ${o.status !== 'changed' ? factsHtml(o.facts) : ''}
      ${items.length ? `<ul>${shown}</ul>${rest}` : ''}
    </div>`;
  }
  function armyHtml(fd, open) {
    const lab = armyLabel(fd);
    const cnt = fd.counts || { added: 0, removed: 0, changed: 0 };
    const rev = fd.rev && fd.rev[0] != null && fd.rev[1] != null && fd.rev[0] !== fd.rev[1] ? `rev ${fd.rev[0]} → ${fd.rev[1]}` : '';
    let body = '';
    if (fd.status === 'added') body = '<p class="note">New data file.</p>';
    else if (fd.status === 'removed') body = '<p class="note">Data file removed.</p>';
    else if (!fd.owners.length && !fd.top) body = '<p class="note">Only the revision number changed.</p>';
    else {
      let grp = null;
      for (const o of fd.owners) {
        if (o.group !== grp) { if (grp) body += '</div>'; grp = o.group; body += `<div class="ld-group"><h4>${esc(grp)}</h4>`; }
        body += ownerHtml(o);
      }
      if (grp) body += '</div>';
      if (fd.top) body += `<div class="ld-group"><h4>Catalogue</h4><div class="ld-entry changed"><div class="ld-changes">${fd.top.map(changeHtml).join('')}</div></div></div>`;
    }
    return `<details class="ld-army"${open ? ' open' : ''}>
      <summary><span class="ld-army-name">${esc(lab.name)}</span><span class="ld-army-sub">${esc(lab.sub)}</span>
        <span class="ld-counts">${rev ? `<span class="ld-rev">${esc(rev)}</span>` : ''}${cnt.added ? `<span class="c-add">+${cnt.added}</span>` : ''}${cnt.removed ? `<span class="c-rem">−${cnt.removed}</span>` : ''}${cnt.changed ? `<span class="c-chg">~${cnt.changed}</span>` : ''}</span></summary>
      <div class="ld-army-body">${body}</div>
    </details>`;
  }

  const linkIssues = s => esc(s).replace(/#(\d+)/g, `<a href="https://github.com/${REPO}/issues/$1" target="_blank" rel="noopener">#$1</a>`);

  function sideHtml(vs, cur) {
    const rows = vs.map(v => {
      const first = v.commits[0];
      const title = st.group === 'day' ? `${v.day}` : localTime(v.date);
      const msg = st.group === 'day' ? `${v.commits.length} ${v.commits.length === 1 ? 'commit' : 'commits'}${v.partial ? '+' : ''} · ${v.commits.map(c => c.msg.split('\n')[0]).join(', ')}` : first.msg.split('\n')[0];
      return `<div class="urow vrow${cur && cur.key === v.key ? ' active' : ''}" data-logv="${esc(v.key)}">
        <span class="uname">${esc(title)}</span>
        <span class="pts">${isLoaded(v) ? '<span class="tag disp">Loaded</span>' : isNew(v) ? '<span class="tag new">New</span>' : st.group === 'day' ? '' : esc(v.head.slice(0, 7))}</span>
        <span class="usub">${esc(msg)}</span>
      </div>`;
    }).join('');
    return `<div class="list-head">
        <h1>Change Log</h1>
        <div class="meta">${esc(REPO)} · ${vs.length} ${st.group === 'day' ? 'days' : 'versions'}</div>
        <div class="tabs">
          <button class="tab${st.group !== 'day' ? ' active' : ''}" data-loggroup="commit">Per commit</button>
          <button class="tab${st.group === 'day' ? ' active' : ''}" data-loggroup="day">Per day</button>
          <button class="tab" data-logrefresh title="Check GitHub for new versions">⟳</button>
        </div>
        <div class="filters2"><select id="logArmy"><option value="">All armies</option>${Data.factions.map(f => `<option value="${esc(f.cat.id)}"${st.army === f.cat.id ? ' selected' : ''}>${esc(f.label)}${f.sub ? ' (' + esc(f.sub) + ')' : ''}</option>`).join('')}</select></div>
      </div>
      <div class="list">${rows || (st.loadingList ? '<div class="list-empty">Loading…</div>' : `<div class="list-empty">${esc(st.listErr || 'No versions')}</div>`)}
        ${st.more && vs.length ? `<div class="ld-older"><button class="btn sm" data-logolder${st.loadingList ? ' disabled' : ''}>${st.loadingList ? 'Loading…' : 'Load older versions'}</button></div>` : ''}
      </div>`;
  }

  function mainHead(vs, v) {
    const i = vs.indexOf(v);
    const older = i >= 0 && i < vs.length - 1 ? vs[i + 1] : null, newer = i > 0 ? vs[i - 1] : null;
    const title = st.group === 'day' ? v.day : localTime(v.date);
    const url = v.base ? `https://github.com/${REPO}/compare/${v.base.slice(0, 12)}...${v.head.slice(0, 12)}` : `https://github.com/${REPO}/commit/${v.head}`;
    return `<div class="ld-nav">
        <button class="btn" data-logv="${older ? esc(older.key) : ''}"${older || st.more ? '' : ' disabled'}${!older && st.more ? ' data-logolder' : ''}>← Older</button>
        <div class="ld-title"><h2>${esc(title)}</h2>
          <div class="sub">${st.group === 'day' ? `${v.commits.length} commits · ` : `${esc(v.head.slice(0, 7))} · `}${isLoaded(v) ? '<span class="tag disp">Loaded</span> · ' : isNew(v) ? '<span class="tag new">New — not loaded yet</span> · ' : ''}<a href="${esc(url)}" target="_blank" rel="noopener">GitHub</a></div></div>
        <button class="btn" data-logv="${newer ? esc(newer.key) : ''}"${newer ? '' : ' disabled'}>Newer →</button>
      </div>
      <ul class="ld-commits">${v.commits.map(c => `<li><span class="ld-ctime">${esc(st.group === 'day' ? localTime(c.date).slice(11) : c.author)}</span> ${linkIssues(c.msg.split('\n')[0])}${st.group === 'day' && c.author ? ` <span class="ld-cauth">${esc(c.author)}</span>` : ''}</li>`).join('')}</ul>`;
  }

  function mainHtml(vs, v, d) {
    let h = mainHead(vs, v);
    if (!d) {
      if (st.err) return h + `<div class="ld-msg err">${esc(st.err)} <button class="btn sm" data-logretry>Retry</button></div>`;
      return h + `<div class="ld-msg"><div class="spinner"></div><span>${esc(st.busy || 'Loading…')}</span></div>`;
    }
    if (d.initial) return h + '<div class="ld-msg">First version in the repository.</div>';
    /* the chosen army first, then the core rules, then by army name */
    const rank = f => (st.army && f.id === st.army ? 0 : f.gs ? 1 : 2);
    const files = d.files.filter(forArmy).sort((x, y) => rank(x) - rank(y) || armyLabel(x).name.localeCompare(armyLabel(y).name));
    const hidden = d.files.length - files.length;
    const tot = { added: 0, removed: 0, changed: 0 };
    for (const f of files) for (const k in tot) tot[k] += (f.counts || {})[k] || 0;
    h += `<div class="ld-summary">${files.length} ${files.length === 1 ? 'army' : 'armies'} · <span class="c-add">+${tot.added} added</span> · <span class="c-rem">−${tot.removed} removed</span> · <span class="c-chg">~${tot.changed} changed</span>
      ${files.length > 1 ? ' · <button class="linkbtn" data-logopen="1">Expand all</button> <button class="linkbtn" data-logopen="0">Collapse all</button>' : ''}</div>`;
    if (!files.length) h += `<div class="ld-msg">${d.files.length ? `No changes for ${esc(facLabel(Data.cats[st.army]))} in this version (${hidden} other ${hidden === 1 ? 'army' : 'armies'} changed).` : 'No data changes in this version.'}</div>`;
    h += files.map(f => armyHtml(f, files.length <= 3)).join('');
    if (hidden && files.length) h += `<p class="note">${hidden} other ${hidden === 1 ? 'army' : 'armies'} hidden by the filter.</p>`;
    if (d.other && d.other.length) h += `<p class="note">Other files: ${d.other.map(esc).join(', ')}</p>`;
    if (d.truncated) h += '<p class="note">GitHub lists at most 300 changed files; some may be missing.</p>';
    return h;
  }

  function render() {
    const root = el();
    const vs = versions();
    const v = findVersion(vs, st.key);
    if (!root.querySelector('.ld-side')) root.innerHTML = '<aside class="ld-side"></aside><main class="ld-main"></main>';
    const side = root.querySelector('.ld-side'), main = root.querySelector('.ld-main');
    const sideScroll = side.querySelector('.list') ? side.querySelector('.list').scrollTop : 0;
    side.innerHTML = sideHtml(vs, v);
    const list = side.querySelector('.list');
    if (list) list.scrollTop = sideScroll;
    if (!v) {
      main.innerHTML = st.listErr ? `<div class="ld-msg err">${esc(st.listErr)} <button class="btn sm" data-logrefresh>Retry</button></div>`
        : `<div class="ld-msg"><div class="spinner"></div><span>Loading versions…</span></div>`;
      return;
    }
    const key = `log:d${DIFF_V}:${v.base}..${v.head}`;
    main.innerHTML = mainHtml(vs, v, st.diffs.get(key));
  }
  function renderMainOnly() {
    const vs = versions(), v = findVersion(vs, st.key);
    const main = el().querySelector('.ld-main');
    if (v && main) main.innerHTML = mainHtml(vs, v, st.diffs.get(`log:d${DIFF_V}:${v.base}..${v.head}`));
  }

  async function showVersion() {
    const vs = versions();
    const v = findVersion(vs, st.key);
    if (!v) return;
    const tok = ++st.token;
    st.err = ''; st.busy = 'Loading…';
    render();
    const active = el().querySelector('.vrow.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
    try {
      await diffFor(v, msg => { if (tok === st.token) { st.busy = msg; renderMainOnly(); } });
    } catch (e) {
      console.warn(e);
      if (tok === st.token) st.err = e.message;
    }
    if (tok === st.token) { st.busy = null; renderMainOnly(); el().querySelector('.ld-main').scrollTop = 0; }
  }

  function go(key, replace) {
    const h = '#/log/' + encodeURIComponent(key);
    if (location.hash === h) return;
    if (replace) { history.replaceState(null, '', h); route(); } else location.hash = h;
  }

  /* ---------------------------------------------------------------- events */
  let bound = false;
  function bindOnce() {
    if (bound) return;
    bound = true;
    el().addEventListener('click', async (e) => {
      const t = e.target.closest('[data-logv], [data-loggroup], [data-logrefresh], [data-logolder], [data-logretry], [data-logopen]');
      if (!t) return;
      const d = t.dataset;
      if (d.logolder != null && (t.tagName !== 'BUTTON' || !d.logv)) {
        if (st.loadingList) return;
        st.loadingList = true; render();
        try { await loadOlder(); } catch (err) { st.listErr = err.message; }
        st.loadingList = false;
        const vs = versions(), v = findVersion(vs, st.key), i = vs.indexOf(v);
        if (d.logv === '' && v && vs[i + 1]) return go(vs[i + 1].key);
        return render();
      }
      if (d.logv) return go(d.logv);
      if (d.loggroup) {
        if (st.group === d.loggroup) return;
        const vs = versions(), v = findVersion(vs, st.key);
        st.group = d.loggroup; store.set('logGroup', st.group);
        const nv = v ? findVersion(versions(), d.loggroup === 'day' ? 'd' + localDay(v.date) : v.head) : null;
        return nv ? go(nv.key, true) : route();
      }
      if (d.logrefresh != null) {
        st.loadingList = true; st.listErr = ''; render();
        try { await loadCommits(true); } catch (err) { st.listErr = err.message; }
        st.loadingList = false;
        return route();
      }
      if (d.logretry != null) return showVersion();
      if (d.logopen != null) { for (const x of el().querySelectorAll('.ld-army')) x.open = d.logopen === '1'; }
    });
    el().addEventListener('change', (e) => {
      if (e.target.id === 'logArmy') { st.army = e.target.value; store.set('logArmy', st.army); renderMainOnly(); }
    });
    document.addEventListener('keydown', (e) => {
      if (document.body.dataset.mode !== 'log' || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const vs = versions(), i = vs.indexOf(findVersion(vs, st.key));
      const n = vs[e.key === 'ArrowLeft' ? i + 1 : i - 1];
      if (i >= 0 && n) { e.preventDefault(); go(n.key); }
    });
  }

  async function route() {
    bindOnce();
    const m = /^#\/log\/([^/]+)/.exec(location.hash);
    st.key = m ? decodeURIComponent(m[1]) : null;
    if (!st.commits || Date.now() - st.fetched >= COMMITS_TTL) {
      if (!st.commits) render();
      if (!st.loadingList) {
        st.loadingList = true; st.listErr = '';
        try { await loadCommits(false); } catch (e) { st.listErr = e.message; }
        st.loadingList = false;
      }
    }
    if (document.body.dataset.mode !== 'log') return;
    const vs = versions();
    let v = findVersion(vs, st.key);
    if (!v && st.key && /^[0-9a-f]{7,40}$/i.test(st.key) && st.more) {
      /* an older commit from a link: load older pages until it shows up */
      for (let n = 0; n < 5 && !v && st.more; n++) { try { await loadOlder(); } catch (e) { break; } v = findVersion(versions(), st.key); }
    }
    if (!v) {
      const all = versions();
      v = all.find(isLoaded) || all[0];
      if (v) return go(v.key, true);
      return render();
    }
    if (v.key !== st.key) return go(v.key, true);
    showVersion();
  }

  return { route };
})();
window.Changelog = Changelog;
