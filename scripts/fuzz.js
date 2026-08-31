/* Tier 3 — drive the engine with seeded semi-greedy agents. Checks that the
   game always terminates, that both win conditions are reachable, and that
   state never leaves legal bounds. Failures print their seed for replay. */
const WD = require('./load-engine.js')(process.argv[2] || 'index.html');

const RUNS = +(process.argv[3] || 60);
const TURN_CAP = 400;

function agentRnd(seed) { return WD.mulberry32(seed); }
const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/* Two agent shapes. A single greedy profile only proves the design works for
   that one style of play, which is how "unreachable ending" bugs hide. */
const PROFILES = {
  rusher:  { hqPrize: 3, cityPrize: 1, chaseUnits: false, attackChance: 0.7 },
  brawler: { hqPrize: 1, cityPrize: 2, chaseUnits: true,  attackChance: 1.0 }
};

function objectives(g, me, prof) {
  const out = [];
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const t = g.tiles[y][x];
    if ((t.terrain === 'city' || t.terrain === 'hq') && t.owner !== me)
      out.push({ x, y, prize: t.terrain === 'hq' ? prof.hqPrize : prof.cityPrize });
  }
  // Chase when told to — or always, once we have no capture-capable unit left,
  // because at that point a rout is our only remaining win condition.
  const canStillCapture = g.units.some(u => u.owner === me && WD.UNITS[u.type].captures);
  if (prof.chaseUnits || !canStillCapture)
    g.units.filter(u => u.owner !== me).forEach(u => out.push({ x: u.x, y: u.y, prize: 3 }));
  return out;
}

let fails = [];
let grinders = 0;
function check(cond, seed, msg) { if (!cond) fails.push(`seed ${seed}: ${msg}`); }

function invariants(g, seed, where) {
  for (const p of [0, 1]) {
    const pl = g.players[p];
    const all = pl.draw.concat(pl.hand, pl.discard);
    // Stronger than "10 cards": the deck must always be exactly the army.
    let expect = 2;                                  // the two Command cards
    g.units.filter(u => u.owner === p).forEach(u => { expect += WD.unitCardCount(u.type); });
    check(all.length === expect, seed,
      `${where}: P${p} holds ${all.length} cards but its army implies ${expect} — deck and army are out of sync`);
    const infCards = all.filter(c => c.key === 'inf_advance').length;
    const infUnits = g.units.filter(u => u.owner === p && u.type === 'infantry').length;
    check(infCards === infUnits, seed,
      `${where}: P${p} has ${infCards} infantry cards for ${infUnits} infantry (dead cards soft-lock the game)`);
    check(pl.playsLeft >= 0 && pl.playsLeft <= WD.PLAYS_PER_TURN, seed, `${where}: P${p} playsLeft=${pl.playsLeft}`);
    const cap = WD.handLimit(g, p) + WD.PLAYS_PER_TURN;
    check(pl.hand.length <= cap, seed, `${where}: P${p} hand ${pl.hand.length} exceeds ${cap}`);
  }
  const seen = new Set();
  for (const u of g.units) {
    check(u.hp > 0 && u.hp <= WD.UNITS[u.type].maxHp, seed, `${where}: unit hp ${u.hp}`);
    check(u.x >= 0 && u.x < g.w && u.y >= 0 && u.y < g.h, seed, `${where}: unit off-map`);
    const k = u.x + ',' + u.y;
    check(!seen.has(k), seed, `${where}: two units stacked on ${k}`);
    seen.add(k);
  }
}

function takeOneAction(g, rnd, prof) {
  const me = g.current;
  const p = g.players[me];
  const live = p.hand.filter(c => WD.cardIsLive(g, c));
  if (!live.length) return false;

  const goals = objectives(g, me, prof);

  // 1. finish a capture if we can
  for (const c of live) {
    for (const u of WD.eligibleUnits(g, c)) {
      if (WD.canCapture(g, u, c)) return WD.playCapture(g, c, u);
    }
  }
  // 2. attack, preferring a kill
  let best = null;
  for (const c of live) {
    for (const u of WD.eligibleUnits(g, c)) {
      for (const t of WD.legalAttacks(g, u, c)) {
        const dmg = WD.damage(g, u, t);
        const score = (dmg >= t.hp ? 100 : 0) + dmg;
        if (!best || score > best.score) best = { c, u, t, score };
      }
    }
  }
  if (best && (best.score >= 100 || rnd() < prof.attackChance)) return WD.playAttack(g, best.c, best.u, best.t);

  // 3. advance toward the nearest objective
  let mv = null;
  for (const c of live) {
    for (const u of WD.eligibleUnits(g, c)) {
      // Never walk a unit off a capture it has already started — moving resets
      // progress to zero, and an agent that does this can loop forever.
      const here = g.tiles[u.y][u.x];
      if (here.capBy === u.uid && here.capProg > 0) continue;
      for (const m of WD.legalMoves(g, u, c)) {
        if (!goals.length) continue;
        let s = -Infinity;
        for (const goal of goals) s = Math.max(s, goal.prize * 10 - dist(m, goal));
        // Don't park a unit that cannot capture on top of a capture tile —
        // it blocks its own infantry and the position never resolves.
        const dt = g.tiles[m.y][m.x];
        if (!WD.UNITS[u.type].captures && (dt.terrain === 'city' || dt.terrain === 'hq') && dt.owner !== me) s -= 25;
        s += rnd() * 2;
        if (!mv || s > mv.score) mv = { c, u, m, score: s };
      }
    }
  }
  if (mv) return WD.playMove(g, mv.c, mv.u, mv.m.x, mv.m.y);

  // 4. cycle a Command card
  for (const c of live) {
    if (WD.cardDef(c).modes.indexOf('draw') >= 0) return WD.playDraw(g, c);
  }
  return false;
}

console.log('\nFUZZ');
const endings = {};
let capped = 0, totalTurns = 0;

const profNames = Object.keys(PROFILES);
for (let run = 0; run < RUNS; run++) {
  const seed = 1000 + run;
  // Alternate matchups so every pairing gets played.
  const pa = PROFILES[profNames[run % 2]];
  const pb = PROFILES[profNames[(run >> 1) % 2]];
  const profOf = () => (g.current === 0 ? pa : pb);
  const rnd = agentRnd(seed);
  let g;
  try {
    g = WD.createGame({ seed });
    let guard = 0;
    while (g.winner === null && g.turn <= TURN_CAP && guard++ < 12000) {
      let acted = true, plays = 0;
      while (g.players[g.current].playsLeft > 0 && acted && plays++ < 10) {
        acted = takeOneAction(g, rnd, profOf());
        invariants(g, seed, 'turn ' + g.turn);
      }
      if (g.winner !== null) break;
      WD.endTurn(g);
      invariants(g, seed, 'after endTurn ' + g.turn);
    }
  } catch (err) {
    fails.push(`seed ${seed}: threw ${err && err.message}`);
    continue;
  }
  totalTurns += g.turn;
  if (g.turn > 60) grinders++;
  if (g.winner === null) { capped++; fails.push(`seed ${seed}: no result by turn ${TURN_CAP} (deadlock)`); }
  else endings[g.winReason] = (endings[g.winReason] || 0) + 1;
}

console.log(`  profiles: ${profNames.join(', ')}`);
console.log(`  ${RUNS} playthroughs, mean length ${(totalTurns / RUNS).toFixed(1)} turns`);
Object.keys(endings).forEach(k => console.log(`  ending reached: ${k} × ${endings[k]}`));
const reasons = ['headquarters captured', 'enemy army destroyed'];
reasons.forEach(r => {
  if (!endings[r]) fails.push(`ending never reached across ${RUNS} runs: ${r}`);
});
console.log(`  turn-cap hits: ${capped}`);
console.log(`  games running past 60 turns: ${grinders}  (design signal, not a failure)`);

if (fails.length) {
  console.log('\n  FAILURES:');
  fails.slice(0, 12).forEach(f => console.log('   ' + f));
  if (fails.length > 12) console.log(`   ...and ${fails.length - 12} more`);
  console.log('\nFUZZ FAILED\n');
  process.exitCode = 1;
} else {
  console.log('\nFUZZ PASSED\n');
}
