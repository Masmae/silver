import { test } from "node:test";
import assert from "node:assert/strict";
import { newGame, act, viewFor, GameError, teamOf, ROUNDS } from "../js/engine.js";
import { chooseAction } from "../js/bot.js";
import { chooseAction as basicAction } from "../js/bot-basic.js";

function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function allCards(s) {
  const cards = [...s.deck, ...s.discard, ...s.squire, ...s.players.flatMap((p) => p.village)];
  if (s.pending?.card) cards.push(s.pending.card);
  if (s.pending?.cards) cards.push(...s.pending.cards);
  return cards;
}

function playGame(seed) {
  const rand = seeded(seed);
  let s = newGame({ seed });
  let steps = 0, roundsSeen = 0;
  while (s.phase !== "gameOver") {
    assert.ok(++steps < 20000, `game ${seed} did not finish`);
    if (s.phase !== "roundOver" && s.phase !== "gameOver") {
      const cards = allCards(s);
      assert.equal(cards.length, 52, `game ${seed} step ${steps}: ${cards.length} cards`);
      assert.equal(new Set(cards.map((c) => c.id)).size, 52, `game ${seed}: duplicate card`);
    }
    if (s.phase === "roundOver") roundsSeen++;
    const seat = s.phase === "roundOver" ? 0 : s.current;
    const a = chooseAction(s, seat, rand);
    assert.ok(a, `no action for seat ${seat} in phase ${s.phase}`);
    s = act(s, seat, a);
  }
  return { s, steps };
}

test("300 bot games: cards conserved, every game ends, scores add up", () => {
  let calls = 0, successes = 0, steps = 0;
  const wins = [0, 0];
  for (let g = 1; g <= 300; g++) {
    const { s, steps: n } = playGame(g);
    steps += n;
    assert.equal(s.history.length, ROUNDS);
    for (const t of [0, 1]) assert.equal(s.teams[t].score, s.history.reduce((sum, r) => sum + r.roundScore[t], 0));
    for (const r of s.history) {
      assert.deepEqual(r.teamSum, [r.sums[0] + r.sums[2], r.sums[1] + r.sums[3]]);
      if (r.caller) { calls++; if (r.caller.success) successes++; }
    }
    wins[s.winner]++;
  }
  console.log(`avg moves/game ${(steps / 300).toFixed(0)}, calls ${calls} (${successes} successful), wins by team ${wins}`);
});

test("hidden cards stay hidden in each player's view", () => {
  const s = newGame({ seed: 7 });
  for (let seat = 0; seat < 4; seat++) {
    const v = viewFor(s, seat);
    for (const p of v.players) {
      p.village.forEach((c, i) => {
        const real = s.players[p.seat].village[i];
        if (p.seat === seat && i < 2) assert.equal(c.v, real.v, "you know your first two cards");
        else if (!real.up && !s.players[seat].known.includes(real.id)) assert.equal(c.v, null, "others' face-down cards are masked");
      });
    }
    assert.ok(v.deck.every((c) => c.v === null), "deck is masked");
  }
});

test("illegal moves are rejected", () => {
  const s = newGame({ seed: 3 });
  const other = (s.current + 1) % 4;
  assert.throws(() => act(s, other, { type: "draw" }), GameError);
  assert.throws(() => act(s, s.current, { type: "call" }), GameError, "can't call with 5 cards");
  const drawn = act(s, s.current, { type: "draw" });
  assert.throws(() => act(drawn, s.current, { type: "exchange", cardIds: [s.players[other].village[0].id] }), GameError, "only your own cards");
});

test("a failed multi-card swap adds the card and turns the set face-down", () => {
  let s = newGame({ seed: 11 });
  const seat = s.current;
  const p = s.players[seat];
  // Force two different values into the first two slots for a deterministic test.
  p.village[0].v = 2; p.village[1].v = 9;
  s = act(s, seat, { type: "draw" });
  const before = s.players[seat].village.length;
  s = act(s, seat, { type: "exchange", cardIds: [p.village[0].id, p.village[1].id] });
  assert.equal(s.players[seat].village.length, before + 1);
  assert.ok(s.players.every((pl) => pl.known.includes(p.village[0].id)), "everyone saw the failed set");
});

test("team scoring: caller's team scores 0 when lowest, else total + 10", () => {
  let s = newGame({ seed: 5 });
  const seat = s.current;
  s.players[seat].village.pop();                       // 4 cards so a call is allowed
  s = act(s, seat, { type: "call" });
  while (s.phase !== "roundOver" && s.phase !== "gameOver") s = act(s, s.current, chooseAction(s, s.current, () => 0.5));
  const r = s.lastRound, ct = teamOf(seat);
  assert.equal(r.roundScore[ct], r.caller.success ? 0 : r.teamSum[ct] + 10);
  assert.equal(r.roundScore[1 - ct], r.teamSum[1 - ct]);
});

test("the strategic bots beat the original bots (both seatings)", () => {
  let smartWins = 0, games = 0, margin = 0;
  for (let g = 1; g <= 200; g++) {
    for (const smartTeam of [0, 1]) {
      const rand = seeded(g * 7 + smartTeam);
      let s = newGame({ seed: g * 13 + smartTeam });
      for (let steps = 0; s.phase !== "gameOver" && steps < 20000; steps++) {
        const seat = s.phase === "roundOver" ? 0 : s.current;
        const a = teamOf(seat) === smartTeam ? chooseAction(s, seat) : basicAction(s, seat, rand);
        s = act(s, seat, a);
      }
      assert.equal(s.phase, "gameOver");
      games++;
      if (s.winner === smartTeam) smartWins++;
      margin += s.teams[1 - smartTeam].score - s.teams[smartTeam].score;
    }
  }
  console.log(`strategic bots won ${smartWins}/${games} (${Math.round((100 * smartWins) / games)}%), average margin ${(margin / games).toFixed(1)} points/game`);
  assert.ok(smartWins / games > 0.6, "strategic bots should clearly beat the original ones");
});
