/* 40k Codex — Play (battle tracker).
   Separate mode (#/p) on top of app.js (data, stratagems) and the Army Builder rosters.
   A game is a list of events (CP, stratagem uses, VP, secondary cards); every total is replayed from them,
   so deleting an event from the log is the undo. Command phase CP comes from the position in the battle.
   Rule checks follow the Warhammer 40,000 11th Edition Core Rules and the Warhammer Event Companion
   (numbers adjustable per game in Rules):
   - Core Rules, Command phase: both players gain 1CP (Core CP).
   - Core Rules, Stratagems: a player cannot use the same Stratagem more than once in the same phase, cannot target
     the same unit with more than one Stratagem in the same phase (unless otherwise stated), cannot use one without
     enough CP; optional sections with +CP raise the cost. Restrictions in the Stratagem text: "once per battle /
     battle round / turn", "cannot use this Stratagem during the first battle round".
   - Event Companion: excluding Core CP, max 1CP per battle round (including discarding Secondary Missions);
     five battle rounds; Battle Ready 10VP; Primary max 45VP and 15VP per battle round; Secondary max 45VP and 15VP
     per battle round; max 20VP per Fixed Secondary Mission card; VP scored at the end of the battle are not subject
     to the 15VP per battle round limit.
   - Event Companion, Tactical Missions: draw two at the start of your Command phase; once per battle at the end of
     your Command phase spend 1CP to discard one and draw a new one (New Orders); achieved cards are discarded;
     at the end of your turn, discarding one or more active cards gives 1CP. Fixed Missions cannot be discarded.
   Primary Mission by Force Disposition matchup: table from gregario/warhammer-oracle (MIT),
   src/data/dispositions.ts (the Event Companion shows the matchup only as graphics). */
'use strict';

const Play = (() => {
  const KEY = 'games';
  let games = store.get(KEY, []);
  let cur = null;
  const ui = { creating: false, sp: 0, all: false, open: new Set(), msg: null, target: {}, mode: {} };

  /* games are synced with the rosters through the Army Builder's GitHub Gist (builder.js Sync) */
  const sync = () => window.Builder && Builder.sync;
  const persist = () => { store.set(KEY, games); const s = sync(); if (s) s.schedule(); };
  const save = () => { if (cur) cur.updated = Date.now(); persist(); };
  const newId = () => Math.random().toString(36).slice(2, 10);
  const el = () => $('#play');

  /* ---------- Rules ---------- */
  /* defaults: Core Rules + Warhammer Event Companion */
  const DEFAULT_RULES = {
    rounds: 5, startCp: 0, cpPerCommand: 1, extraCpCap: 1, noDupPerPhase: true, noSameTarget: true,
    primaryCap: 45, primaryRoundCap: 15, secondaryCap: 45, secondaryRoundCap: 15, fixedCardCap: 20, paintedVp: 10,
  };
  const RULE_FIELDS = [
    ['rounds', 'Battle rounds', 'num'],
    ['startCp', 'Starting CP', 'num'],
    ['cpPerCommand', 'Core CP per Command phase (both players)', 'num'],
    ['extraCpCap', 'CP per battle round excluding Core CP (0 = no limit)', 'num'],
    ['noDupPerPhase', 'The same Stratagem only once per phase', 'bool'],
    ['noSameTarget', 'The same unit only targeted by one Stratagem per phase', 'bool'],
    ['primaryCap', 'Primary Mission VP max', 'num'],
    ['primaryRoundCap', 'Primary VP max per battle round (0 = no limit)', 'num'],
    ['secondaryCap', 'Secondary Missions VP max', 'num'],
    ['secondaryRoundCap', 'Secondary VP max per battle round (0 = no limit)', 'num'],
    ['fixedCardCap', 'VP max per Fixed Mission card', 'num'],
    ['paintedVp', 'Battle Ready VP', 'num'],
  ];
  /* rules saved by the first version (50 / 40 / per turn) are dropped */
  const OLD_RULES = ['round1NoCore', 'primaryTurnCap', 'totalCap'];
  const rules = (g) => {
    const r = Object.assign({}, g.rules || {});
    for (const k of OLD_RULES) delete r[k];
    return Object.assign({}, DEFAULT_RULES, r);
  };

  /* ---------- Primary Mission by Force Disposition (gregario/warhammer-oracle, MIT) ---------- */
  const DISPOSITIONS = ['Take and Hold', 'Purge the Foe', 'Reconnaissance', 'Priority Assets', 'Disruption'];
  const MATCHUPS = [
    ['Take and Hold', 'Take and Hold', 'Battlefield Dominance', 'Battlefield Dominance'],
    ['Take and Hold', 'Purge the Foe', 'Immovable Object', 'Unstoppable Force'],
    ['Take and Hold', 'Disruption', 'Determined Acquisition', 'Death Trap'],
    ['Take and Hold', 'Priority Assets', 'Inescapable Dominion', 'Secure Asset'],
    ['Take and Hold', 'Reconnaissance', 'Purge and Secure', 'Reconnaissance Sweep'],
    ['Purge the Foe', 'Purge the Foe', 'Meatgrinder', 'Meatgrinder'],
    ['Purge the Foe', 'Disruption', 'Punishment', 'Delaying Action'],
    ['Purge the Foe', 'Reconnaissance', 'Consecrate', 'Triangulation'],
    ['Purge the Foe', 'Priority Assets', "Destroyer's Wrath", 'Vital Link'],
    ['Disruption', 'Disruption', 'Outmanoeuvre', 'Outmanoeuvre'],
    ['Disruption', 'Reconnaissance', 'Smoke and Mirrors', 'Surveil the Foe'],
    ['Disruption', 'Priority Assets', 'Locate and Deny', 'Extract Relic'],
    ['Reconnaissance', 'Reconnaissance', 'Gather Intel', 'Gather Intel'],
    ['Reconnaissance', 'Priority Assets', 'Search and Scour', 'Vanguard Operation'],
    ['Priority Assets', 'Priority Assets', 'Sabotage', 'Sabotage'],
  ];
  /* each player's mission is read from the pairing of both dispositions */
  function primaryMission(mine, theirs) {
    if (!mine || !theirs) return '';
    for (const [a, b, ma, mb] of MATCHUPS) {
      if (a === mine && b === theirs) return ma;
      if (b === mine && a === theirs) return mb;
    }
    return '';
  }
  function dispositionNames() {
    const fromData = window.forceDispositions ? [...forceDispositions().names] : [];
    const list = DISPOSITIONS.filter(d => !fromData.length || fromData.includes(d));
    return list.length ? list : DISPOSITIONS;
  }

  /* ---------- Position: round, turn (0 = player going first), phase ---------- */
  const PHASES = PHASE_ORDER;
  const PH_SHORT = { command: 'Cmd', movement: 'Move', shooting: 'Shoot', charge: 'Charge', fight: 'Fight' };
  const pos = (g) => g.pos || { r: 1, t: 0, ph: 'command' };
  const activePlayer = (g) => { const p = pos(g); return p.t === 0 ? g.first : 1 - g.first; };
  /* Command phases reached so far (each one gives CP to both players) */
  const commandPhases = (g) => { const p = pos(g); return (p.r - 1) * 2 + p.t + 1; };
  function step(g, dir) {
    const p = Object.assign({}, pos(g));
    let i = PHASES.indexOf(p.ph) + dir;
    if (i >= PHASES.length) { i = 0; if (p.t === 0) p.t = 1; else { p.t = 0; p.r++; } }
    if (i < 0) { i = PHASES.length - 1; if (p.t === 1) p.t = 0; else { p.t = 1; p.r--; } }
    if (p.r < 1) return false;
    if (p.r > rules(g).rounds) { g.done = true; return true; }
    p.ph = PHASES[i];
    g.pos = p; g.done = false;
    return true;
  }

  /* ---------- Players ---------- */
  const rosterList = () => store.get('rosters', []);
  const facOfP = (pl) => Data.cats[pl.fac] || null;
  function detName(pl, id) {
    const fac = facOfP(pl);
    if (!fac) return null;
    const d = factionDetachments(fac).find(x => x.e.id === id);
    return d ? d.e.name : null;
  }
  const detNames = (pl) => arr(pl.dets).map(id => detName(pl, id)).filter(Boolean);
  const pname = (g, i) => (g.players[i].name || '').trim() || (i === 0 ? 'Player 1' : 'Player 2');
  function newPlayer(name) { return { name, roster: null, fac: null, dets: [], disp: '', cpTax: 0, fixed: ['', ''] }; }
  function applyRoster(pl, rid) {
    const r = rosterList().find(x => x.id === rid);
    pl.roster = r ? r.id : null;
    if (r) { pl.fac = r.fac; pl.dets = arr(r.dets).slice(); if (!pl.name || /^Player \d$/.test(pl.name)) pl.name = r.name; }
  }

  /* ---------- Stratagems available to a player ---------- */
  function coreList() {
    const S = window.STRATDATA;
    const core = S && S.factions && (S.factions.Core || Object.values(S.factions).find(f => /^core/i.test(f.name)));
    if (!core) return [];
    const d = core.detachments || {};
    /* the 11e Core Stratagems and the mission pack ones (New Orders); Boarding Actions / Core Abilities are other sets */
    return arr(d['(none)']).filter(s => s.group === 'CORE').concat(arr(d['Mission Pack']));
  }
  function playerStrats(pl) {
    const fac = facOfP(pl);
    const out = [];
    if (fac) for (const n of detNames(pl)) for (const s of stratForDetachment(fac, n)) out.push({ s, src: n });
    for (const s of coreList()) out.push({ s, src: 'Core', core: true });
    return out;
  }
  const sKey = (s) => s.id || keyName(s.name);
  const isNewOrders = (s) => keyName(s.name) === 'neworders';
  /* "once per battle / battle round / turn" for the Stratagem itself; limits on the same unit / model are only noted */
  const limitCache = new WeakMap();
  function stratLimit(s) {
    if (limitCache.has(s)) return limitCache.get(s);
    const d = document.createElement('div');
    d.innerHTML = [s.restrictions, s.when, s.effect].map(x => String(x || '')).join(' \n ');
    const text = d.textContent.replace(/\s+/g, ' ').toLowerCase();
    const out = { scope: null, target: '', notFirstRound: /cannot use this stratagem (during|in) the first battle round/.test(text) };
    /* Event Companion: New Orders (discard and draw a Secondary Mission for 1CP) is once per battle */
    if (isNewOrders(s)) out.scope = 'battle';
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sen of sentences) {
      const m = /once per (battle round|battle|turn|phase)\b/.exec(sen);
      if (!m) continue;
      const aboutTarget = /\bsame\b|\btarget(ed)?\b.*\bmore than once\b|\bmodel\b.*\bmore than once\b/.test(sen) && !/^once per/.test(sen.trim());
      const aboutStrat = /stratagem/.test(sen) || /^once per/.test(sen.trim()) || sen === sentences[0] && s.restrictions && sen.includes(String(s.restrictions).toLowerCase().slice(0, 10));
      if (aboutTarget) { out.target = out.target || sen.trim(); continue; }
      if (!aboutStrat) continue;
      const sc = m[1] === 'battle round' ? 'round' : m[1];
      const rank = { phase: 0, turn: 1, round: 2, battle: 3 };
      if (!out.scope || rank[sc] > rank[out.scope]) out.scope = sc;
    }
    limitCache.set(s, out);
    return out;
  }
  const SCOPE_LABEL = { battle: 'Once per battle', round: 'Once per battle round', turn: 'Once per turn', phase: 'Once per phase' };

  /* ---------- Replay ---------- */
  function replay(g) {
    const R = rules(g);
    const st = [0, 1].map(() => ({
      cpGain: 0, cpCmd: 0, cpExtra: 0, cpSpent: 0, cp: 0,
      vp: { primary: 0, secondary: 0, painted: 0 }, total: 0, cards: [], uses: [],
    }));
    for (const i of [0, 1]) { st[i].cpCmd = R.cpPerCommand * commandPhases(g); }
    for (const e of arr(g.log)) {
      const s = st[e.p];
      if (!s) continue;
      if (e.k === 'cp') { if (e.n > 0) s.cpExtra += e.n; else s.cpSpent += -e.n; }
      if (e.k === 'strat') { s.cpSpent += e.cost; s.uses.push(e); }
      if (e.k === 'vp') {
        s.vp[e.cat] += e.n;
        if (e.card) { const c = s.cards.find(x => x.uid === e.card); if (c) { c.vp += e.n; if (e.achieve) { c.state = 'achieved'; c.at = e; } } }
      }
      if (e.k === 'draw') s.cards.push({ uid: e.uid, name: e.name, fixed: !!e.fixed, state: 'active', vp: 0, drawn: e });
      if (e.k === 'discard') { const c = s.cards.find(x => x.uid === e.uid); if (c) { c.state = 'discarded'; c.at = e; } if (e.cp) s.cpExtra += e.cp; }
    }
    for (const s of st) {
      s.cpGain = R.startCp + s.cpCmd + s.cpExtra;
      s.cp = s.cpGain - s.cpSpent;
      s.total = s.vp.primary + s.vp.secondary + s.vp.painted;
    }
    return st;
  }
  /* events after the last battle round are "end of the battle" (VP there are not limited per battle round) */
  const evAt = (g) => {
    if (g.done) return { id: newId(), at: Date.now(), r: rules(g).rounds, t: 1, ph: 'end', end: true };
    const p = pos(g); return { id: newId(), at: Date.now(), r: p.r, t: p.t, ph: p.ph };
  };
  const sameRound = (e, p) => e.r === p.r && !e.end;
  const sameTurn = (e, p) => e.r === p.r && e.t === p.t && !e.end;
  const samePhase = (e, p) => sameTurn(e, p) && e.ph === p.ph;
  /* CP gained this battle round excluding Core CP (abilities, discarded Secondary Missions) */
  const extraThisRound = (g, p) => arr(g.log).filter(e => e.p === p && sameRound(e, pos(g)) && ((e.k === 'cp' && e.n > 0) || (e.k === 'discard' && e.cp))).reduce((a, e) => a + (e.k === 'cp' ? e.n : e.cp), 0);

  /* ---------- Roster units (Stratagem targets) ---------- */
  function rosterUnits(pl) {
    const r = pl.roster && rosterList().find(x => x.id === pl.roster);
    const fac = facOfP(pl);
    if (!r || !fac) return [];
    const pool = factionUnits(fac).units;
    const names = r.units.map(ru => { const u = pool.find(x => x.id === ru.id); return u ? u.name : ru.id; });
    return r.units.map((ru, i) => {
      const same = names.filter(n => n === names[i]).length;
      const k = names.slice(0, i + 1).filter(n => n === names[i]).length;
      return { uid: ru.uid, name: same > 1 ? `${names[i]} #${k}` : names[i] };
    });
  }

  /* ---------- Checks ---------- */
  /* why a Stratagem cannot be used now by player p ('' = it can) */
  /* opts: { target: roster unit uid, mode: index of an optional +CP section } */
  function stratCheck(g, p, s, st, opts) {
    opts = opts || {};
    const R = rules(g);
    const P = pos(g);
    if (g.done) return 'Battle finished';
    const mine = activePlayer(g) === p;
    const usage = stratUsage(s);
    const turnOk = (t) => t === 'anyTurn' || (mine ? t === 'yourTurn' : t === 'oppTurn');
    if (!usage.some(u => turnOk(u.turn) && (u.phase === 'any' || u.phase === P.ph))) return mine ? 'Not in your ' + phaseLabel(P.ph) + ' phase' : "Not in your opponent's " + phaseLabel(P.ph) + ' phase';
    const lim = stratLimit(s);
    if (lim.notFirstRound && P.r === 1) return 'Cannot be used during the first battle round';
    if (isNewOrders(s)) {
      if (g.sec === 'fixed') return 'Only with Tactical Secondary Missions';
      if (!st[p].cards.some(c => c.state === 'active' && !c.fixed)) return 'No active Secondary Mission card';
    }
    const uses = st[p].uses.filter(e => e.sid === sKey(s));
    if (R.noDupPerPhase && uses.some(e => samePhase(e, P))) return 'Already used this phase';
    if (lim.scope === 'battle' && uses.length) return 'Once per battle: used in round ' + uses[0].r;
    if (lim.scope === 'round' && uses.some(e => sameRound(e, P))) return 'Once per battle round: already used';
    if (lim.scope === 'turn' && uses.some(e => sameTurn(e, P))) return 'Once per turn: already used';
    if (R.noSameTarget && opts.target && st[p].uses.some(e => e.target === opts.target && samePhase(e, P))) return 'That unit was already targeted by a Stratagem this phase';
    const cost = stratCost(g, p, s, opts.mode);
    if (cost > st[p].cp) return `Not enough CP (${st[p].cp} / ${cost})`;
    return '';
  }
  /* sections with an additional CP cost (e.g. Heroic Intervention: Into the Fray +1CP) */
  const costModes = (s) => arr(s.modes).map((m, i) => ({ i, name: m.name, plus: Number(m.cpModifier) || 0 })).filter(m => m.plus);
  function stratCost(g, p, s, mode) {
    if (s.noCp) return 0;
    const base = Number(s.cp) || 0;
    const m = mode != null && mode !== '' ? costModes(s).find(x => x.i === Number(mode)) : null;
    /* opponent units that make Stratagems cost more (asked in the setup) */
    return base + (m ? m.plus : 0) + (Number(g.players[p].cpTax) || 0);
  }
  /* VP that can still be scored in this category (excess above the maximums is lost) */
  function vpRoom(g, p, cat, cardUid, st) {
    const R = rules(g);
    const s = st[p];
    const P = pos(g);
    const caps = [];
    /* per battle round limit; VP scored at the end of the battle are not subject to it */
    const roundSum = (c) => arr(g.log).filter(e => e.k === 'vp' && e.p === p && e.cat === c && sameRound(e, P)).reduce((a, e) => a + e.n, 0);
    if (cat === 'primary') {
      caps.push([R.primaryCap - s.vp.primary, `${R.primaryCap}VP Primary`]);
      if (R.primaryRoundCap > 0 && !g.done) caps.push([R.primaryRoundCap - roundSum('primary'), `${R.primaryRoundCap}VP Primary per battle round`]);
    }
    if (cat === 'secondary') {
      caps.push([R.secondaryCap - s.vp.secondary, `${R.secondaryCap}VP Secondary`]);
      if (R.secondaryRoundCap > 0 && !g.done) caps.push([R.secondaryRoundCap - roundSum('secondary'), `${R.secondaryRoundCap}VP Secondary per battle round`]);
      const c = cardUid && s.cards.find(x => x.uid === cardUid);
      if (c && c.fixed) caps.push([R.fixedCardCap - c.vp, `${R.fixedCardCap}VP per Fixed Mission card`]);
    }
    if (cat === 'painted') caps.push([R.paintedVp - s.vp.painted, `${R.paintedVp}VP Battle Ready`]);
    caps.sort((a, b) => a[0] - b[0]);
    return caps.length ? { room: Math.max(0, caps[0][0]), why: caps[0][1] } : { room: Infinity, why: '' };
  }
  const say = (text, bad) => { ui.msg = { text, bad: !!bad, at: Date.now() }; };

  /* ---------- Actions ---------- */
  function addVp(p, cat, n, card, achieve) {
    const st = replay(cur);
    n = Math.round(Number(n) || 0);
    if (n <= 0) return;
    const { room, why } = vpRoom(cur, p, cat, card, st);
    const lost = Math.max(0, n - room);
    /* a card is still achieved (and discarded) when its VP are ignored by a maximum */
    if (room <= 0 && !achieve) { say(`${pname(cur, p)}: maximum ${why} reached, VP ignored`, true); return; }
    cur.log.push(Object.assign(evAt(cur), { k: 'vp', p, cat, n: Math.min(n, room), lost, card: card || null, achieve: !!achieve }));
    say(lost ? `${pname(cur, p)}: +${n - lost} VP, ${lost} VP ignored (maximum ${why})` : `${pname(cur, p)}: +${n} ${catLabel(cat)} VP`, !!lost);
  }
  function addCp(p, n) {
    const R = rules(cur);
    if (n > 0 && R.extraCpCap > 0) {
      const got = extraThisRound(cur, p);
      if (got + n > R.extraCpCap) { say(`${pname(cur, p)}: already gained ${got}CP this battle round excluding Core CP (max ${R.extraCpCap})`, true); return; }
    }
    if (n < 0 && replay(cur)[p].cp + n < 0) { say('CP cannot go below 0', true); return; }
    cur.log.push(Object.assign(evAt(cur), { k: 'cp', p, n }));
    say(`${pname(cur, p)}: ${n > 0 ? '+' : ''}${n} CP`);
  }
  function useStrat(p, idx, opts) {
    opts = opts || {};
    const list = playerStrats(cur.players[p]);
    const item = list[idx];
    if (!item) return;
    const st = replay(cur);
    const why = stratCheck(cur, p, item.s, st, opts);
    if (why) { say(`${item.s.name}: ${why}`, true); return; }
    /* New Orders needs the Secondary Mission card it discards */
    if (isNewOrders(item.s) && !opts.card) { say('New Orders: use the "New Orders" button on the card to discard', true); return; }
    const cost = stratCost(cur, p, item.s, opts.mode);
    const target = opts.target ? rosterUnits(cur.players[p]).find(u => u.uid === opts.target) : null;
    const mode = opts.mode != null && opts.mode !== '' ? costModes(item.s).find(m => m.i === Number(opts.mode)) : null;
    cur.log.push(Object.assign(evAt(cur), { k: 'strat', p, sid: sKey(item.s), name: item.s.name, src: item.src, cost, target: target ? target.uid : null, targetName: target ? target.name : '', mode: mode ? mode.name : '' }));
    if (opts.card) cur.log.push(Object.assign(evAt(cur), { k: 'discard', p, uid: opts.card, cp: 0, why: 'New Orders' }));
    const lim = stratLimit(item.s);
    say(`${pname(cur, p)}: ${item.s.name}${mode ? ' · ' + mode.name : ''}${target ? ' → ' + target.name : ''} (−${cost} CP)${opts.card ? ' · draw a new card' : ''}${lim.target ? ' · ' + lim.target : ''}`);
  }
  function drawCard(p, name) {
    name = String(name || '').trim();
    if (!name) return;
    cur.log.push(Object.assign(evAt(cur), { k: 'draw', p, uid: newId(), name }));
    rememberCard(name);
  }
  function discardCard(p, uid) {
    const R = rules(cur);
    const P = pos(cur);
    const card = replay(cur)[p].cards.find(c => c.uid === uid);
    if (!card || card.fixed) { say('Fixed Missions cannot be discarded', true); return; }
    const mine = activePlayer(cur) === p && !cur.done;
    /* at the end of your turn: discarding one or more active cards gives 1CP (once per turn), within the CP limit */
    let cp = 0, note = '';
    if (mine) {
      const already = arr(cur.log).some(e => e.k === 'discard' && e.p === p && e.cp && sameTurn(e, P));
      const got = extraThisRound(cur, p);
      if (already) note = ' (1CP for discarding already gained this turn)';
      else if (R.extraCpCap && got >= R.extraCpCap) note = ` (no CP: max ${R.extraCpCap}CP per battle round excluding Core CP)`;
      else cp = 1;
    } else note = ' (no CP: only at the end of your own turn)';
    cur.log.push(Object.assign(evAt(cur), { k: 'discard', p, uid, cp }));
    say(`Card discarded${cp ? ' (+1 CP)' : note}`, !cp && /max/.test(note));
  }
  /* New Orders on a Secondary Mission card: the Stratagem check, then the card is discarded (no CP) */
  function newOrders(p, uid) {
    const list = playerStrats(cur.players[p]);
    const idx = list.findIndex(x => isNewOrders(x.s));
    if (idx < 0) { say('New Orders is not in the Stratagem data', true); return; }
    useStrat(p, idx, { card: uid });
  }
  const rememberCard = (name) => { const k = store.get('secNames', []); if (!k.includes(name)) { k.push(name); k.sort(); store.set('secNames', k.slice(-300)); } };
  const catLabel = (c) => ({ primary: 'Primary', secondary: 'Secondary', painted: 'Battle Ready' }[c] || c);

  function startGame(g) {
    g.started = true;
    g.pos = { r: 1, t: 0, ph: 'command' };
    g.done = false;
    g.log = arr(g.log);
    addFixedCards(g);
  }
  /* Fixed Mission cards named in the setup become cards of that player (once) */
  function addFixedCards(g) {
    if (g.sec === 'fixed') {
      for (const p of [0, 1]) for (const n of arr(g.players[p].fixed).map(x => String(x || '').trim()).filter(Boolean)) {
        if (!g.log.some(e => e.k === 'draw' && e.p === p && e.fixed && e.name === n)) g.log.push(Object.assign(evAt(g), { k: 'draw', p, uid: newId(), name: n, fixed: true }));
        rememberCard(n);
      }
    }
  }

  /* =====================================================================
     Rendering
     ===================================================================== */
  function render() {
    const root = el();
    if (!root) return;
    const mode = ui.creating || !cur ? 'new' : cur.started && !ui.setup ? 'live' : 'setup';
    root.className = 'play p-' + mode;
    let main;
    if (mode === 'new') main = renderNew();
    else if (mode === 'setup') main = renderSetup();
    else main = renderLive();
    root.innerHTML = `<aside class="p-games">${renderGameList()}</aside><main class="p-main">${main}</main>`;
  }

  function renderGameList() {
    const s = sync();
    let h = `<div class="b-head"><h2>Games</h2><span class="b-headbtns">${s ? `<button class="btn sync-btn${s.error ? ' err' : ''}" data-pa="sync" title="Sync">${esc(s.label())}</button>` : ''}<button class="btn primary" data-pa="new">＋ New</button></span></div>`;
    if (!games.length) return h + `<div class="list-empty">—</div>`;
    for (const g of [...games].sort((a, b) => (b.updated || 0) - (a.updated || 0))) {
      const st = g.started ? replay(g) : null;
      const P = pos(g);
      h += `<div class="urow${cur && cur.id === g.id ? ' active' : ''}" data-pa="open" data-pid="${esc(g.id)}">
        <span class="uname">${esc(g.name)}</span><span class="pts">${st ? `${st[0].total}–${st[1].total}` : '—'}</span>
        <span class="usub">${esc(pname(g, 0))} vs ${esc(pname(g, 1))} · ${g.done ? 'Finished' : g.started ? `R${P.r} ${esc(PH_SHORT[P.ph])}` : 'Setup'}</span></div>`;
    }
    return h;
  }

  function renderNew() {
    return `<article class="sheet"><div class="sheet-head"><div class="grow"><h2>New Game</h2></div></div>
      <div class="b-form"><label>Name<input id="pNewName" type="text" value="${esc('Game ' + new Date().toLocaleDateString())}"></label></div>
      <div class="b-actions p-gap"><button class="btn primary" data-pa="create">Create</button>${cur ? '<button class="btn" data-pa="cancel">Cancel</button>' : ''}</div></article>`;
  }

  /* ---------- Setup ---------- */
  function facOptions(sel) {
    let h = '<option value="">—</option>', grp = null;
    for (const x of Data.factions) {
      if (x.group !== grp) { if (grp) h += '</optgroup>'; grp = x.group; h += `<optgroup label="${esc(grp)}">`; }
      h += `<option value="${esc(x.cat.id)}"${sel === x.cat.id ? ' selected' : ''}>${esc(x.label)}${x.sub ? ' (' + esc(x.sub) + ')' : ''}</option>`;
    }
    return h + '</optgroup>';
  }
  function renderPlayerSetup(g, i) {
    const pl = g.players[i];
    const fac = facOfP(pl);
    const dets = fac ? factionDetachments(fac) : [];
    const rs = rosterList();
    const other = g.players[1 - i];
    const pm = primaryMission(pl.disp, other.disp);
    return `<div class="p-pset">
      <h3 class="p-h">${i === 0 ? 'Player 1' : 'Player 2'}</h3>
      <div class="b-form">
        <label>Army Roster<select data-pf="roster" data-pp="${i}"><option value="">— (choose faction below)</option>${rs.map(r => `<option value="${esc(r.id)}"${pl.roster === r.id ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
        <label>Name<input data-pf="name" data-pp="${i}" type="text" value="${esc(pl.name)}"></label>
        <label>Faction<select data-pf="fac" data-pp="${i}">${facOptions(pl.fac)}</select></label>
        ${dets.length ? `<label>Detachment<select data-pf="det" data-pp="${i}" multiple size="${Math.min(6, dets.length)}">${dets.map(({ e }) => `<option value="${esc(e.id)}"${arr(pl.dets).includes(e.id) ? ' selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>` : ''}
        <label>Force Disposition<select data-pf="disp" data-pp="${i}"><option value="">—</option>${dispositionNames().map(d => `<option${pl.disp === d ? ' selected' : ''}>${esc(d)}</option>`).join('')}</select></label>
        ${pm ? `<div class="p-pm">Primary Mission: <b>${esc(pm)}</b></div>` : ''}
        <label>Stratagem cost +CP (opponent abilities)<input data-pf="cpTax" data-pp="${i}" type="number" min="0" max="3" value="${esc(pl.cpTax || 0)}"></label>
        ${g.sec === 'fixed' ? `<label>Fixed Missions<input data-pf="fixed0" data-pp="${i}" list="pSecNames" value="${esc(arr(pl.fixed)[0] || '')}"><input data-pf="fixed1" data-pp="${i}" list="pSecNames" value="${esc(arr(pl.fixed)[1] || '')}"></label>` : ''}
      </div></div>`;
  }
  function renderRules(g) {
    const R = rules(g);
    return `<details class="fold p-rules"><summary><span class="fname">Rules</span><span class="fval">checks</span></summary><div class="fbody"><div class="p-rulegrid">${RULE_FIELDS.map(([k, label, type]) => type === 'bool'
      ? `<label class="chk"><input type="checkbox" data-pr="${k}"${R[k] ? ' checked' : ''}> ${esc(label)}</label>`
      : `<label>${esc(label)}<input type="number" min="0" data-pr="${k}" value="${esc(R[k])}"></label>`).join('')}</div>
      <p class="note">Defaults follow the 11th Edition Core Rules (1CP for both players in each Command phase; the same Stratagem
      and the same target once per phase) and the Warhammer Event Companion (max 1CP per battle round excluding Core CP; five battle
      rounds; Primary and Secondary 45VP each, up to 15VP per battle round; 20VP per Fixed Mission card; Battle Ready 10VP).</p>
      <div class="b-actions"><button class="btn sm" data-pa="rulesreset">Defaults</button></div></div></details>`;
  }
  function renderSetup() {
    const g = cur;
    return `<article class="sheet p-setup">
      <div class="sheet-head"><div class="grow"><input class="b-name" data-pg="name" value="${esc(g.name)}" aria-label="Name"><div class="sub">Setup</div></div>
        <div class="sheet-actions">${g.started ? '<button class="btn primary" data-pa="resume">▶ Back to battle</button><button class="btn" data-pa="restart">Restart</button>' : '<button class="btn primary" data-pa="start">▶ Start battle</button>'}
        <button class="btn danger" data-pa="delete">Delete</button></div></div>
      <div class="p-setgrid">${renderPlayerSetup(g, 0)}${renderPlayerSetup(g, 1)}</div>
      <div class="b-config p-gap">
        <label>First turn<select data-pg="first"><option value="0"${g.first === 0 ? ' selected' : ''}>${esc(pname(g, 0))}</option><option value="1"${g.first === 1 ? ' selected' : ''}>${esc(pname(g, 1))}</option></select></label>
        <label>Secondary Missions<select data-pg="sec"><option value="tactical"${g.sec === 'tactical' ? ' selected' : ''}>Tactical</option><option value="fixed"${g.sec === 'fixed' ? ' selected' : ''}>Fixed</option></select></label>
      </div>
      ${renderRules(g)}
      ${secNamesList()}
    </article>`;
  }
  const secNamesList = () => `<datalist id="pSecNames">${store.get('secNames', []).map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;

  /* ---------- Live ---------- */
  function renderLive() {
    const g = cur;
    const R = rules(g);
    const P = pos(g);
    const st = replay(g);
    const ap = activePlayer(g);
    const msg = ui.msg && Date.now() - ui.msg.at < 15000 ? ui.msg : null;
    let h = `<div class="p-bar">
      <div class="p-title"><b>${esc(g.name)}</b><span class="sub">${g.done ? 'Battle finished' : `Battle round ${P.r} / ${R.rounds} · ${esc(pname(g, ap))}'s turn`}</span></div>
      <div class="p-pos">
        <button class="btn" data-pa="prev" title="Previous phase">◀</button>
        <div class="chips p-phases">${PHASES.map(ph => `<button class="chip${!g.done && ph === P.ph ? ' on' : ''}" data-pa="phase" data-pv="${ph}">${esc(phaseLabel(ph))}</button>`).join('')}</div>
        <button class="btn primary" data-pa="next">${g.done ? 'Finished' : 'Next ▶'}</button>
      </div>
      <button class="btn sm" data-pa="setup">⚙ Setup</button>
    </div>
    ${msg ? `<div class="p-msg${msg.bad ? ' bad' : ''}">${esc(msg.text)}</div>` : ''}
    ${commandReminder(g, st)}
    <div class="p-players">${[0, 1].map(i => renderPlayerCard(g, i, st)).join('')}</div>
    ${renderStratPanel(g, st)}
    <div class="p-tables">${renderRoundTable(g)}${renderPhaseTable(g)}</div>
    ${renderLog(g)}
    ${secNamesList()}`;
    return h;
  }
  function commandReminder(g, st) {
    const P = pos(g);
    if (g.done) return `<div class="p-remind"><span>End of the battle: VP scored now are not subject to the per battle round limits.</span></div>`;
    const ap = activePlayer(g);
    const items = [];
    if (P.ph === 'command') {
      items.push(`Both players gain ${rules(g).cpPerCommand}CP (Core CP).`);
      if (g.sec !== 'fixed') {
        const drawn = arr(g.log).filter(e => e.k === 'draw' && e.p === ap && !e.fixed && sameTurn(e, P) && e.ph === 'command').length;
        items.push(`${pname(g, ap)}: draw two Secondary Mission cards (${Math.min(drawn, 2)} / 2 drawn).`);
        items.push('End of the Command phase: New Orders (once per battle, 1CP).');
      }
      items.push('Battle-shock rolls.');
    }
    if (P.ph === 'fight' && g.sec !== 'fixed') items.push(`End of the turn: score achieved Secondary Missions, then ${pname(g, ap)} can discard active cards for 1CP.`);
    if (!items.length) return '';
    return `<div class="p-remind">${items.map(x => `<span>${esc(x)}</span>`).join('')}</div>`;
  }

  const meter = (label, val, max) => {
    const pct = max ? Math.min(100, Math.round(val / max * 100)) : 0;
    return `<div class="b-meter${max && val >= max ? ' full' : ''}"><div class="b-meter-top"><span>${esc(label)}</span><span>${val}${max ? ' / ' + max : ''}</span></div><div class="b-track"><div class="b-fill" style="width:${pct}%"></div></div></div>`;
  };
  function renderPlayerCard(g, i, st) {
    const R = rules(g);
    const pl = g.players[i];
    const s = st[i];
    const fac = facOfP(pl);
    const ap = activePlayer(g);
    const pm = primaryMission(pl.disp, g.players[1 - i].disp);
    const extra = extraThisRound(g, i);
    let h = `<section class="p-card${ap === i && !g.done ? ' active' : ''}">
      <div class="p-cardhead"><div><h3>${esc(pname(g, i))}${ap === i && !g.done ? ' <span class="tag disp">Turn</span>' : ''}</h3>
        <div class="sub">${esc(fac ? facLabel(fac) : '—')}${detNames(pl).length ? ' · ' + esc(detNames(pl).join(', ')) : ''}</div>
        ${pm ? `<div class="sub">Primary: <b>${esc(pm)}</b> <span class="g">(${esc(pl.disp)})</span></div>` : ''}</div>
        <div class="p-vptotal"><span class="v">${s.total}</span><span class="l">VP</span></div></div>
      <div class="p-cp">
        <div class="p-cpv"><span class="v">${s.cp}</span><span class="l">CP</span></div>
        <div class="p-cpd">Gained ${s.cpGain} <span class="g">(start ${R.startCp} + Core ${s.cpCmd} + other ${s.cpExtra})</span><br>Spent ${s.cpSpent}${R.extraCpCap ? ` · other CP this round ${extra} / ${R.extraCpCap}` : ''}</div>
        <div class="p-cpb"><button class="btn sm" data-pa="cp" data-pp="${i}" data-pv="1" title="CP from an ability (counts towards the limit per battle round)">＋1</button><button class="btn sm" data-pa="cp" data-pp="${i}" data-pv="-1" title="Spend CP without a Stratagem">−1</button></div>
      </div>
      <div class="b-meters p-meters">${meter('Primary', s.vp.primary, R.primaryCap)}${meter('Secondary', s.vp.secondary, R.secondaryCap)}</div>
      ${!g.done && (R.primaryRoundCap || R.secondaryRoundCap) ? `<div class="p-roundcap g">This battle round: Primary ${roundVp(g, i, 'primary')}${R.primaryRoundCap ? ' / ' + R.primaryRoundCap : ''} · Secondary ${roundVp(g, i, 'secondary')}${R.secondaryRoundCap ? ' / ' + R.secondaryRoundCap : ''}</div>` : ''}
      <div class="p-vpadd">
        <span class="p-lab">Primary VP</span>
        ${[1, 2, 3, 4, 5].map(n => `<button class="btn sm" data-pa="vp" data-pp="${i}" data-pv="${n}">+${n}</button>`).join('')}
        <input type="number" min="1" class="p-num" id="pVp${i}" placeholder="VP"><button class="btn sm" data-pa="vpn" data-pp="${i}">Add</button>
        <label class="chk p-painted"><input type="checkbox" data-pa="painted" data-pp="${i}"${s.vp.painted ? ' checked' : ''}> Battle Ready (${R.paintedVp})</label>
      </div>
      ${renderCards(g, i, s)}
    </section>`;
    return h;
  }
  const roundVp = (g, p, cat) => arr(g.log).filter(e => e.k === 'vp' && e.p === p && e.cat === cat && sameRound(e, pos(g))).reduce((a, e) => a + e.n, 0);
  function renderCards(g, i, s) {
    const R = rules(g);
    const active = s.cards.filter(c => c.state === 'active');
    const done = s.cards.filter(c => c.state !== 'active');
    const tactical = g.sec !== 'fixed';
    const P = pos(g);
    /* New Orders: end of your Command phase, once per battle */
    const strats = playerStrats(g.players[i]);
    const noIdx = strats.findIndex(x => isNewOrders(x.s));
    const noWhy = noIdx < 0 ? 'not in the Stratagem data' : stratCheck(g, i, strats[noIdx].s, replay(g));
    const showNo = tactical && !g.done && activePlayer(g) === i && P.ph === 'command';
    let h = `<div class="p-secs"><div class="p-lab">${tactical ? 'Tactical' : 'Fixed'} Secondary Missions · ${active.length} active</div>`;
    for (const c of active) {
      h += `<div class="p-secrow"><span class="p-secname">${esc(c.name)}</span>
        <span class="pts">${c.vp}${c.fixed ? ' / ' + R.fixedCardCap : ''} VP</span>
        <input type="number" min="1" class="p-num" id="pSec${esc(c.uid)}" placeholder="VP">
        <button class="btn sm" data-pa="secvp" data-pp="${i}" data-pv="${esc(c.uid)}" title="${c.fixed ? 'Score VP (Fixed Missions stay active)' : 'Score VP; the card is achieved and discarded'}">${c.fixed ? 'Score' : 'Achieved'}</button>
        ${c.fixed ? '' : `<button class="btn sm" data-pa="discard" data-pp="${i}" data-pv="${esc(c.uid)}" title="End of your turn: discarding one or more active cards gives 1CP">Discard</button>`}
        ${showNo && !c.fixed ? `<button class="btn sm" data-pa="neworders" data-pp="${i}" data-pv="${esc(c.uid)}"${noWhy ? ` disabled title="New Orders: ${esc(noWhy)}"` : ' title="New Orders (1CP): discard this card and draw a new one"'}>New Orders</button>` : ''}</div>`;
    }
    if (tactical) {
      h += `<div class="p-secrow p-draw"><input class="p-secin" id="pDraw${i}" list="pSecNames" placeholder="Card drawn…"><button class="btn sm" data-pa="draw" data-pp="${i}">Draw</button></div>`;
    }
    if (done.length) h += `<div class="p-secdone">${done.map(c => `<span class="tag${c.state === 'achieved' ? ' disp' : ''}" title="Round ${c.at ? c.at.r : '?'}">${esc(c.name)} · ${c.state === 'achieved' ? c.vp + ' VP' : 'discarded'}</span>`).join('')}</div>`;
    return h + `</div>`;
  }

  function renderStratPanel(g, st) {
    const p = ui.sp;
    const pl = g.players[p];
    const list = playerStrats(pl);
    const ap = activePlayer(g);
    const units = rosterUnits(pl);
    const target = units.some(u => u.uid === ui.target[p]) ? ui.target[p] : '';
    /* units already targeted by a Stratagem in this phase */
    const P = pos(g);
    const targeted = new Set(st[p].uses.filter(e => e.target && samePhase(e, P)).map(e => e.target));
    let rows = '';
    const groups = new Map();
    list.forEach((it, idx) => { if (!groups.has(it.src)) groups.set(it.src, []); groups.get(it.src).push({ it, idx }); });
    for (const [src, items] of groups) {
      let sec = '';
      for (const { it, idx } of items) {
        const key = p + ':' + idx;
        const modes = costModes(it.s);
        const mode = ui.mode[key] != null ? ui.mode[key] : '';
        const why = stratCheck(g, p, it.s, st, { target, mode });
        const timingBad = /^Not in/.test(why);
        if (!ui.all && timingBad) continue;
        const lim = stratLimit(it.s);
        const used = st[p].uses.filter(e => e.sid === sKey(it.s)).length;
        const cost = stratCost(g, p, it.s, mode);
        const tags = usageTags(it.s).map(gr => `<span class="usegrp">${gr.map(([c, l]) => `<span class="use ${c}">${esc(l)}</span>`).join('')}</span>`).join('');
        sec += `<details class="fold strat p-strat${why ? ' off' : ''}" data-pk="${esc(key)}"${ui.open.has(key) ? ' open' : ''}><summary>
          <span class="fname">${esc(it.s.name)}</span>
          <span class="sright"><span class="uses">${tags}</span>
            ${lim.scope ? `<span class="tag">${esc(SCOPE_LABEL[lim.scope])}</span>` : ''}
            ${lim.notFirstRound ? '<span class="tag">Not in round 1</span>' : ''}
            ${used ? `<span class="tag">used ×${used}</span>` : ''}
            ${modes.length ? `<select class="p-mode" data-pmode="${esc(key)}" title="Optional section with an additional CP cost"><option value="">Base</option>${modes.map(m => `<option value="${m.i}"${String(mode) === String(m.i) ? ' selected' : ''}>${esc(m.name)} +${m.plus}CP</option>`).join('')}</select>` : ''}
            <span class="fval">${cost} CP</span>
            <button class="btn sm${why ? '' : ' primary'}" data-pa="use" data-pp="${p}" data-pv="${idx}"${why ? ` disabled title="${esc(why)}"` : ''}>Use</button></span>
          ${why ? `<span class="p-why">${esc(why)}</span>` : ''}
        </summary><div class="fbody">${stratBody(it.s)}${lim.target ? `<div class="note">Limit: ${esc(lim.target)}</div>` : ''}</div></details>`;
      }
      if (sec) rows += `<div class="stratsec"><h5 class="b-sh">${esc(src)}</h5>${sec}</div>`;
    }
    return `<section class="p-strats">
      <div class="p-strathead"><h3 class="p-h">Stratagems</h3>
        <div class="chips">${[0, 1].map(i => `<button class="chip${p === i ? ' on' : ''}" data-pa="sp" data-pv="${i}">${esc(pname(g, i))} · ${st[i].cp} CP${ap === i ? ' (turn)' : ''}</button>`).join('')}</div>
        ${units.length ? `<label class="p-target">Target<select data-ptarget="${p}"><option value="">— (not tracked)</option>${units.map(u => `<option value="${esc(u.uid)}"${target === u.uid ? ' selected' : ''}>${esc(u.name)}${targeted.has(u.uid) ? ' (targeted this phase)' : ''}</option>`).join('')}</select></label>` : ''}
        <label class="chk"><input type="checkbox" data-pa="allstrats"${ui.all ? ' checked' : ''}> Show all phases</label></div>
      ${units.length ? '' : '<p class="note">Choose an Army Roster in Setup to track Stratagem targets (one Stratagem per unit per phase).</p>'}
      ${rows || `<div class="list-empty">${list.length ? 'No Stratagems for this phase' : 'No Stratagems (choose a faction and detachment in Setup)'}</div>`}
    </section>`;
  }

  /* VP per battle round and per phase (when the VP were recorded) */
  function vpEvents(g) { return arr(g.log).filter(e => e.k === 'vp'); }
  function renderRoundTable(g) {
    const R = rules(g);
    const ev = vpEvents(g);
    const sum = (f) => ev.filter(f).reduce((a, e) => a + e.n, 0);
    let h = `<div class="p-table"><h3 class="p-h">VP per battle round</h3><table class="p-tbl"><thead><tr><th>Round</th>${[0, 1].map(i => `<th colspan="3">${esc(pname(g, i))}</th>`).join('')}</tr>
      <tr><th></th>${[0, 1].map(() => '<th>P</th><th>S</th><th>Σ</th>').join('')}</tr></thead><tbody>`;
    for (let r = 1; r <= R.rounds; r++) {
      h += `<tr${pos(g).r === r && !g.done ? ' class="on"' : ''}><td>${r}</td>${[0, 1].map(i => {
        const a = sum(e => e.p === i && e.r === r && !e.end && e.cat === 'primary');
        const b = sum(e => e.p === i && e.r === r && !e.end && e.cat === 'secondary');
        return `<td>${a || ''}</td><td>${b || ''}</td><td><b>${a + b || ''}</b></td>`;
      }).join('')}</tr>`;
    }
    const endRow = [0, 1].map(i => [sum(e => e.p === i && e.end && e.cat === 'primary'), sum(e => e.p === i && e.end && e.cat === 'secondary')]);
    if (g.done || endRow.some(x => x[0] || x[1])) h += `<tr${g.done ? ' class="on"' : ''}><td>End</td>${endRow.map(([a, b]) => `<td>${a || ''}</td><td>${b || ''}</td><td><b>${a + b || ''}</b></td>`).join('')}</tr>`;
    const tot = (i, c) => sum(e => e.p === i && e.cat === c);
    h += `<tr class="tot"><td>Σ</td>${[0, 1].map(i => `<td>${tot(i, 'primary')}</td><td>${tot(i, 'secondary')}</td><td><b>${tot(i, 'primary') + tot(i, 'secondary') + tot(i, 'painted')}</b></td>`).join('')}</tr>`;
    return h + `</tbody></table><p class="note">Σ includes Battle Ready VP.</p></div>`;
  }
  function renderPhaseTable(g) {
    const ev = vpEvents(g).filter(e => e.cat !== 'painted');
    const cpEv = arr(g.log).filter(e => e.k === 'strat');
    let h = `<div class="p-table"><h3 class="p-h">Per phase</h3><table class="p-tbl"><thead><tr><th>Phase</th>${[0, 1].map(i => `<th colspan="2">${esc(pname(g, i))}</th>`).join('')}</tr>
      <tr><th></th>${[0, 1].map(() => '<th>VP</th><th>CP spent</th>').join('')}</tr></thead><tbody>`;
    const phs = PHASES.concat(ev.some(e => e.end) ? ['end'] : []);
    for (const ph of phs) {
      h += `<tr><td>${ph === 'end' ? 'End of the battle' : esc(phaseLabel(ph))}</td>${[0, 1].map(i => {
        const vp = ev.filter(e => e.p === i && e.ph === ph).reduce((a, e) => a + e.n, 0);
        const cp = cpEv.filter(e => e.p === i && e.ph === ph).reduce((a, e) => a + e.cost, 0);
        return `<td>${vp || ''}</td><td>${cp || ''}</td>`;
      }).join('')}</tr>`;
    }
    return h + `</tbody></table></div>`;
  }
  function renderLog(g) {
    const log = arr(g.log);
    if (!log.length) return '';
    const text = (e) => {
      if (e.k === 'cp') return `${e.n > 0 ? '+' : ''}${e.n} CP`;
      if (e.k === 'strat') return `${e.name}${e.mode ? ' · ' + e.mode : ''}${e.targetName ? ' → ' + e.targetName : ''} (−${e.cost} CP)`;
      if (e.k === 'vp') return `+${e.n} ${catLabel(e.cat)} VP${e.card ? ' · ' + cardName(g, e.p, e.card) : ''}${e.lost ? ` (${e.lost} ignored)` : ''}`;
      if (e.k === 'draw') return `${e.fixed ? 'Fixed' : 'Drew'}: ${e.name}`;
      if (e.k === 'discard') return `Discarded ${cardName(g, e.p, e.uid)}${e.why ? ' (' + e.why + ')' : ''}${e.cp ? ' (+1 CP)' : ''}`;
      return e.k;
    };
    return `<details class="fold p-log"${log.length < 30 ? ' open' : ''}><summary><span class="fname">Log</span><span class="fval">${log.length}</span></summary><div class="fbody">
      ${[...log].reverse().map(e => `<div class="p-logrow"><span class="g">R${e.r} ${esc(PH_SHORT[e.ph] || e.ph)}</span><span>${esc(pname(g, e.p))}</span><span class="grow">${esc(text(e))}</span>
        <button class="icon-btn sm" data-pa="undo" data-pv="${esc(e.id)}" title="Remove (undo)">✕</button></div>`).join('')}</div></details>`;
  }
  const cardName = (g, p, uid) => { const e = arr(g.log).find(x => x.k === 'draw' && x.uid === uid); return e ? e.name : '?'; };

  /* =====================================================================
     Events
     ===================================================================== */
  function go(id) { location.hash = id ? '#/p/g/' + encodeURIComponent(id) : '#/p'; }
  const after = () => { save(); render(); };

  function onClick(e) {
    const t = e.target.closest('[data-pa]');
    if (!t || !el().contains(t)) return;
    const a = t.dataset.pa;
    const p = t.dataset.pp != null ? Number(t.dataset.pp) : null;
    const v = t.dataset.pv;
    if (t.tagName === 'INPUT' && t.type === 'checkbox') return; /* handled on change */
    if (a === 'sync') { if (window.Builder) Builder.openSync(); return; }
    if (a === 'new') { ui.creating = true; render(); return; }
    if (a === 'cancel') { ui.creating = false; render(); return; }
    if (a === 'open') { ui.creating = false; go(t.dataset.pid); return; }
    if (a === 'create') {
      const name = (($('#pNewName') || {}).value || '').trim() || 'Game';
      const rs = rosterList().sort((x, y) => (y.updated || 0) - (x.updated || 0));
      const g = { id: newId(), name, created: Date.now(), updated: Date.now(), players: [newPlayer('Player 1'), newPlayer('Player 2')], first: 0, sec: 'tactical', rules: {}, log: [], started: false };
      if (rs[0]) applyRoster(g.players[0], rs[0].id);
      games.push(g); ui.creating = false; persist(); go(g.id); return;
    }
    if (!cur) return;
    if (a === 'start') { startGame(cur); ui.setup = false; ui.sp = activePlayer(cur); after(); return; }
    if (a === 'resume') { addFixedCards(cur); ui.setup = false; after(); return; }
    if (a === 'setup') { ui.setup = true; render(); return; }
    if (a === 'restart') { if (!confirm('Clear the log and start again from round 1?')) return; cur.log = []; startGame(cur); ui.setup = false; after(); return; }
    if (a === 'delete') {
      if (!confirm(`Delete "${cur.name}"?`)) return;
      const del = store.get('gameDeleted', {}); del[cur.id] = Date.now(); store.set('gameDeleted', del);
      games = games.filter(x => x.id !== cur.id); persist(); cur = null; go(null); return;
    }
    if (a === 'rulesreset') { cur.rules = {}; after(); return; }
    if (a === 'next' || a === 'prev') {
      if (a === 'next' && cur.done) return;
      if (a === 'prev' && cur.done) { cur.done = false; after(); return; }
      const before = activePlayer(cur);
      if (step(cur, a === 'next' ? 1 : -1)) { if (activePlayer(cur) !== before) ui.sp = activePlayer(cur); ui.msg = null; }
      after(); return;
    }
    if (a === 'phase') { cur.pos = Object.assign({}, pos(cur), { ph: v }); cur.done = false; after(); return; }
    if (a === 'cp') { addCp(p, Number(v)); after(); return; }
    if (a === 'vp') { addVp(p, 'primary', Number(v)); after(); return; }
    if (a === 'vpn') { const inp = $('#pVp' + p); addVp(p, 'primary', inp && inp.value); after(); return; }
    if (a === 'secvp') {
      const inp = $('#pSec' + v);
      const n = Number(inp && inp.value);
      const card = replay(cur)[p].cards.find(c => c.uid === v);
      if (!n || n <= 0) { say('Enter the VP for that card', true); render(); return; }
      addVp(p, 'secondary', n, v, card && !card.fixed);
      after(); return;
    }
    if (a === 'discard') { discardCard(p, v); after(); return; }
    if (a === 'neworders') { newOrders(p, v); after(); return; }
    if (a === 'draw') { const inp = $('#pDraw' + p); drawCard(p, inp && inp.value); after(); return; }
    if (a === 'use') {
      e.preventDefault();
      const key = p + ':' + v;
      const units = rosterUnits(cur.players[p]);
      useStrat(p, Number(v), { target: units.some(u => u.uid === ui.target[p]) ? ui.target[p] : '', mode: ui.mode[key] != null ? ui.mode[key] : '' });
      after(); return;
    }
    if (a === 'sp') { ui.sp = Number(v); render(); return; }
    if (a === 'undo') { cur.log = arr(cur.log).filter(x => x.id !== v); say('Removed from the log'); after(); return; }
  }

  function onChange(e) {
    const t = e.target;
    if (!el().contains(t) || !cur) return;
    if (t.dataset.pa === 'allstrats') { ui.all = t.checked; render(); return; }
    if (t.dataset.ptarget != null) { ui.target[Number(t.dataset.ptarget)] = t.value; render(); return; }
    if (t.dataset.pmode != null) { ui.mode[t.dataset.pmode] = t.value; render(); return; }
    if (t.dataset.pa === 'painted') {
      const p = Number(t.dataset.pp);
      if (t.checked) addVp(p, 'painted', rules(cur).paintedVp);
      else cur.log = arr(cur.log).filter(x => !(x.k === 'vp' && x.p === p && x.cat === 'painted'));
      after(); return;
    }
    if (t.dataset.pr) {
      cur.rules = Object.assign({}, cur.rules || {});
      cur.rules[t.dataset.pr] = t.type === 'checkbox' ? t.checked : Math.max(0, Number(t.value) || 0);
      if (t.dataset.pr === 'rounds') cur.rules.rounds = Math.max(1, cur.rules.rounds);
      after(); return;
    }
    if (t.dataset.pg) {
      const k = t.dataset.pg;
      if (k === 'name') cur.name = t.value.trim() || cur.name;
      if (k === 'first') cur.first = Number(t.value);
      if (k === 'sec') cur.sec = t.value;
      after(); return;
    }
    if (t.dataset.pf) {
      const pl = cur.players[Number(t.dataset.pp)];
      const k = t.dataset.pf;
      if (k === 'roster') { if (t.value) applyRoster(pl, t.value); else pl.roster = null; }
      if (k === 'name') pl.name = t.value;
      if (k === 'fac') { pl.fac = t.value || null; pl.dets = []; pl.roster = null; }
      if (k === 'det') { pl.dets = [...t.selectedOptions].map(o => o.value); pl.roster = null; }
      if (k === 'disp') pl.disp = t.value;
      if (k === 'cpTax') pl.cpTax = Math.max(0, Number(t.value) || 0);
      if (k === 'fixed0' || k === 'fixed1') { pl.fixed = arr(pl.fixed).slice(); pl.fixed[k === 'fixed0' ? 0 : 1] = t.value; }
      after(); return;
    }
  }
  /* remember which Stratagems are open across re-renders */
  function onToggle(e) {
    const d = e.target;
    if (!d.dataset || !d.dataset.pk || !el().contains(d)) return;
    if (d.open) ui.open.add(d.dataset.pk); else ui.open.delete(d.dataset.pk);
  }
  function onKey(e) {
    if (e.key !== 'Enter' || !el().contains(e.target)) return;
    const id = e.target.id || '';
    const btn = id.startsWith('pDraw') ? e.target.nextElementSibling : id.startsWith('pVp') || id.startsWith('pSec') ? e.target.nextElementSibling : null;
    if (btn && btn.dataset.pa) { e.preventDefault(); btn.click(); }
  }

  let bound = false;
  function bindOnce() {
    if (bound) return;
    bound = true;
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('toggle', onToggle, true);
    document.addEventListener('keydown', onKey);
  }

  function route() {
    bindOnce();
    games = store.get(KEY, []);
    const m = /^#\/p\/g\/([^/]+)/.exec(location.hash);
    const next = m ? games.find(g => g.id === decodeURIComponent(m[1])) || null : null;
    if (!cur || !next || cur.id !== next.id) { ui.setup = false; ui.open.clear(); ui.msg = null; if (next) ui.sp = activePlayer(next); }
    cur = next;
    if (!cur && !m && games.length && !ui.creating) {
      const last = [...games].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
      history.replaceState(null, '', '#/p/g/' + encodeURIComponent(last.id));
      cur = last;
    }
    if (!cur && !games.length) ui.creating = true;
    if (cur && ui.sp == null) ui.sp = activePlayer(cur);
    render();
    const s = sync();
    if (s && s.on() && Date.now() - s.lastPull > 20000) s.now();
  }
  /* after a sync brought newer games: reload them, keep the open game */
  function refresh() {
    games = store.get(KEY, []);
    if (cur) cur = games.find(g => g.id === cur.id) || null;
    if (!cur && /^#\/p\/g\//.test(location.hash)) { go(null); return; }
    render();
  }

  return { route, refresh, _test: { replay, stratLimit, stratCheck, primaryMission, step, vpRoom } };
})();
window.Play = Play;
