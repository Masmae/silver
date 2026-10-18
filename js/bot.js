// Computer players (strategic). They only use what their own seat may know:
// face-up cards and cards they have looked at themselves — never the partner's
// hidden cards (no table talk).
//
// Each decision compares concrete options by expected points: lowering our own
// total, raising an opponent's, or learning hidden cards (worth roughly a point,
// because known cards lead to better swaps later).
import { canSee, legalTypes, isProtected, teamOf, partnerOf } from "./engine.js";

const ALL_VALUES = (() => { const v = [0, 0, 13, 13]; for (let n = 1; n <= 12; n++) v.push(n, n, n, n); return v; })();
// Judgment numbers (tuned by self-play, see tests/tune.mjs).
export const DEFAULTS = {
  info: 1.1,            // value of learning one of our own unknown cards
  oppInfo: 0.5,         // value of learning an opponent's card
  gift: 0.4,            // fear of handing the next (opponent) player a low card, per point under 4
  setBonus: 1.5,        // extra value of exchanging a set (fewer cards helps calling)
  drawValue: 3.5,       // typical value of a fresh draw (tuned up from 2.2)
  keepMin: 0.3,         // keep a drawn card only if it beats using its power by this much
  robber: 1.8,          // Robber: value per point swapped
  witchOpp: 0.9,        // Witch: value per point of damage to an opponent
  callMaxCards: 4,      // call only with this many cards or fewer
  callOwnMax: 10,       // …and our own known-ish total at most this
  callUnknownMe: 2.5, callUnknownPartner: 1.2, callUnknownOpp: 0.6,
  callOppImprove: 5, callLate: 3, callLateDeck: 10,
  // What a card in our village really costs, beyond its face value:
  dopp: 6,              // a 13 early in the round, with a known card to pair it with (13 is wild in sets)
  lateDeck: 8,          // …"late" = fewer deck cards than this (or someone called): a 13 is just 13 again
  rascal: 2,            // a face-up 4 (Rascal): an extra card to choose from every draw
  empath: 0.8,          // a face-up 2 (Empath): a free peek every turn
  bodyguard: 0.6,       // a face-up 3 (Bodyguard): protection
  pair: 2,              // a card matching one we know: the pair can later go out together for one card
  rascalDraw: 1.2,      // each face-up 4 makes drawing worth this much more
};
let P = DEFAULTS;

/** Everything a seat can reason about. */
export function knowledge(state, seat) {
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
  const early = state.deck.length >= P.lateDeck && state.caller === null;
  /**
   * What a card of value v really costs in our village. `up`: it is/will be face-up (village
   * powers work); `without`: ignore this card when looking for a partner (it's the one leaving).
   */
  const worth = (v, up, without = null, self = null) => {
    let w = v;
    const others = mine.filter((x) => x.known && x.c.id !== without && x.c.id !== self);
    if (v === 13 && early && others.some((x) => x.v !== 13)) w -= P.dopp;
    if (up) w -= v === 4 ? P.rascal : v === 2 ? P.empath : v === 3 ? P.bodyguard : 0;
    if (v >= 5 && v <= 12 && others.some((x) => x.v === v)) w -= P.pair;
    return w;
  };
  for (const x of mine) x.w = x.known ? worth(x.v, x.c.up, null, x.c.id) : E;
  const total = (s) => state.players[s].village.reduce((t, c) => t + val(c), 0);
  const unknown = (s) => state.players[s].village.filter((c) => !canSee(state, seat, c)).length;
  const opponents = [0, 1, 2, 3].filter((s) => teamOf(s) !== teamOf(seat));
  const nextIsOpponent = teamOf((seat + 1) % 4) !== teamOf(seat);
  return { E, val, me, mine, total, unknown, opponents, nextIsOpponent, worth, early };
}

/**
 * Best way to bring a card of value `v` into our village: replace one card, or a
 * matching set (13s are wild). Returns { ids, gain } — gain in expected points.
 */
export function bestExchange(K, v, up = false) {
  let best = { ids: null, gain: -Infinity };
  const giftPenalty = (outVals) => K.nextIsOpponent ? outVals.reduce((t, x) => t + (x <= 3 ? (4 - x) * P.gift : 0), 0) : 0;
  for (const x of K.mine) {
    const gain = x.w - K.worth(v, up, x.c.id) - giftPenalty(x.known ? [x.v] : []);
    if (gain > best.gain) best = { ids: [x.c.id], gain };
  }
  const known = K.mine.filter((x) => x.known);
  for (let target = 1; target <= 12; target++) {
    const group = known.filter((x) => x.v === target || x.v === 13);
    if (group.filter((x) => x.v === target).length < 1 || group.length < 2) continue;
    const gain = group.reduce((t, x) => t + x.v, 0) - K.worth(v, up, group[0].c.id) - giftPenalty(group.map((x) => x.v)) + P.setBonus; // fewer cards also helps calling
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
    case 5: {
      // Turn up our own known 4 / 2 / 3 to switch its power on; otherwise reveal an unknown card.
      const sleeper = K.mine.filter((x) => x.known && !x.c.up && [4, 2, 3].includes(x.v))
        .map((x) => ({ x, g: x.v === 4 ? P.rascal : x.v === 2 ? P.empath : P.bodyguard })).sort((a, b) => b.g - a.g)[0];
      if (sleeper && sleeper.g >= P.info * 0.8) return { gain: sleeper.g, action: { type: "power5", cardId: sleeper.x.c.id } };
      return ownUnknown.length ? { gain: P.info * 0.8, action: { type: "power5", cardId: ownUnknown[0].c.id } } : none;
    }
    case 6: {
      const t = targets(state, seat, K, { faceDownOnly: true, unseenOnly: true });
      return t.length ? { gain: P.oppInfo, action: { type: "power6", cardId: t[0].c.id } } : none;
    }
    case 7: return ownUnknown.length ? { gain: P.info * Math.min(2, ownUnknown.length), action: { type: "power7", cardIds: ownUnknown.slice(0, 2).map((x) => x.c.id) } } : none;
    case 8: {
      const t = targets(state, seat, K, { faceDownOnly: true, unseenOnly: true });
      return t.length ? { gain: P.oppInfo, action: { type: "power8", cardId: t[0].c.id } } : none;
    }
    case 9: {
      if (ownUnknown.length) return { gain: P.info, action: { type: "power9", cardId: ownUnknown[0].c.id } };
      const t = targets(state, seat, K, { faceDownOnly: true, unseenOnly: true });
      return t.length ? { gain: P.oppInfo, action: { type: "power9", cardId: t[0].c.id } } : none;
    }
    case 10: {
      let best = none;
      for (const c of state.discard.slice(0, -1)) {
        const ex = bestExchange(K, c.v, true);                       // the Master's card comes in face-up
        if (ex.ids && ex.gain > best.gain) best = { gain: ex.gain, action: { type: "power10", discardId: c.id, cardIds: ex.ids } };
      }
      return best;
    }
    case 11: {
      const top = state.deck[0];
      if (!top) return none;
      // The top card is seen only after choosing the power: plan on the expected value — swap it
      // for our worst card, or hand it to an opponent in place of their best known card.
      const worst = Math.max(...K.mine.map((x) => x.w)) - K.E;
      const opp = Math.max(0, ...targets(state, seat, K, { mustSee: true }).map((t) => (K.E - t.v) * P.witchOpp));
      return { gain: Math.max(1.5, worst, opp), action: null, needsTop: true };
    }
    case 12: {
      let best = none;
      const give = [...K.mine].sort((a, b) => b.v - a.v)[0];
      if (!give) return none;
      for (const t of targets(state, seat, K, { mustSee: true })) {
        const gain = (give.v - t.v) * P.robber;      // we drop by (give - take), they rise by the same
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
    const gain = (top.v - t.v) * P.witchOpp;            // damage to the opponent
    if (gain > best.gain) best = { gain, action: { type: "power11", cardId: t.c.id } };
  }
  return best.action;
}

function shouldCall(state, seat, K) {
  if (K.me.village.length > P.callMaxCards) return false;
  const ours = K.total(seat) + K.total(partnerOf(seat));
  const theirs = K.opponents.reduce((t, s) => t + K.total(s), 0);
  const uncertainty = K.unknown(seat) * P.callUnknownMe + K.unknown(partnerOf(seat)) * P.callUnknownPartner + K.opponents.reduce((t, s) => t + K.unknown(s), 0) * P.callUnknownOpp;
  const lateRound = state.deck.length < P.callLateDeck ? P.callLate : 0;
  return ours + uncertainty + P.callOppImprove - lateRound < theirs && K.total(seat) <= P.callOwnMax;
}

export function chooseAction(state, seat, params = DEFAULTS) {
  P = params;
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
    const fromDiscard = types.includes("takeDiscard") && top ? bestExchange(K, top.v, true) : { gain: -Infinity };   // comes in face-up
    // A Squire card can be kept (face-up) or discarded for its power, like a drawn card.
    let squire = { gain: -Infinity };
    if (types.includes("takeSquire")) state.squire.forEach((c, i) => {
      const keep = bestExchange(K, c.v, true).gain;
      const power = c.v >= 5 && c.v <= 12 && state.caller !== seat ? powerPlan(state, seat, c.v, K).gain : -Infinity;
      const g = Math.max(keep, power);
      if (g > squire.gain) squire = { gain: g, index: i };
    });
    // A fresh draw (swap or power); each face-up 4 adds a card to choose from.
    const rascals = K.me.village.filter((c) => c.up && c.v === 4).length;
    const drawValue = types.includes("draw") ? P.drawValue + P.rascalDraw * rascals : -Infinity;
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
    const ex = bestExchange(K, card.v, state.pending.from === "squire");   // a kept Squire card stays face-up
    const pw = card.v >= 5 && card.v <= 12 && state.caller !== seat ? powerPlan(state, seat, card.v, K) : { gain: 0 };
    if (ex.ids && ex.gain > Math.max(pw.gain, P.keepMin)) return { type: "exchange", cardIds: ex.ids };
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
