// Computer players (strategic). They only use what their own seat may know:
// face-up cards and cards they have looked at themselves — never the partner's
// hidden cards (no table talk).
//
// Each decision compares concrete options by expected points: lowering our own
// total, raising an opponent's, or learning hidden cards (worth roughly a point,
// because known cards lead to better swaps later).
import { canSee, legalTypes, isProtected, teamOf, partnerOf } from "./engine.js";

const ALL_VALUES = (() => { const v = [0, 0, 13, 13]; for (let n = 1; n <= 12; n++) v.push(n, n, n, n); return v; })();
const INFO = 1.1;          // value of learning one of our own unknown cards
const OPP_INFO = 0.5;      // value of learning an opponent's card

/** Everything a seat can reason about. */
function knowledge(state, seat) {
  // Expected value of an unseen card = average of the cards this seat hasn't seen.
  const seen = [];
  const add = (c) => { if (c && canSee(state, seat, c)) seen.push(c.v); };
  state.players.forEach((p) => p.village.forEach(add));
  state.discard.forEach((c) => seen.push(c.v));
  state.squire.forEach((c) => seen.push(c.v));
  const pool = [...ALL_VALUES];
  for (const v of seen) { const i = pool.indexOf(v); if (i >= 0) pool.splice(i, 1); }
  const E = pool.length ? pool.reduce((a, b) => a + b, 0) / pool.length : 6.5;
  const val = (c) => (canSee(state, seat, c) ? c.v : E);
  const me = state.players[seat];
  const mine = me.village.filter((c) => c.id !== state.amulet.card).map((c) => ({ c, known: canSee(state, seat, c), v: val(c) }));
  const total = (s) => state.players[s].village.reduce((t, c) => t + val(c), 0);
  const unknown = (s) => state.players[s].village.filter((c) => !canSee(state, seat, c)).length;
  const opponents = [0, 1, 2, 3].filter((s) => teamOf(s) !== teamOf(seat));
  const nextIsOpponent = teamOf((seat + 1) % 4) !== teamOf(seat);
  return { E, val, me, mine, total, unknown, opponents, nextIsOpponent };
}

/**
 * Best way to bring a card of value `v` into our village: replace one card, or a
 * matching set (13s are wild). Returns { ids, gain } — gain in expected points.
 */
function bestExchange(K, v) {
  let best = { ids: null, gain: -Infinity };
  const giftPenalty = (outVals) => K.nextIsOpponent ? outVals.reduce((t, x) => t + (x <= 3 ? (4 - x) * 0.4 : 0), 0) : 0;
  for (const x of K.mine) {
    const gain = x.v - v - giftPenalty(x.known ? [x.v] : []);
    if (gain > best.gain) best = { ids: [x.c.id], gain };
  }
  const known = K.mine.filter((x) => x.known);
  for (let target = 1; target <= 12; target++) {
    const group = known.filter((x) => x.v === target || x.v === 13);
    if (group.filter((x) => x.v === target).length < 1 || group.length < 2) continue;
    const gain = group.reduce((t, x) => t + x.v, 0) - v - giftPenalty(group.map((x) => x.v)) + 1.5; // fewer cards also helps calling
    if (gain > best.gain) best = { ids: group.map((x) => x.c.id), gain };
  }
  return best;
}

/** Opponent cards a power may target. */
function targets(state, seat, K, { faceDownOnly = false, mustSee = false, unseenOnly = false } = {}) {
  const out = [];
  for (const s of K.opponents) {
    for (const c of state.players[s].village) {
      if (state.amulet.card === c.id || isProtected(state, c, seat)) continue;
      if (faceDownOnly && c.up) continue;
      const seenIt = canSee(state, seat, c);
      if (mustSee && !seenIt) continue;
      if (unseenOnly && seenIt) continue;
      out.push({ owner: s, c, v: K.val(c), known: seenIt });
    }
  }
  return out;
}

/** Expected value of using power `p` (when the drawn card is discarded). */
function powerPlan(state, seat, p, K) {
  const ownUnknown = K.mine.filter((x) => !x.known && !x.c.up);
  const none = { gain: 0, action: { type: "skipPower" } };
  switch (p) {
    case 5: return ownUnknown.length ? { gain: INFO * 0.8, action: { type: "power5", cardId: ownUnknown[0].c.id } } : none;
    case 6: {
      const t = targets(state, seat, K, { faceDownOnly: true, unseenOnly: true });
      return t.length ? { gain: OPP_INFO, action: { type: "power6", cardId: t[0].c.id } } : none;
    }
    case 7: return ownUnknown.length ? { gain: INFO * Math.min(2, ownUnknown.length), action: { type: "power7", cardIds: ownUnknown.slice(0, 2).map((x) => x.c.id) } } : none;
    case 8: {
      const t = targets(state, seat, K, { faceDownOnly: true, unseenOnly: true });
      return t.length ? { gain: OPP_INFO, action: { type: "power8", cardId: t[0].c.id } } : none;
    }
    case 9: {
      if (ownUnknown.length) return { gain: INFO, action: { type: "power9", cardId: ownUnknown[0].c.id } };
      const t = targets(state, seat, K, { faceDownOnly: true, unseenOnly: true });
      return t.length ? { gain: OPP_INFO, action: { type: "power9", cardId: t[0].c.id } } : none;
    }
    case 10: {
      let best = none;
      for (const c of state.discard.slice(0, -1)) {
        const ex = bestExchange(K, c.v);
        if (ex.ids && ex.gain > best.gain) best = { gain: ex.gain, action: { type: "power10", discardId: c.id, cardIds: ex.ids } };
      }
      return best;
    }
    case 11: {
      const top = state.deck[0];
      if (!top) return none;
      // The bot sees the top card only after choosing the power, so plan on the expected value.
      return { gain: 1.5, action: null, needsTop: true };
    }
    case 12: {
      let best = none;
      const give = [...K.mine].sort((a, b) => b.v - a.v)[0];
      if (!give) return none;
      for (const t of targets(state, seat, K, { mustSee: true })) {
        const gain = (give.v - t.v) * 1.8;      // we drop by (give - take), they rise by the same
        if (gain > best.gain) best = { gain, action: { type: "power12", theirId: t.c.id, myId: give.c.id } };
      }
      return best;
    }
    default: return none;
  }
}

function witchChoice(state, seat, K) {
  const top = state.deck[0];
  if (!top) return { type: "skipPower" };
  const ex = bestExchange(K, top.v);
  let best = { gain: 0.5, action: { type: "skipPower" } };
  if (ex.ids && ex.gain > best.gain) best = { gain: ex.gain, action: { type: "power11", cardIds: ex.ids } };
  for (const t of targets(state, seat, K, {})) {
    const gain = (top.v - t.v) * 0.9;            // damage to the opponent
    if (gain > best.gain) best = { gain, action: { type: "power11", cardId: t.c.id } };
  }
  return best.action;
}

function shouldCall(state, seat, K) {
  if (K.me.village.length > 4) return false;
  const ours = K.total(seat) + K.total(partnerOf(seat));
  const theirs = K.opponents.reduce((t, s) => t + K.total(s), 0);
  const uncertainty = K.unknown(seat) * 2.5 + K.unknown(partnerOf(seat)) * 1.2 + K.opponents.reduce((t, s) => t + K.unknown(s), 0) * 0.6;
  const opponentsImprove = 5;                    // they each get one more turn
  const lateRound = state.deck.length < 10 ? 3 : 0;
  return ours + uncertainty + opponentsImprove - lateRound < theirs && K.total(seat) <= 10;
}

export function chooseAction(state, seat) {
  const types = legalTypes(state, seat);
  if (!types.length) return null;
  if (types.includes("nextRound")) return { type: "nextRound" };
  const K = knowledge(state, seat);

  if (state.phase === "turn") {
    if (types.includes("empath")) {
      const u = K.mine.find((x) => !x.known && !x.c.up);
      if (u) return { type: "empath", cardId: u.c.id };
    }
    if (types.includes("placeAmulet")) {
      const low = K.mine.filter((x) => x.known).sort((a, b) => a.v - b.v)[0];
      if (low && low.v <= 2) return { type: "placeAmulet", cardId: low.c.id };
    }
    if (types.includes("guard") && !(state.guards[seat] ?? []).length) {
      const low = K.mine.filter((x) => x.known).sort((a, b) => a.v - b.v)[0];
      if (low) return { type: "guard", cardIds: [low.c.id] };
    }
    if (types.includes("call") && shouldCall(state, seat, K)) return { type: "call" };

    // Compare a sure thing (the discard / a Squire card) with the expected value of drawing.
    const top = state.discard[state.discard.length - 1];
    const fromDiscard = types.includes("takeDiscard") && top ? bestExchange(K, top.v) : { gain: -Infinity };
    let squire = { gain: -Infinity };
    if (types.includes("takeSquire")) state.squire.forEach((c, i) => { const ex = bestExchange(K, c.v); if (ex.gain > squire.gain) squire = { ...ex, index: i }; });
    const drawValue = types.includes("draw") ? 2.2 : -Infinity;   // typical value of a fresh draw (swap or power)
    if (squire.gain >= Math.max(fromDiscard.gain, drawValue) && squire.gain > 0) return { type: "takeSquire", index: squire.index };
    if (fromDiscard.gain >= drawValue && fromDiscard.gain > 0) return { type: "takeDiscard", cardIds: fromDiscard.ids };
    if (types.includes("draw")) return { type: "draw" };
    if (types.includes("takeDiscard")) return { type: "takeDiscard", cardIds: fromDiscard.ids ?? [K.mine[0].c.id] };
    return { type: "call" };
  }

  if (state.phase === "rascal") {
    let best = 0, bestGain = -Infinity;
    state.pending.cards.forEach((c, i) => {
      const g = Math.max(bestExchange(K, c.v).gain, c.v >= 5 && c.v <= 12 ? powerPlan(state, seat, c.v, K).gain : 0);
      if (g > bestGain) { bestGain = g; best = i; }
    });
    return { type: "rascalKeep", index: best };
  }

  if (state.phase === "drawn") {
    const card = state.pending.card;
    const ex = bestExchange(K, card.v);
    const pw = card.v >= 5 && card.v <= 12 && state.caller !== seat ? powerPlan(state, seat, card.v, K) : { gain: 0 };
    if (ex.ids && ex.gain > Math.max(pw.gain, 0.3)) return { type: "exchange", cardIds: ex.ids };
    return { type: "discardDrawn", usePower: pw.gain > 0 };
  }

  if (state.phase === "power") {
    const p = state.pending.power;
    if (p === 11) return witchChoice(state, seat, K);
    const plan = powerPlan(state, seat, p, K);
    return plan.action ?? { type: "skipPower" };
  }
  return null;
}
