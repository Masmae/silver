// Tunes the strategic bot's judgment numbers by self-play: one number at a time, a nudged version
// plays 600 games against the current best (teams swapped every game, same deals), and the change
// is kept only if it clearly wins. Prints the tuned numbers for js/bot.js.
//   nice node tools/tune.mjs [games=600] [passes=2]
import { newGame, act, teamOf } from "../js/engine.js";
import { chooseAction, DEFAULTS } from "../js/bot.js";

const GAMES = Number(process.argv[2] ?? 600), PASSES = Number(process.argv[3] ?? 2);

function match(A, B, games, seed0) {
  let winsA = 0, margin = 0;
  for (let g = 0; g < games; g++) {
    const aTeam = g % 2;
    let s = newGame({ seed: seed0 + Math.floor(g / 2) });
    while (s.phase !== "gameOver") {
      if (s.phase === "roundOver") { s = act(s, 0, { type: "nextRound" }); continue; }
      const seat = s.current;
      s = act(s, seat, chooseAction(s, seat, teamOf(seat) === aTeam ? A : B));
    }
    if (s.winner === aTeam) winsA++;
    margin += s.teams[1 - aTeam].score - s.teams[aTeam].score;
  }
  return { rate: winsA / games, margin: margin / games };
}

let best = { ...DEFAULTS };
let seed = 5000;
for (let pass = 0; pass < PASSES; pass++) {
  for (const key of Object.keys(best)) {
    const v = best[key];
    const tries = Number.isInteger(v) && v >= 2 ? [v - 1, v + 1] : [v * 0.5, v * 1.6];
    for (const t of tries) {
      const cand = { ...best, [key]: Math.round(t * 100) / 100 };
      const r = match(cand, best, GAMES, (seed += GAMES));
      const keep = r.rate > 0.53 && r.margin > 0;
      console.log(`${key} ${v} → ${cand[key]}: wins ${(100 * r.rate).toFixed(1)}%, margin ${r.margin.toFixed(1)}${keep ? "  ✓ kept" : ""}`);
      if (keep) { best = cand; break; }
    }
  }
}
const final = match(best, DEFAULTS, GAMES * 2, 900000);
console.log(`\ntuned vs original: wins ${(100 * final.rate).toFixed(1)}%, margin ${final.margin.toFixed(1)} points/game`);
console.log(JSON.stringify(best, null, 2));
