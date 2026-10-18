// Silver (2 vs 2 house rules) — pure game engine.
//
// Based on the rules of Silver by Ted Alspach (Bezier Games). This is an
// unofficial fan implementation for playing with friends.
//
// Every move is an action applied to a plain, JSON-serializable state:
//   state = newGame({ names, seed })
//   state = act(state, seat, action)        // throws GameError if illegal
// Randomness comes from a seeded generator stored in the state, so a game can
// be replayed or synchronised between devices by sending actions.
//
// Team rules (2 vs 2): seats 0 & 2 vs 1 & 3 (partners sit opposite). A team's
// round total is the sum of both partners' cards. A call succeeds when the
// caller's team total is lowest (ties count): that team scores 0, otherwise it
// scores its total + 10. The other team always scores its total. No table talk:
// each player only knows what they themselves have seen.

export class GameError extends Error {}

export const POWERS = {
  0: { name: "Villager", when: "village", text: "If both Villagers are face-up in villages, the round ends immediately." },
  1: { name: "Squire", when: "village", text: "Each face-up Squire in any village keeps one face-up card beside the deck that anyone may take instead of drawing." },
  2: { name: "Empath", when: "village", text: "Each face-up Empath in your village lets you secretly look at one of your face-down cards per turn." },
  3: { name: "Bodyguard", when: "village", text: "Face-up in your village: protect one of your cards — nobody else can look at or move it." },
  4: { name: "Rascal", when: "village", text: "Each face-up Rascal in your village lets you draw one extra card; keep one, the rest go back on the deck." },
  5: { name: "Exposer", when: "discard", text: "Turn one of your face-down cards face-up." },
  6: { name: "Revealer", when: "discard", text: "Turn any face-down card in any village face-up." },
  7: { name: "Beholder", when: "discard", text: "Secretly look at two of your face-down cards." },
  8: { name: "Apprentice Seer", when: "discard", text: "Secretly look at one face-down card in another player's village." },
  9: { name: "Seer", when: "discard", text: "Secretly look at any face-down card." },
  10: { name: "Master", when: "discard", text: "Take any card from the discard pile and exchange it (face-up) with one or more of your cards." },
  11: { name: "Witch", when: "discard", text: "Look at the top card of the deck and exchange it (face-down) with a card in another village, or with one or more of your own." },
  12: { name: "Robber", when: "discard", text: "Swap one of your cards with a card in another village, then secretly look at your new card." },
  13: { name: "Doppelgänger", when: "exchange", text: "Matches any value when you exchange several cards at once. Worth 13 if it stays in your village." },
};

export const ROUNDS = 4;
export const teamOf = (seat) => seat % 2;
export const partnerOf = (seat) => (seat + 2) % 4;

// ---------------------------------------------------------------- helpers

function rng(state) {
  // mulberry32, state kept in state.rngState
  let a = (state.rngState = (state.rngState + 0x6d2b79f5) >>> 0);
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

function freshDeck(state) {
  const values = [0, 0, 13, 13];
  for (let v = 1; v <= 12; v++) values.push(v, v, v, v);
  const deck = values.map((v, i) => ({ id: `r${state.round}c${i}`, v, up: false }));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng(state) * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const clone = (s) => JSON.parse(JSON.stringify(s));
const fail = (msg) => { throw new GameError(msg); };

export function findCard(state, cardId) {
  for (const p of state.players) {
    const i = p.village.findIndex((c) => c.id === cardId);
    if (i >= 0) return { owner: p.seat, index: i, card: p.village[i] };
  }
  return null;
}

/** Can `seat` see this card's value right now? */
export function canSee(state, seat, card) {
  return card.up || state.players[seat].known.includes(card.id);
}

const learn = (state, seat, cardId) => { const k = state.players[seat].known; if (!k.includes(cardId)) k.push(cardId); };
const learnAll = (state, cardId) => state.players.forEach((p) => learn(state, p.seat, cardId));
const countUp = (village, v) => village.filter((c) => c.up && c.v === v).length;
const log = (state, text) => { state.log.push(text); if (state.log.length > 200) state.log.shift(); };
const name = (state, seat) => state.players[seat].name;

/** A card nobody but its owner may look at or move (Amulet, Bodyguard). */
export function isProtected(state, card, bySeat) {
  if (state.amulet.card === card.id) return true;
  const f = findCard(state, card.id);
  if (!f) return false;
  return f.owner !== bySeat && (state.guards[f.owner] ?? []).includes(card.id);
}

// ---------------------------------------------------------------- setup

export function newGame({ names = ["You", "West", "Partner", "East"], seed = Date.now() } = {}) {
  const state = {
    version: 1,
    rngState: seed >>> 0,
    round: 0,
    players: names.map((n, seat) => ({ seat, name: n, village: [], known: [], total: 0 })),
    teams: [{ score: 0 }, { score: 0 }],
    deck: [], discard: [], squire: [],
    amulet: { holder: null, card: null },
    guards: {},
    current: 0,
    phase: "roundOver",
    pending: null,
    turn: { empathUsed: 0, amuletPlaced: false },
    caller: null,
    finalTurns: 0,
    history: [],
    lastRound: null,
    log: [],
  };
  state.amulet.holder = Math.floor(rng(state) * 4);
  return startRound(state);
}

function startRound(state) {
  state.round += 1;
  state.deck = freshDeck(state);
  state.discard = [];
  state.squire = [];
  state.guards = {};
  state.amulet.card = null;
  state.caller = null;
  state.finalTurns = 0;
  for (const p of state.players) {
    p.village = state.deck.splice(0, 5);
    p.known = [p.village[0].id, p.village[1].id];   // each player has looked at two of their cards
  }
  const first = state.deck.shift();
  first.up = true;
  state.discard.push(first);
  state.current = state.amulet.holder;
  state.phase = "turn";
  state.pending = null;
  state.turn = { empathUsed: 0, amuletPlaced: false };
  log(state, `Round ${state.round} begins. ${name(state, state.current)} starts.`);
  return state;
}

// ---------------------------------------------------------------- exchanges

/**
 * Puts `incoming` into `seat`'s village in exchange for the cards `cardIds`.
 * One card: always works. Several: they must share a value (Doppelgängers match
 * anything). A failed set is turned face-down again (everyone saw it), the new
 * card is added at the end, and with 3+ cards an unseen penalty card too.
 */
function exchange(state, seat, incoming, cardIds, incomingUp) {
  const village = state.players[seat].village;
  if (!cardIds.length) fail("Choose at least one of your cards to exchange.");
  if (new Set(cardIds).size !== cardIds.length) fail("Each card only once.");
  const picked = cardIds.map((id) => {
    const i = village.findIndex((c) => c.id === id);
    if (i < 0) fail("You can only exchange cards from your own village.");
    if (state.amulet.card === id) fail("The card under the Amulet can't be moved.");
    return village[i];
  });
  incoming.up = incomingUp;
  const plain = picked.filter((c) => c.v !== 13).map((c) => c.v);
  const matches = picked.length === 1 || plain.every((v) => v === plain[0]);
  if (matches) {
    const slot = village.findIndex((c) => c.id === picked[0].id);
    state.players[seat].village = village.filter((c) => !cardIds.includes(c.id));
    state.players[seat].village.splice(Math.min(slot, state.players[seat].village.length), 0, incoming);
    // Doppelgängers go beneath the other discarded cards.
    const sorted = [...picked.filter((c) => c.v === 13), ...picked.filter((c) => c.v !== 13)];
    for (const c of sorted) { c.up = true; state.discard.push(c); }
    for (const id of cardIds) state.guards[seat] = (state.guards[seat] ?? []).filter((g) => g !== id);
    log(state, `${name(state, seat)} exchanged ${picked.length > 1 ? `a set of ${picked.length}` : "a card"} (${picked.map((c) => c.v).join(", ")}).`);
    return true;
  }
  for (const c of picked) { c.up = false; learnAll(state, c.id); }
  village.push(incoming);
  if (picked.length >= 3 && state.deck.length) village.push({ ...state.deck.shift(), up: false });
  log(state, `${name(state, seat)} tried a set that didn't match (${picked.map((c) => c.v).join(", ")}) and takes ${picked.length >= 3 ? "two extra cards" : "an extra card"}.`);
  return false;
}

// ---------------------------------------------------------------- actions

/** Actions available to `seat` right now (types only; arguments are chosen by the UI/bot). */
export function legalTypes(state, seat) {
  if (state.phase === "roundOver") return ["nextRound"];
  if (state.phase === "gameOver" || seat !== state.current) return [];
  const p = state.players[seat];
  const out = [];
  if (state.phase === "turn") {
    if (state.deck.length) out.push("draw");
    if (state.squire.length) out.push("takeSquire");
    if (state.discard.length && p.village.some((c) => c.id !== state.amulet.card)) out.push("takeDiscard");
    if (state.caller === null && p.village.length <= 4 && !state.turn.amuletPlaced) out.push("call");
    if (state.amulet.holder === seat && state.amulet.card === null && state.caller === null) out.push("placeAmulet");
    if (countUp(p.village, 3) > 0) out.push("guard");
    if (state.turn.empathUsed < countUp(p.village, 2)) out.push("empath");
  } else if (state.phase === "rascal") out.push("rascalKeep");
  else if (state.phase === "drawn") out.push("discardDrawn", "exchange");
  else if (state.phase === "power") out.push(`power${state.pending.power}`, "skipPower");
  return out;
}

export function act(prev, seat, action) {
  const state = clone(prev);
  const allowed = legalTypes(state, seat);
  if (!allowed.includes(action.type)) fail(seat !== state.current && state.phase !== "roundOver" ? "It's not your turn." : `You can't do that now (${action.type}).`);
  const p = state.players[seat];
  switch (action.type) {
    case "nextRound": {
      if (state.round >= ROUNDS) fail("The game is over.");
      return startRound(state);
    }
    case "placeAmulet": {
      const f = findCard(state, action.cardId);
      if (!f || f.owner !== seat) fail("Place the Amulet on one of your own cards.");
      state.amulet.card = action.cardId;
      state.turn.amuletPlaced = true;
      log(state, `${p.name} placed the Amulet on one of their cards.`);
      return state;
    }
    case "guard": {
      const ids = action.cardIds ?? [];
      if (ids.length > countUp(p.village, 3)) fail("One protected card per face-up Bodyguard.");
      for (const id of ids) { const f = findCard(state, id); if (!f || f.owner !== seat) fail("Protect your own cards."); }
      state.guards[seat] = ids;
      return state;
    }
    case "empath": {
      const f = findCard(state, action.cardId);
      if (!f || f.owner !== seat || f.card.up || state.amulet.card === f.card.id) fail("Pick one of your face-down cards.");
      learn(state, seat, f.card.id);
      state.turn.empathUsed++;
      return state;
    }
    case "call": {
      state.caller = seat;
      state.finalTurns = 3;
      log(state, `${p.name} calls for a vote! Everyone else gets one last turn.`);
      return endTurn(state, false);
    }
    case "draw": {
      const extra = Math.min(countUp(p.village, 4), state.deck.length - 1);
      const cards = state.deck.splice(0, 1 + Math.max(0, extra));
      cards.forEach((c) => learn(state, seat, c.id));
      if (cards.length > 1) { state.phase = "rascal"; state.pending = { cards }; }
      else { state.phase = "drawn"; state.pending = { card: cards[0], from: "deck" }; }
      return state;
    }
    case "rascalKeep": {
      const cards = state.pending.cards;
      const keep = cards[action.index] ?? fail("Choose one of the drawn cards.");
      const rest = cards.filter((_, i) => i !== action.index);
      state.deck.unshift(...rest.map((c) => ({ ...c, up: false })));
      state.phase = "drawn";
      state.pending = { card: keep, from: "deck" };
      return state;
    }
    case "takeSquire": {
      const card = state.squire[action.index] ?? fail("Choose one of the face-up cards beside the deck.");
      state.squire.splice(action.index, 1);
      state.phase = "drawn";
      state.pending = { card, from: "squire" };
      return state;
    }
    case "takeDiscard": {
      const card = state.discard.pop();
      try { exchange(state, seat, card, action.cardIds ?? [], true); }
      catch (e) { state.discard.push(card); throw e; }
      return endTurn(state);
    }
    case "discardDrawn": {
      const { card, from } = state.pending;
      card.up = true;
      state.discard.push(card);
      const canUse = action.usePower && from === "deck" && card.v >= 5 && card.v <= 12 && state.caller !== seat;
      if (canUse) {
        state.phase = "power";
        state.pending = { power: card.v };
        if (card.v === 11 && state.deck.length) { state.pending.top = state.deck[0].id; learn(state, seat, state.deck[0].id); }
        log(state, `${p.name} discards a ${card.v} and uses the ${POWERS[card.v].name}.`);
        return state;
      }
      log(state, `${p.name} discards a ${card.v}.`);
      return endTurn(state);
    }
    case "exchange": {
      const { card, from } = state.pending;
      exchange(state, seat, card, action.cardIds ?? [], from === "squire");
      return endTurn(state);
    }
    case "skipPower":
      return endTurn(state);
    default:
      return power(state, seat, action);
  }
}

function power(state, seat, action) {
  const target = (id, { own = null, faceDown = true } = {}) => {
    const f = findCard(state, id) ?? fail("Pick a card in a village.");
    if (own === true && f.owner !== seat) fail("Pick one of your own cards.");
    if (own === false && f.owner === seat) fail("Pick a card in another player's village.");
    if (faceDown && f.card.up) fail("Pick a face-down card.");
    if (isProtected(state, f.card, seat) || (state.amulet.card === f.card.id)) fail("That card is protected.");
    return f;
  };
  const p = state.players[seat];
  switch (action.type) {
    case "power5": { const f = target(action.cardId, { own: true }); f.card.up = true; log(state, `${p.name} turns up their ${f.card.v}.`); break; }
    case "power6": { const f = target(action.cardId); f.card.up = true; log(state, `${p.name} reveals a ${f.card.v} in ${name(state, f.owner)}'s village.`); break; }
    case "power7": {
      const ids = action.cardIds ?? [];
      if (!ids.length || ids.length > 2) fail("Pick one or two of your face-down cards.");
      ids.forEach((id) => learn(state, seat, target(id, { own: true }).card.id));
      break;
    }
    case "power8": { const f = target(action.cardId, { own: false }); learn(state, seat, f.card.id); log(state, `${p.name} peeks at a card in ${name(state, f.owner)}'s village.`); break; }
    case "power9": { const f = target(action.cardId); learn(state, seat, f.card.id); log(state, `${p.name} peeks at a card.`); break; }
    case "power10": {
      const idx = state.discard.findIndex((c) => c.id === action.discardId);
      if (idx < 0 || idx === state.discard.length - 1) fail("Pick a card from the discard pile (not the Master itself).");
      const [card] = state.discard.splice(idx, 1);
      try { exchange(state, seat, card, action.cardIds ?? [], true); }
      catch (e) { state.discard.splice(idx, 0, card); throw e; }
      break;
    }
    case "power11": {
      if (!state.deck.length) fail("The deck is empty.");
      const top = state.deck[0];
      if (action.cardId) {
        const f = target(action.cardId, { own: false, faceDown: false });
        state.deck.shift();
        const replaced = f.card;
        replaced.up = true;
        state.discard.push(replaced);
        top.up = false;
        state.players[f.owner].village[f.index] = top;
        log(state, `${p.name} uses the Witch on ${name(state, f.owner)}'s village (out goes a ${replaced.v}).`);
      } else {
        state.deck.shift();
        try { exchange(state, seat, top, action.cardIds ?? [], false); }
        catch (e) { state.deck.unshift(top); throw e; }
      }
      break;
    }
    case "power12": {
      const theirs = target(action.theirId, { own: false, faceDown: false });
      const mine = findCard(state, action.myId);
      if (!mine || mine.owner !== seat || state.amulet.card === mine.card.id) fail("Pick one of your own cards to give.");
      state.players[theirs.owner].village[theirs.index] = mine.card;
      state.players[seat].village[mine.index] = theirs.card;
      learn(state, seat, theirs.card.id);
      log(state, `${p.name} robs a card from ${name(state, theirs.owner)}.`);
      break;
    }
    default: fail("Unknown action.");
  }
  return endTurn(state);
}

// ---------------------------------------------------------------- turn & round end

function villagersUp(state) {
  return state.players.reduce((n, p) => n + countUp(p.village, 0), 0) >= 2;
}

function endTurn(state, countFinal = true) {
  state.phase = "turn";
  state.pending = null;
  // Squires: keep one face-up card beside the deck per face-up Squire in any village.
  const want = state.players.reduce((n, p) => n + countUp(p.village, 1), 0);
  while (state.squire.length < want && state.deck.length) state.squire.push({ ...state.deck.shift(), up: true });
  while (state.squire.length > want) state.discard.push(state.squire.shift());
  if (villagersUp(state)) { log(state, "Both Villagers are face-up — the round ends!"); return endRound(state); }
  if (state.caller !== null && countFinal && state.current !== state.caller) {
    state.finalTurns -= 1;
    if (state.finalTurns <= 0) return endRound(state);
  }
  // House rule: the round ends as soon as the deck runs out (the rulebook lets play
  // continue with the Squires' face-up cards, which can stall if nobody takes them).
  if (!state.deck.length) { log(state, "The deck is empty — the round ends."); return endRound(state); }
  state.current = (state.current + 1) % 4;
  state.turn = { empathUsed: 0, amuletPlaced: false };
  return state;
}

function endRound(state) {
  const sums = state.players.map((p) => p.village.reduce((s, c) => s + c.v, 0));
  const teamSum = [sums[0] + sums[2], sums[1] + sums[3]];
  const roundScore = [...teamSum];
  let callerResult = null;
  if (state.caller !== null) {
    const ct = teamOf(state.caller), other = 1 - ct;
    const success = teamSum[ct] <= teamSum[other];
    roundScore[ct] = success ? 0 : teamSum[ct] + 10;
    callerResult = { seat: state.caller, success };
  }
  state.teams.forEach((t, i) => (t.score += roundScore[i]));
  state.players.forEach((p, i) => { p.total += sums[i]; p.village.forEach((c) => (c.up = true)); });
  // Amulet: a successful caller takes it; otherwise the lowest player on the lowest-scoring team.
  let holder;
  if (callerResult?.success) holder = state.caller;
  else {
    const best = roundScore[0] === roundScore[1] ? null : roundScore[0] < roundScore[1] ? 0 : 1;
    const seats = best === null ? [0, 1, 2, 3] : [best, best + 2];
    const low = Math.min(...seats.map((s) => sums[s]));
    const tied = seats.filter((s) => sums[s] === low);
    holder = tied.includes(state.amulet.holder) ? state.amulet.holder : tied[0];
  }
  state.amulet = { holder, card: null };
  state.lastRound = { round: state.round, sums, teamSum, roundScore, caller: callerResult };
  state.history.push(state.lastRound);
  log(state, `Round ${state.round} over. Team scores this round: ${roundScore[0]} – ${roundScore[1]}.`);
  if (state.round >= ROUNDS) {
    const [a, b] = state.teams.map((t) => t.score);
    state.winner = a === b ? teamOf(holder) : a < b ? 0 : 1;
    state.phase = "gameOver";
  } else state.phase = "roundOver";
  state.pending = null;
  return state;
}

/** The state as `seat` may see it: other players' hidden cards are masked. */
export function viewFor(state, seat) {
  const v = clone(state);
  const known = new Set(state.players[seat].known);
  const mask = (c) => (c.up || known.has(c.id) ? c : { id: c.id, v: null, up: false });
  for (const p of v.players) { p.village = p.village.map(mask); if (p.seat !== seat) p.known = []; }
  v.deck = v.deck.map((c) => ({ id: c.id, v: known.has(c.id) ? c.v : null, up: false }));
  if (v.pending?.cards && seat !== state.current) v.pending.cards = v.pending.cards.map(() => ({ v: null }));
  if (v.pending?.card && seat !== state.current && !v.pending.card.up) v.pending.card = { v: null };
  return v;
}
