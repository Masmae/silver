// Silver table UI (you vs three computer players). Online play can reuse the same
// engine by sending actions instead of applying them locally.
import { newGame, act, viewFor, legalTypes, POWERS, FACES, teamOf, ROUNDS, GameError } from "./engine.js";
import { chooseAction } from "./bot.js";

const ME = 0;
const SAVE = "silver.game.v1";
const SETTINGS = "silver.settings.v1";
const REVEAL_MS = 4000;          // how long a peeked card stays visible before flipping back
const START_REVEAL_MS = 6000;    // memorise your two cards at the start of a round
const SPEEDS = { relaxed: [1800, 1200], normal: [1200, 800], fast: [600, 400] };

const app = document.getElementById("app");
const saved = load(SAVE, (s) => s?.version === 1);
let state = saved ?? newGame({ names: ["You", "West", "Partner", "East"] });
let settings = { speed: "relaxed", ...(load(SETTINGS, (s) => s && typeof s === "object") ?? {}) };
let ui = { mode: null, sel: [], pick: {}, note: "" };
let botTimer = null, revealTimer = null;
let panel = null;                 // "rules" | "settings" | null
const reveal = new Map();         // cardId -> time it flips back face-down (memory play)
// A resumed game doesn't flash old knowledge again; a new game shows your two cards.
let knownBefore = new Set(saved ? state.players[ME].known : []);
let lastBotLine = "";
let memorizeUntil = saved ? 0 : Date.now() + START_REVEAL_MS;   // start-of-round memorising window

function load(key, ok) { try { const v = JSON.parse(localStorage.getItem(key)); return ok(v) ? v : null; } catch { return null; } }
function persist() { try { localStorage.setItem(SAVE, JSON.stringify(state)); localStorage.setItem(SETTINGS, JSON.stringify(settings)); } catch { /* ignore */ } }

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};

// ---------------------------------------------------------------- memory: temporary reveals

/** Anything you just learned is shown briefly, then hidden again — Silver is a memory game. */
function noteNewKnowledge(ms = REVEAL_MS) {
  const now = Date.now();
  const known = new Set(state.players[ME].known);
  for (const id of known) if (!knownBefore.has(id)) reveal.set(id, now + ms);
  knownBefore = known;
  scheduleRevealExpiry();
}
function scheduleRevealExpiry() {
  clearTimeout(revealTimer);
  const now = Date.now();
  for (const [id, t] of reveal) if (t <= now) reveal.delete(id);
  if (!reveal.size) return;
  const next = Math.min(...reveal.values());
  revealTimer = setTimeout(() => { scheduleRevealExpiry(); render(); }, next - now + 20);
}
const revealed = (id) => (reveal.get(id) ?? 0) > Date.now();
const memorizing = () => Date.now() < memorizeUntil;

function setState(next) {
  const newRound = next.round !== state.round || next.version !== state.version;
  state = next;
  if (newRound) { knownBefore = new Set(); reveal.clear(); memorizeUntil = Date.now() + START_REVEAL_MS; noteNewKnowledge(START_REVEAL_MS); }
  else noteNewKnowledge();
  persist();
}

// ---------------------------------------------------------------- actions

function doAction(action) {
  try {
    setState(act(state, ME, action));
    ui = { mode: null, sel: [], pick: {}, note: "" };
    lastBotLine = "";
    render();
    scheduleBots();
  } catch (e) {
    if (!(e instanceof GameError)) throw e;
    ui.note = e.message;
    render();
  }
}

function scheduleBots() {
  clearTimeout(botTimer);
  if (state.phase === "gameOver" || state.phase === "roundOver" || state.current === ME) return;
  const [turnDelay, stepDelay] = SPEEDS[settings.speed] ?? SPEEDS.relaxed;
  // Let the human memorise their cards before the bots start.
  const wait = Math.max(0, memorizeUntil - Date.now());
  botTimer = setTimeout(() => {
    const seat = state.current;
    const action = chooseAction(state, seat);
    const logLen = state.log.length;
    if (action) setState(act(state, seat, action));
    const fresh = state.log.slice(logLen).filter((l) => !l.startsWith("Round"));
    if (fresh.length) lastBotLine = fresh.join(" ");
    render();
    scheduleBots();
  }, wait + (state.phase === "turn" ? turnDelay : stepDelay));
}

// ---------------------------------------------------------------- cards

function typeClass(v) { return v === 13 ? "t-dopp" : v <= 4 ? "t-village" : "t-power"; }

/**
 * A card. `show` decides whether its face is visible to you right now: face-up
 * cards always, cards you just peeked at for a few seconds, otherwise the back.
 */
function cardEl(card, { size = "sm", show = card.up, onclick = null, selected = false, target = false, badge = null, peek = false } = {}) {
  const face = show && card.v !== null && card.v !== undefined;
  const cls = ["card", size, face ? `face ${typeClass(card.v)}` : "back", peek && face ? "peek" : "", onclick ? "click" : "", selected ? "sel" : "", target ? "target" : ""].filter(Boolean).join(" ");
  const label = face ? `${card.v} ${POWERS[card.v].name}${card.up ? "" : " (peeking)"}` : "face-down card";
  return h("button", { class: cls, onclick, "aria-label": label, disabled: onclick ? null : true },
    face ? [
      h("span", { class: "n" }, card.v),
      h("span", { class: "ic", "aria-hidden": "true" }, FACES[card.v].icon),
      h("span", { class: "nm" }, POWERS[card.v].name),
      size !== "sm" ? h("span", { class: "tx" }, FACES[card.v].short) : null,
    ] : null,
    badge);
}

// ---------------------------------------------------------------- interaction per mode

const myTurn = () => state.current === ME && state.phase !== "roundOver" && state.phase !== "gameOver";

function onCard(owner, card) {
  const mode = ui.mode;
  ui.note = "";
  if (owner === ME) {
    if (["takeDiscard", "exchange", "power10", "power11"].includes(mode)) {
      ui.sel = ui.sel.includes(card.id) ? ui.sel.filter((x) => x !== card.id) : [...ui.sel, card.id];
      return render();
    }
    if (mode === "amulet") return doAction({ type: "placeAmulet", cardId: card.id });
    if (mode === "guard") return doAction({ type: "guard", cardIds: [card.id] });
    if (mode === "empath") return doAction({ type: "empath", cardId: card.id });
    if (mode === "power5") return doAction({ type: "power5", cardId: card.id });
    if (mode === "power7") { ui.sel = ui.sel.includes(card.id) ? ui.sel.filter((x) => x !== card.id) : [...ui.sel, card.id].slice(-2); return render(); }
    if (mode === "power6" || mode === "power9") return doAction({ type: mode, cardId: card.id });
    if (mode === "power12") { ui.pick.myId = card.id; return maybeRob(); }
  } else {
    if (["power6", "power8", "power9"].includes(mode)) return doAction({ type: mode, cardId: card.id });
    if (mode === "power11") return doAction({ type: "power11", cardId: card.id });
    if (mode === "power12") { ui.pick.theirId = card.id; return maybeRob(); }
  }
}
function maybeRob() {
  if (ui.pick.myId && ui.pick.theirId) return doAction({ type: "power12", theirId: ui.pick.theirId, myId: ui.pick.myId });
  render();
}

function clickable(owner, card) {
  if (!myTurn() || !ui.mode) return false;
  const mode = ui.mode, own = owner === ME, down = !card.up;
  const blocked = state.amulet.card === card.id || (!own && (state.guards[owner] ?? []).includes(card.id));
  if (blocked) return false;
  if (["takeDiscard", "exchange", "power10", "power11"].includes(mode) && own) return true;
  if (mode === "amulet" || mode === "guard") return own;
  if (["empath", "power5", "power7"].includes(mode)) return own && down;
  if (mode === "power6" || mode === "power9") return down;
  if (mode === "power8") return !own && down;
  if (mode === "power11") return !own;
  if (mode === "power12") return true;
  return false;
}

// ---------------------------------------------------------------- render pieces

function seatEl(view, seat, where) {
  const p = view.players[seat];
  const us = teamOf(seat) === teamOf(ME);
  const ended = state.phase === "roundOver" || state.phase === "gameOver";
  const isTurn = state.current === seat && !ended;
  const tags = [];
  if (state.amulet.holder === seat) tags.push(h("span", { class: "tag gold" }, state.amulet.card ? "Amulet ●" : "Amulet"));
  if (state.caller === seat) tags.push(h("span", { class: "tag gold" }, "Called"));
  const size = where === "bottom" ? "lg" : "sm";
  return h("div", { class: `seat ${where}${isTurn ? " turn" : ""}` },
    h("div", { class: "seat-head" }, h("span", { class: `dot ${us ? "us" : "them"}` }), h("span", { class: "name" }, p.name), h("span", { class: "count" }, `${p.village.length}`), ...tags),
    h("div", { class: "row" }, p.village.map((c) => {
      const real = state.players[seat].village.find((x) => x.id === c.id);
      const can = clickable(seat, real);
      const show = real.up || ended || (revealed(real.id) && c.v !== null);
      const badge = state.amulet.card === c.id ? h("span", { class: "badge" }, "A") : (state.guards[seat] ?? []).includes(c.id) ? h("span", { class: "badge guard" }, "🛡") : null;
      return cardEl(ended ? real : c, {
        size, show, onclick: can ? () => onCard(seat, real) : null, peek: !real.up && !ended,
        selected: ui.sel.includes(c.id) || ui.pick.myId === c.id || ui.pick.theirId === c.id, target: can, badge,
      });
    })));
}

function centerEl() {
  const top = state.discard.at(-1);
  const pending = state.pending;
  const kids = [
    h("div", { class: "pile" }, cardEl({ v: null, up: false }, { size: "md" }), h("span", {}, `Deck ${state.deck.length}`)),
    h("div", { class: "pile" }, top ? cardEl(top, { size: "md" }) : h("div", { class: "card md back" }), h("span", {}, "Discard")),
  ];
  if (state.squire.length) {
    const canTake = myTurn() && state.phase === "turn" && !ui.mode && !memorizing();
    kids.push(h("div", { class: "pile squire" + (canTake ? " live" : "") },
      h("div", { class: "row" }, state.squire.map((c, i) => cardEl(c, { size: "md", onclick: canTake ? () => doAction({ type: "takeSquire", index: i }) : null, target: canTake }))),
      h("span", {}, canTake ? "⚔️ Squire: tap to take" : "⚔️ Squire")));
  }
  if (myTurn() && state.phase === "rascal") kids.push(h("div", { class: "pile drawn" }, h("div", { class: "row" }, pending.cards.map((c, i) => cardEl({ ...c, up: true }, { size: "md", onclick: () => doAction({ type: "rascalKeep", index: i }), target: true }))), h("span", {}, "😈 Rascal: keep one")));
  if (myTurn() && state.phase === "drawn") kids.push(h("div", { class: "pile drawn" }, cardEl({ ...pending.card, up: true }, { size: "md" }), h("span", {}, "You drew")));
  if (myTurn() && state.phase === "power" && pending.power === 11 && state.deck[0]) kids.push(h("div", { class: "pile drawn" }, cardEl({ ...state.deck[0], up: true }, { size: "md" }), h("span", {}, "Top of deck")));
  return h("div", { class: "center" }, kids);
}

function promptLines() {
  const name = (s) => state.players[s].name;
  if (state.phase === "gameOver" || state.phase === "roundOver") return [""];
  if (memorizing()) return ["Memorize your two cards!", "They flip face-down in a few seconds."];
  if (!myTurn()) return [lastBotLine || `${name(state.current)} is thinking…`, state.caller !== null ? `${name(state.caller)} called — last turns.` : ""];
  const m = ui.mode, pw = state.pending?.power;
  if (state.phase === "turn") {
    if (m === "takeDiscard") return [`Take the ${state.discard.at(-1).v}: choose which of your cards it replaces.`, "Several cards of the same value can go out together (13 is wild)."];
    if (m === "amulet") return ["Choose one of your cards to protect with the Amulet."];
    if (m === "guard") return ["Choose one of your cards for the Bodyguard to protect."];
    if (m === "empath") return ["Choose one of your face-down cards to peek at."];
    return [state.caller !== null ? `${name(state.caller)} called — this is your last turn!` : "Your turn: draw, take the discard, or call.", lastBotLine];
  }
  if (state.phase === "rascal") return ["Rascal: choose which drawn card to keep."];
  if (state.phase === "drawn") {
    const c = state.pending.card;
    if (m === "exchange") return [`Choose which of your cards the ${c.v} replaces.`, "Several cards of the same value can go out together (13 is wild)."];
    return [`You drew a ${c.v} — ${POWERS[c.v].name}.`, c.v >= 5 && c.v <= 12 ? "Keep it, or discard it to use its power." : "Keep it, or discard it."];
  }
  if (state.phase === "power") {
    return [{
      5: "Exposer: tap one of your face-down cards to turn it face-up.",
      6: "Revealer: tap any face-down card to turn it face-up.",
      7: "Beholder: choose up to two of your face-down cards to look at.",
      8: "Apprentice Seer: tap a face-down card in an opponent's village.",
      9: "Seer: tap any face-down card to look at it.",
      10: ui.pick.discardId ? "Master: now choose which of your cards it replaces." : "Master: choose a card from the discard pile.",
      11: `Witch: the top card is a ${state.deck[0]?.v}. Tap a card in another village to swap it there, or select your own cards.`,
      12: "Robber: tap one of your cards to give and one card in another village to take.",
    }[pw]];
  }
  return [""];
}

function controls() {
  const types = legalTypes(state, ME);
  const btn = (label, onclick, cls = "btn", disabled = false) => h("button", { class: cls, onclick, disabled }, label);
  const cancel = () => btn("Cancel", () => { ui = { mode: null, sel: [], pick: {}, note: "" }; render(); });
  if (!myTurn() || memorizing()) return [];
  if (state.phase === "turn") {
    if (ui.mode === "takeDiscard") return [btn("Exchange", () => doAction({ type: "takeDiscard", cardIds: ui.sel }), "btn primary", !ui.sel.length), cancel()];
    if (ui.mode) return [cancel()];
    const out = [];
    if (types.includes("draw")) out.push(btn("Draw", () => doAction({ type: "draw" }), "btn primary"));
    if (types.includes("takeDiscard")) out.push(btn(`Take the ${state.discard.at(-1).v}`, () => { ui.mode = "takeDiscard"; ui.sel = []; render(); }));
    if (types.includes("call")) out.push(btn("Call vote", () => { if (confirm("Call for a vote? Everyone else gets one last turn, then the lowest team total wins the round.")) doAction({ type: "call" }); }, "btn warn"));
    if (types.includes("placeAmulet")) out.push(btn("Place Amulet", () => { ui.mode = "amulet"; render(); }));
    if (types.includes("guard")) out.push(btn("🛡️ Bodyguard", () => { ui.mode = "guard"; render(); }));
    if (types.includes("empath")) out.push(btn("💞 Empath peek", () => { ui.mode = "empath"; render(); }));
    return out;
  }
  if (state.phase === "drawn") {
    const c = state.pending.card;
    if (ui.mode === "exchange") return [btn("Exchange", () => doAction({ type: "exchange", cardIds: ui.sel }), "btn primary", !ui.sel.length), cancel()];
    const power = c.v >= 5 && c.v <= 12 && state.caller !== ME;
    return [
      btn("Keep it…", () => { ui.mode = "exchange"; ui.sel = []; render(); }, "btn primary"),
      power ? btn(`${FACES[c.v].icon} Use ${POWERS[c.v].name}`, () => doAction({ type: "discardDrawn", usePower: true })) : null,
      btn("Discard", () => doAction({ type: "discardDrawn", usePower: false })),
    ].filter(Boolean);
  }
  if (state.phase === "power") {
    const pw = state.pending.power;
    if (!ui.mode) ui.mode = `power${pw}`;
    const out = [];
    if (pw === 7) out.push(btn("Look", () => doAction({ type: "power7", cardIds: ui.sel }), "btn primary", !ui.sel.length));
    if (pw === 10 && ui.pick.discardId) out.push(btn("Exchange", () => doAction({ type: "power10", discardId: ui.pick.discardId, cardIds: ui.sel }), "btn primary", !ui.sel.length));
    if (pw === 11) out.push(btn("Swap for my selected", () => doAction({ type: "power11", cardIds: ui.sel }), "btn primary", !ui.sel.length));
    out.push(btn("Skip power", () => doAction({ type: "skipPower" })));
    return out;
  }
  return [];
}

function masterPicker() {
  if (!(myTurn() && state.phase === "power" && state.pending.power === 10)) return null;
  const pile = state.discard.slice(0, -1);
  if (!pile.length) return h("p", { class: "msg" }, h("small", {}, "The discard pile has no other cards."));
  return h("div", { class: "seat picker" }, h("div", { class: "seat-head" }, "Discard pile — choose a card"),
    h("div", { class: "row" }, pile.slice(-24).map((c) => cardEl(c, { onclick: () => { ui.pick.discardId = c.id; ui.sel = []; render(); }, selected: ui.pick.discardId === c.id, target: true }))));
}

function roundPanel() {
  const r = state.lastRound;
  if (!r || (state.phase !== "roundOver" && state.phase !== "gameOver")) return null;
  const name = (s) => state.players[s].name;
  const over = state.phase === "gameOver";
  const callerLine = r.caller ? `${name(r.caller.seat)} called — ${r.caller.success ? "and their team was lowest (scores 0)!" : "but their team wasn't lowest (+10)."}` : "No one called this round.";
  const next = () => { setState(over ? newGame({ names: state.players.map((p) => p.name) }) : act(state, ME, { type: "nextRound" })); lastBotLine = ""; render(); scheduleBots(); };
  return h("div", { class: "overlay" }, h("div", { class: "panel" },
    h("h2", {}, over ? "Game over" : `Round ${r.round} of ${ROUNDS}`),
    over ? h("div", { class: "win" }, state.winner === teamOf(ME) ? "You & Partner win! 🌕" : "West & East win") : null,
    h("p", {}, callerLine),
    h("table", {},
      h("tr", {}, h("th", {}, "Player"), h("th", { class: "num" }, "Cards"), h("th", { class: "num" }, "Total")),
      [0, 2, 1, 3].map((s) => h("tr", {}, h("td", {}, h("span", { class: `dot ${teamOf(s) === teamOf(ME) ? "us" : "them"}` }), " ", name(s)),
        h("td", { class: "num" }, state.players[s].village.map((c) => c.v).join(" ")), h("td", { class: "num" }, r.sums[s])))),
    h("table", {},
      h("tr", {}, h("th", {}, "Team"), h("th", { class: "num" }, "Total"), h("th", { class: "num" }, "Round"), h("th", { class: "num" }, "Game")),
      [0, 1].map((t) => h("tr", {}, h("td", {}, t === teamOf(ME) ? "You & Partner" : "West & East"), h("td", { class: "num" }, r.teamSum[t]), h("td", { class: "num" }, r.roundScore[t]), h("td", { class: "num" }, state.teams[t].score)))),
    h("div", { class: "controls" }, h("button", { class: "btn primary", onclick: next }, over ? "New game" : "Next round"))));
}

function rulesPanel() {
  if (panel !== "rules") return null;
  const close = () => { panel = null; render(); };
  return h("div", { class: "overlay", onclick: (e) => { if (e.target.classList.contains("overlay")) close(); } }, h("div", { class: "panel" },
    h("h2", {}, "How to play"),
    h("p", {}, "Teams: You & Partner (opposite) vs West & East. Your team wants the lowest combined card total after 4 rounds."),
    h("p", {}, "At the start of each round you see 2 of your 5 face-down cards for a few seconds — remember them! Any card you peek at later is also shown only briefly."),
    h("p", {}, "On your turn: draw from the deck (keep it by exchanging, or discard it — discarding a 5–12 lets you use its power), take the top discard (you must keep it, face-up), or take a Squire card."),
    h("p", {}, "Exchanging several cards at once works only if they share a value (13 matches anything). If they don't match, they go back face-down and you take the new card as an extra (plus a penalty card if you tried 3 or more)."),
    h("p", {}, "With 4 or fewer cards you may call a vote: everyone else gets one last turn. If your team's total is lowest (ties count), your team scores 0 — otherwise your total + 10."),
    h("div", { class: "powers" }, Object.entries(POWERS).flatMap(([n, p]) => [h("b", {}, `${FACES[n].icon} ${n} ${p.name}`), h("span", {}, p.text)])),
    h("p", { class: "fine" }, "House rules: partners can't share information; the round also ends when the deck runs out. Unofficial fan version for playing with friends — Silver is designed by Ted Alspach, published by Bezier Games; the card art here is original."),
    h("div", { class: "controls" }, h("button", { class: "btn primary", onclick: close }, "Got it"))));
}

function settingsPanel() {
  if (panel !== "settings") return null;
  const close = () => { panel = null; render(); };
  return h("div", { class: "overlay", onclick: (e) => { if (e.target.classList.contains("overlay")) close(); } }, h("div", { class: "panel" },
    h("h2", {}, "Settings"),
    h("p", {}, "Computer players' speed"),
    h("div", { class: "seg" }, Object.keys(SPEEDS).map((k) => h("button", { class: "btn" + (settings.speed === k ? " primary" : ""), onclick: () => { settings.speed = k; persist(); render(); } }, k[0].toUpperCase() + k.slice(1)))),
    h("div", { class: "controls" },
      h("button", { class: "btn", onclick: () => { if (confirm("Start a new game?")) { setState(newGame({ names: state.players.map((p) => p.name) })); panel = null; ui = { mode: null, sel: [], pick: {}, note: "" }; render(); scheduleBots(); } } }, "New game"),
      h("button", { class: "btn primary", onclick: close }, "Done"))));
}

function render() {
  const view = viewFor(state, ME);
  const [line, sub] = promptLines();
  const us = teamOf(ME);
  const parts = [
    h("div", { class: "top" }, h("span", { class: "brand" }, "SILVER"), h("span", { class: "round" }, `Round ${state.round}/${ROUNDS}`),
      h("span", { class: "score us" }, `Us ${state.teams[us].score}`), h("span", { class: "score them" }, `Them ${state.teams[1 - us].score}`),
      h("span", { class: "spacer" }),
      h("button", { class: "icon-btn", onclick: () => { panel = "rules"; render(); } }, "Rules"),
      h("button", { class: "icon-btn", onclick: () => { panel = "settings"; render(); }, "aria-label": "Settings" }, "⚙︎")),
    h("div", { class: "table" },
      seatEl(view, 2, "top"),
      seatEl(view, 1, "left"),
      centerEl(),
      seatEl(view, 3, "right"),
      seatEl(view, ME, "bottom")),
    masterPicker(),
    h("div", { class: "msg" }, line, sub ? h("small", {}, sub) : null, ui.note ? h("small", { class: "note" }, ui.note) : null),
    h("div", { class: "controls" }, controls()),
    roundPanel(), rulesPanel(), settingsPanel(),
  ];
  app.replaceChildren(...parts.filter((x) => x != null && x !== false));
}

noteNewKnowledge(START_REVEAL_MS);
render();
scheduleBots();
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => {});
