// Computer players. They only use what their seat may legitimately know: face-up
// cards and cards they have looked at themselves (no peeking at the partner's
// hand — no table talk).
import { canSee, legalTypes, findCard, isProtected, teamOf, partnerOf } from "./engine.js";

const UNKNOWN = 6.5;   // expected value of an unseen card (deck average)

function view(state, seat) {
  const me = state.players[seat];
  const mine = me.village.map((c) => ({ c, v: canSee(state, seat, c) ? c.v : null }));
  const worst = mine.filter((x) => x.v !== null && x.c.id !== state.amulet.card).sort((a, b) => b.v - a.v)[0] ?? null;
  const unknownOwn = mine.filter((x) => x.v === null && x.c.id !== state.amulet.card);
  const estimate = (s) => state.players[s].village.reduce((t, c) => t + (canSee(state, seat, c) ? c.v : UNKNOWN), 0);
  return { me, mine, worst, unknownOwn, estimate };
}

/** A set of known cards with equal value (13s count as wild) worth swapping out for one card. */
function bestSet(mine, incoming, amuletId) {
  const known = mine.filter((x) => x.v !== null && x.c.id !== amuletId);
  let best = null;
  for (let v = 1; v <= 12; v++) {
    const group = known.filter((x) => x.v === v || x.v === 13);
    if (group.filter((x) => x.v === v).length < 1 || group.length < 2) continue;
    const gain = group.reduce((s, x) => s + x.v, 0) - incoming;
    if (!best || gain > best.gain) best = { ids: group.map((x) => x.c.id), gain };
  }
  return best;
}

/** Which of my cards to replace with a card of value `v` (or null to keep everything). */
function replacement(state, seat, v) {
  const { mine, worst, unknownOwn } = view(state, seat);
  const set = bestSet(mine, v, state.amulet.card);
  if (set && set.gain >= 7) return set.ids;
  if (worst && worst.v - v >= 3) return [worst.c.id];
  if (unknownOwn.length && v <= 3) return [unknownOwn[0].c.id];
  if (worst && worst.v > v && v <= 4) return [worst.c.id];
  return null;
}

function opponentCards(state, seat, { faceDownOnly = true, mustSee = false } = {}) {
  const out = [];
  for (const p of state.players) {
    if (p.seat === seat || teamOf(p.seat) === teamOf(seat)) continue;
    for (const c of p.village) {
      if (isProtected(state, c, seat) || state.amulet.card === c.id) continue;
      if (faceDownOnly && c.up) continue;
      if (mustSee && !canSee(state, seat, c)) continue;
      out.push({ owner: p.seat, c });
    }
  }
  return out;
}

const pickRandom = (list, rand) => list[Math.floor(rand() * list.length)];

export function chooseAction(state, seat, rand = Math.random) {
  const types = legalTypes(state, seat);
  if (!types.length) return null;
  if (types.includes("nextRound")) return { type: "nextRound" };
  const v = view(state, seat);

  if (state.phase === "turn") {
    // Free actions first.
    if (types.includes("empath") && v.unknownOwn.length) return { type: "empath", cardId: v.unknownOwn[0].c.id };
    if (types.includes("placeAmulet")) {
      const low = v.mine.filter((x) => x.v !== null && x.v <= 3).sort((a, b) => a.v - b.v)[0];
      if (low) return { type: "placeAmulet", cardId: low.c.id };
    }
    if (types.includes("guard") && !(state.guards[seat] ?? []).length) {
      const low = v.mine.filter((x) => x.v !== null && !x.c.up).sort((a, b) => a.v - b.v)[0];
      if (low) return { type: "guard", cardIds: [low.c.id] };
    }
    // Call when our team looks clearly lower than theirs.
    if (types.includes("call")) {
      const mineEst = v.estimate(seat), partnerEst = v.estimate(partnerOf(seat));
      const opp = [0, 1, 2, 3].filter((s) => teamOf(s) !== teamOf(seat)).reduce((t, s) => t + v.estimate(s), 0);
      const unknownCount = v.unknownOwn.length;
      if (mineEst + partnerEst + 4 < opp && mineEst <= 12 && unknownCount <= 1) return { type: "call" };
    }
    // A low card on the discard pile is worth taking.
    if (types.includes("takeDiscard")) {
      const top = state.discard[state.discard.length - 1];
      const ids = replacement(state, seat, top.v);
      if (ids && top.v <= 4) return { type: "takeDiscard", cardIds: ids };
    }
    if (types.includes("takeSquire")) {
      const i = state.squire.findIndex((c) => c.v <= 2);
      if (i >= 0 && replacement(state, seat, state.squire[i].v)) return { type: "takeSquire", index: i };
    }
    if (types.includes("draw")) return { type: "draw" };
    if (types.includes("takeDiscard")) return { type: "takeDiscard", cardIds: [(v.worst ?? v.mine.find((x) => x.c.id !== state.amulet.card)).c.id] };
    return { type: "call" };
  }

  if (state.phase === "rascal") {
    const cards = state.pending.cards;
    let best = 0;
    cards.forEach((c, i) => { if (c.v < cards[best].v) best = i; });
    return { type: "rascalKeep", index: best };
  }

  if (state.phase === "drawn") {
    const card = state.pending.card;
    const ids = replacement(state, seat, card.v);
    if (ids) return { type: "exchange", cardIds: ids };
    const useful = { 5: v.unknownOwn.length > 0, 6: opponentCards(state, seat).length > 0, 7: v.unknownOwn.length > 0,
      8: opponentCards(state, seat).length > 0, 9: true, 10: true, 11: state.deck.length > 0, 12: true };
    return { type: "discardDrawn", usePower: !!useful[card.v] && state.pending.from === "deck" };
  }

  if (state.phase === "power") {
    const p = state.pending.power;
    const skip = { type: "skipPower" };
    const ownDown = v.unknownOwn.map((x) => x.c.id);
    if (p === 5) return ownDown.length ? { type: "power5", cardId: ownDown[0] } : skip;
    if (p === 6) { const t = opponentCards(state, seat); return t.length ? { type: "power6", cardId: pickRandom(t, rand).c.id } : skip; }
    if (p === 7) return ownDown.length ? { type: "power7", cardIds: ownDown.slice(0, 2) } : skip;
    if (p === 8) { const t = opponentCards(state, seat).filter((x) => !canSee(state, seat, x.c)); return t.length ? { type: "power8", cardId: pickRandom(t, rand).c.id } : skip; }
    if (p === 9) {
      if (ownDown.length) return { type: "power9", cardId: ownDown[0] };
      const t = opponentCards(state, seat).filter((x) => !canSee(state, seat, x.c));
      return t.length ? { type: "power9", cardId: pickRandom(t, rand).c.id } : skip;
    }
    if (p === 10) {
      const pile = state.discard.slice(0, -1);
      const low = pile.map((c, i) => ({ c, i })).sort((a, b) => a.c.v - b.c.v)[0];
      const ids = low && replacement(state, seat, low.c.v);
      return low && ids ? { type: "power10", discardId: low.c.id, cardIds: ids } : skip;
    }
    if (p === 11) {
      const top = state.deck[0];
      if (!top) return skip;
      const ids = replacement(state, seat, top.v);
      if (ids) return { type: "power11", cardIds: ids };
      if (top.v >= 9) {
        const victims = opponentCards(state, seat, { faceDownOnly: false, mustSee: true }).filter((x) => x.c.v < top.v);
        const t = victims.sort((a, b) => a.c.v - b.c.v)[0];
        if (t) return { type: "power11", cardId: t.c.id };
      }
      return skip;
    }
    if (p === 12) {
      const give = v.worst;
      const take = opponentCards(state, seat, { faceDownOnly: false, mustSee: true }).sort((a, b) => a.c.v - b.c.v)[0];
      if (give && take && give.v - take.c.v >= 3) return { type: "power12", theirId: take.c.id, myId: give.c.id };
      return skip;
    }
    return skip;
  }
  return null;
}
