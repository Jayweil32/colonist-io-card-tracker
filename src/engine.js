// engine.js — the card-counting state engine.
//
// MODEL
// -----
// Tracking opponents' hands in Catan is a constraint problem, not a guessing
// game. Almost everything is deterministic from the public log; the only
// ambiguity is robber/knight steals, where you see THAT a card moved but not
// always WHICH one.
//
// We represent each player's hand as a "guaranteed" count plus participation in
// open "steal events" that inject uncertainty. Rather than collapse a steal to a
// random guess, we keep it symbolic and RESOLVE RETROACTIVELY: if a later event
// proves the victim couldn't have had resource X at steal time (e.g. their max
// possible X was 0), we eliminate X from that steal's possibilities. When a
// steal narrows to one resource, it becomes deterministic and we fold it into
// guaranteed counts.
//
// For each player we therefore track a range per resource: [min, max].
//   - min: resources they are GUARANTEED to hold
//   - max: resources they could POSSIBLY hold (given unresolved steals)
// Deterministic gains/losses move both bounds. Steals are recorded separately.

import { RESOURCES, COSTS, emptyHand } from "./types.js";

export function createState(playerNames) {
  /** @type {Record<string, {min:Object,max:Object}>} */
  const players = {};
  for (const name of playerNames) {
    players[name] = { min: emptyHand(), max: emptyHand() };
  }
  return {
    players,
    steals: [],   // unresolved/historical steal records
    log: [],      // human-readable trace of what the engine did
  };
}

function ensurePlayer(state, name) {
  if (!state.players[name]) {
    state.players[name] = { min: emptyHand(), max: emptyHand() };
  }
  return state.players[name];
}

// --- deterministic primitives -------------------------------------------------

function gain(state, name, res, n = 1) {
  const p = ensurePlayer(state, name);
  p.min[res] += n;
  p.max[res] += n;
}

function lose(state, name, res, n = 1) {
  const p = ensurePlayer(state, name);
  p.min[res] = Math.max(0, p.min[res] - n);
  p.max[res] = Math.max(0, p.max[res] - n);
}

// A player spending/trading resource r proves they held r. If they're the
// victim of an unresolved steal that listed r as a candidate, and after the
// spend their max[r] can no longer cover both the spend and the stolen card,
// then r wasn't what got stolen — eliminate it. We re-run resolution after.
function loseAndConstrain(state, name, res, n = 1) {
  for (const steal of state.steals) {
    if (steal.resolved || steal.victim !== name) continue;
    if (!steal.candidates.includes(res)) continue;
    const p = state.players[name];
    // Before the spend, the optimistic model let the steal take r by lowering
    // min[r]. If the victim now needs to spend n of r and their guaranteed
    // min[r] (the floor) is already < n, the only way the spend is legal is if
    // the steal did NOT take r. Eliminate r from the steal.
    if (p.min[res] < n) {
      steal.candidates = steal.candidates.filter((c) => c !== res);
      state.players[steal.thief].max[res] -= 1;
      // Restore the victim floor we optimistically borrowed for r.
      p.min[res] = Math.min(p.min[res] + 1, p.max[res]);
    }
  }
  lose(state, name, res, n);
  resolveSteals(state);
}

function spend(state, name, cost) {
  for (const res of Object.keys(cost)) loseAndConstrain(state, name, res, cost[res]);
}

// --- steal handling -----------------------------------------------------------
//
// A steal moves ONE unknown card from victim -> thief. At steal time the set of
// possible resources is "every resource the victim could possibly have held".
// We record it and adjust bounds: thief's max for each candidate +1, victim's
// min for each candidate can't be trusted (could be the stolen one) so victim
// min stays, victim max -1 only if forced. We then run resolution.

function recordSteal(state, thief, victim, knownResource = null) {
  const v = ensurePlayer(state, victim);
  ensurePlayer(state, thief);

  if (knownResource) {
    // Fully observed steal (e.g. you were the victim, or UI revealed it).
    lose(state, victim, knownResource, 1);
    gain(state, thief, knownResource, 1);
    state.log.push(`${thief} stole ${knownResource} from ${victim} (known)`);
    return;
  }

  // Candidates: any resource the victim could possibly hold right now.
  const candidates = RESOURCES.filter((r) => v.max[r] > 0);
  const steal = { thief, victim, candidates, resolved: false };
  state.steals.push(steal);

  // Optimistic bounds — for each candidate the thief MIGHT now have +1, and the
  // victim MIGHT have lost it (min -1). We widen ranges and let resolveSteals
  // tighten them as later events impose constraints.
  for (const r of candidates) {
    state.players[thief].max[r] += 1;
    state.players[victim].min[r] = Math.max(0, state.players[victim].min[r] - 1);
  }
  state.log.push(
    `${thief} stole 1 unknown from ${victim} (candidates: ${candidates.join(",") || "none"})`
  );
  resolveSteals(state);
}

// Resolution pass. For each unresolved steal we re-derive which candidates are
// still possible. A candidate r is IMPOSSIBLE if the victim is provably unable
// to have given up r — detected by max[r] hitting 0 (victim can't possibly hold
// r) which happens after deterministic spends/trades consume the optimistic
// surplus. When candidates narrow to one, the steal collapses to deterministic.
function resolveSteals(state) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const steal of state.steals) {
      if (steal.resolved) continue;
      const v = state.players[steal.victim];
      const t = state.players[steal.thief];

      // A candidate is impossible once the victim's max for it is 0: there's no
      // way the unknown card was r if the victim provably holds zero r.
      const live = steal.candidates.filter((r) => v.max[r] > 0);

      if (live.length !== steal.candidates.length) {
        for (const r of steal.candidates) {
          if (!live.includes(r)) t.max[r] -= 1; // retract optimistic thief gain
        }
        steal.candidates = live;
        changed = true;
      }

      if (steal.candidates.length === 1) {
        const r = steal.candidates[0];
        // Collapse to the deterministic outcome and retract optimistic widening.
        t.max[r] -= 1; gain(state, steal.thief, r, 1);
        v.min[r] = Math.max(0, v.min[r] - 1); lose(state, steal.victim, r, 1);
        steal.resolved = true;
        state.log.push(`resolved steal: ${steal.thief} took ${r} from ${steal.victim}`);
        changed = true;
      }
    }
  }
}

// --- public event application -------------------------------------------------

export function applyEvent(state, ev) {
  switch (ev.type) {
    case "roll_gain": // {type, player, gains:{res:n,...}}
      for (const r of Object.keys(ev.gains)) gain(state, ev.player, r, ev.gains[r]);
      break;
    case "build": // {type, player, item}
      spend(state, ev.player, COSTS[ev.item]);
      break;
    case "bank_trade": // {type, player, give:{res:n}, receive:{res:n}}
      for (const r of Object.keys(ev.give)) loseAndConstrain(state, ev.player, r, ev.give[r]);
      for (const r of Object.keys(ev.receive)) gain(state, ev.player, r, ev.receive[r]);
      break;
    case "player_trade": // {type, from, to, gave:{res:n}, got:{res:n}}
      for (const r of Object.keys(ev.gave)) { loseAndConstrain(state, ev.from, r, ev.gave[r]); gain(state, ev.to, r, ev.gave[r]); }
      for (const r of Object.keys(ev.got))  { loseAndConstrain(state, ev.to, r, ev.got[r]);  gain(state, ev.from, r, ev.got[r]); }
      resolveSteals(state);
      break;
    case "steal": // {type, thief, victim, resource?:res}
      recordSteal(state, ev.thief, ev.victim, ev.resource || null);
      break;
    case "discard": // {type, player, cards:{res:n}}
      for (const r of Object.keys(ev.cards)) lose(state, ev.player, r, ev.cards[r]);
      resolveSteals(state);
      break;
    case "year_of_plenty": // {type, player, cards:{res:n}}
      for (const r of Object.keys(ev.cards)) gain(state, ev.player, r, ev.cards[r]);
      break;
    case "monopoly": // {type, player, resource, takenFrom:{name:n,...}}
      for (const victim of Object.keys(ev.takenFrom)) lose(state, victim, ev.resource, ev.takenFrom[victim]);
      let total = Object.values(ev.takenFrom).reduce((a, b) => a + b, 0);
      gain(state, ev.player, ev.resource, total);
      break;
    default:
      throw new Error(`unknown event type: ${ev.type}`);
  }
  state.log.push(`applied ${ev.type}`);
  return state;
}

export function snapshot(state) {
  const out = {};
  for (const [name, p] of Object.entries(state.players)) {
    out[name] = {};
    for (const r of RESOURCES) {
      out[name][r] = p.min[r] === p.max[r] ? `${p.min[r]}` : `${p.min[r]}-${p.max[r]}`;
    }
  }
  return out;
}
