// EXPERIMENT, not used by the game: in self-play (80 games, 250 ms per decision) it scored ~13
// points/game better than the strategic player but won no more often (~50%), so it isn't shipped.
//
// Look-ahead computer player. For each big decision (draw / take a card / call / where to put a
// card / use a power) it imagines many deals of the cards it can't see — consistent with what this
// seat knows, never the real hidden cards — plays every option out to the end of the round with
// the quick strategic player, and picks the option with the best average result for its team.
// Small decisions (powers' targets, Amulet, Bodyguard, Empath) use the strategic player directly.
import { act, legalTypes, canSee, teamOf } from "./engine.js";
import { chooseAction as quick, knowledge, bestExchange } from "./bot.js";

const clone = (s) => JSON.parse(JSON.stringify(s));

/** A copy of the game where every card `seat` can't see gets a value shuffled among those cards. */
function determinize(state, seat, rand) {
  const s = clone(state);
  const hidden = [];
  for (const p of s.players) for (const c of p.village) if (!canSee(s, seat, c)) hidden.push(c);
  for (const c of s.deck) hidden.push(c);
  if (s.pending?.card && s.current !== seat) hidden.push(s.pending.card);
  const values = hidden.map((c) => c.v);
  for (let i = values.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [values[i], values[j]] = [values[j], values[i]]; }
  hidden.forEach((c, i) => { c.v = values[i]; });
  // Shuffle the deck order too (this seat doesn't know it).
  for (let i = s.deck.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [s.deck[i], s.deck[j]] = [s.deck[j], s.deck[i]]; }
  return s;
}

/** Play to the end of the round with the quick player; return the score margin for `seat`'s team. */
function rollout(s, seat) {
  for (let steps = 0; steps < 600 && s.phase !== "roundOver" && s.phase !== "gameOver"; steps++) {
    const a = quick(s, s.current);
    if (!a) break;
    s = act(s, s.current, a, { inPlace: true });
  }
  const r = s.lastRound;
  if (!r) return 0;
  const us = teamOf(seat);
  return r.roundScore[1 - us] - r.roundScore[us];      // positive = we did better (lower score)
}

/** The options worth comparing at this point. */
function candidates(state, seat) {
  const types = legalTypes(state, seat);
  const K = knowledge(state, seat);
  const out = [];
  const push = (a) => { const k = JSON.stringify(a); if (!out.some((x) => JSON.stringify(x) === k)) out.push(a); };
  if (state.phase === "turn") {
    if (types.includes("draw")) push({ type: "draw" });
    if (types.includes("takeDiscard")) {
      const top = state.discard.at(-1);
      const best = bestExchange(K, top.v);
      if (best.ids) push({ type: "takeDiscard", cardIds: best.ids });
      // Also: replace each card we know is high, or an unknown one.
      for (const x of [...K.mine].sort((a, b) => b.v - a.v).slice(0, 2)) push({ type: "takeDiscard", cardIds: [x.c.id] });
    }
    if (types.includes("takeSquire")) state.squire.forEach((c, i) => { const b = bestExchange(K, c.v); if (b.ids) push({ type: "takeSquire", index: i }); });
    if (types.includes("call")) push({ type: "call" });
    return out;
  }
  if (state.phase === "drawn") {
    const card = state.pending.card;
    const best = bestExchange(K, card.v);
    if (best.ids) push({ type: "exchange", cardIds: best.ids });
    for (const x of [...K.mine].sort((a, b) => b.v - a.v).slice(0, 3)) push({ type: "exchange", cardIds: [x.c.id] });
    const power = card.v >= 5 && card.v <= 12 && state.caller !== seat;
    if (power) push({ type: "discardDrawn", usePower: true });
    push({ type: "discardDrawn", usePower: false });
    return out;
  }
  if (state.phase === "rascal") return state.pending.cards.map((_, i) => ({ type: "rascalKeep", index: i }));
  return out;
}

/**
 * Choose an action for `seat`. `budgetMs` caps thinking time per decision (the quick player
 * answers instantly for small decisions or when there's only one option).
 */
export function chooseAction(state, seat, { budgetMs = 250, minSamples = 6, rand = Math.random } = {}) {
  const types = legalTypes(state, seat);
  if (!types.length) return null;
  if (types.includes("nextRound")) return { type: "nextRound" };
  const fallback = quick(state, seat);
  // Free actions (Empath, Amulet, Bodyguard) and power targets: the quick player's choice.
  if (fallback && ["empath", "placeAmulet", "guard"].includes(fallback.type)) return fallback;
  if (state.phase === "power") return fallback;
  const options = candidates(state, seat);
  if (fallback && !options.some((o) => JSON.stringify(o) === JSON.stringify(fallback))) options.push(fallback);
  if (options.length <= 1) return options[0] ?? fallback;
  // Successive halving: every live option is played out in the same imagined deals; after each
  // batch the worse half is dropped, so the remaining time goes to the close calls.
  const total = new Array(options.length).fill(0), count = new Array(options.length).fill(0);
  let live = options.map((_, i) => i);
  const deadline = Date.now() + budgetMs;
  let batch = Math.max(2, minSamples), rounds = 0;
  while (live.length > 1 && (rounds === 0 || Date.now() < deadline)) {
    for (let b = 0; b < batch && (rounds === 0 || Date.now() < deadline); b++) {
      const world = determinize(state, seat, rand);
      for (const i of live) {
        try { total[i] += rollout(act(world, seat, options[i]), seat); }
        catch { total[i] -= 1000; }                     // an option that turned out illegal here
        count[i]++;
      }
    }
    rounds++;
    const avg = (i) => total[i] / Math.max(1, count[i]);
    live.sort((x, y) => avg(y) - avg(x));
    if (Date.now() < deadline && live.length > 2) live = live.slice(0, Math.ceil(live.length / 2));
    batch *= 2;
    if (rounds > 12) break;
  }
  const avg = (i) => total[i] / Math.max(1, count[i]);
  let best = live[0];
  for (const i of live) if (avg(i) > avg(best)) best = i;
  return options[best];
}
