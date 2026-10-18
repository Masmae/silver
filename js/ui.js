// Silver table UI (you vs three computer players). Online play can reuse the same
// engine by sending actions instead of applying them locally.
import { newGame, act, viewFor, legalTypes, POWERS, teamOf, ROUNDS, GameError } from "./engine.js";
import { chooseAction } from "./bot.js";

const ME = 0;
const SAVE = "silver.game.v1";
const app = document.getElementById("app");
let state = load() ?? newGame({ names: ["You", "West", "Partner", "East"] });
let ui = { mode: null, sel: [], pick: {}, note: "" };
let botTimer = null;
let showRules = false;

function load() { try { const s = JSON.parse(localStorage.getItem(SAVE)); return s?.version === 1 ? s : null; } catch { return null; } }
function save() { try { localStorage.setItem(SAVE, JSON.stringify(state)); } catch { /* ignore */ } }

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

// ---------------------------------------------------------------- actions

function doAction(action) {
  try {
    state = act(state, ME, action);
    ui = { mode: null, sel: [], pick: {}, note: "" };
    save();
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
  botTimer = setTimeout(() => {
    const seat = state.current;
    const action = chooseAction(state, seat);
    if (action) state = act(state, seat, action);
    save();
    render();
    scheduleBots();
  }, state.phase === "turn" ? 750 : 550);
}

// ---------------------------------------------------------------- cards

function typeClass(v) { return v === 13 ? "t-dopp" : v <= 4 ? "t-village" : "t-power"; }

function cardEl(card, { size = "", onclick = null, selected = false, target = false, extra = null } = {}) {
  const known = card.v !== null && card.v !== undefined;
  const cls = ["card", size, card.up ? `face ${typeClass(card.v)}` : known ? "peek" : "back", onclick ? "click" : "", selected ? "sel" : "", target ? "target" : ""].filter(Boolean).join(" ");
  const label = card.up ? `${card.v} face-up` : known ? `${card.v} (you peeked)` : "face-down card";
  return h("button", { class: cls, onclick, "aria-label": label, disabled: onclick ? null : true },
    known ? h("span", { class: "n" }, card.v) : null,
    known ? h("span", { class: "p" }, POWERS[card.v].name) : null,
    extra);
}

// ---------------------------------------------------------------- interaction per mode

const v = () => viewFor(state, ME);
const myTurn = () => state.current === ME && state.phase !== "roundOver" && state.phase !== "gameOver";

function onCard(owner, card) {
  const mode = ui.mode;
  ui.note = "";
  if (owner === ME) {
    if (["takeDiscard", "exchange", "power10", "power11own"].includes(mode)) {
      ui.sel = ui.sel.includes(card.id) ? ui.sel.filter((x) => x !== card.id) : [...ui.sel, card.id];
      return render();
    }
    if (mode === "amulet") return doAction({ type: "placeAmulet", cardId: card.id });
    if (mode === "guard") return doAction({ type: "guard", cardIds: [card.id] });
    if (mode === "empath") return doAction({ type: "empath", cardId: card.id });
    if (mode === "power5") return doAction({ type: "power5", cardId: card.id });
    if (mode === "power7") {
      ui.sel = ui.sel.includes(card.id) ? ui.sel.filter((x) => x !== card.id) : [...ui.sel, card.id].slice(-2);
      return render();
    }
    if (mode === "power6" || mode === "power9") return doAction({ type: mode, cardId: card.id });
    if (mode === "power12") { ui.pick.myId = card.id; return maybeRob(); }
  } else {
    if (["power6", "power8", "power9"].includes(mode)) return doAction({ type: mode, cardId: card.id });
    if (mode === "power11own") return doAction({ type: "power11", cardId: card.id });
    if (mode === "power12") { ui.pick.theirId = card.id; return maybeRob(); }
  }
}
function maybeRob() {
  if (ui.pick.myId && ui.pick.theirId) return doAction({ type: "power12", theirId: ui.pick.theirId, myId: ui.pick.myId });
  render();
}

/** Which cards are clickable in the current mode. */
function clickable(owner, card) {
  if (!myTurn() || !ui.mode) return false;
  const mode = ui.mode;
  const amulet = state.amulet.card === card.id;
  const own = owner === ME;
  const faceDown = !card.up;
  const guarded = (state.guards[owner] ?? []).includes(card.id) && !own;
  if (["takeDiscard", "exchange", "power10", "power11own"].includes(mode) && own) return !amulet;
  if (mode === "amulet" || mode === "guard") return own;
  if (["empath", "power5", "power7"].includes(mode)) return own && faceDown && !amulet;
  if (mode === "power6") return faceDown && !amulet && !guarded;
  if (mode === "power8") return !own && teamOf(owner) !== -1 && faceDown && !amulet && !guarded;
  if (mode === "power9") return faceDown && !amulet && !guarded;
  if (mode === "power11own") return !own && !amulet && !guarded;
  if (mode === "power12") return !amulet && !guarded && (own || true);
  return false;
}

// ---------------------------------------------------------------- render

function seatEl(view, seat, { large = false } = {}) {
  const p = view.players[seat];
  const us = teamOf(seat) === teamOf(ME);
  const isTurn = state.current === seat && state.phase !== "roundOver" && state.phase !== "gameOver";
  const tags = [];
  if (state.amulet.holder === seat) tags.push(h("span", { class: "tag gold" }, state.amulet.card ? "Amulet ●" : "Amulet"));
  if (state.caller === seat) tags.push(h("span", { class: "tag gold" }, "Called"));
  return h("div", { class: "seat" + (isTurn ? " turn" : "") },
    h("div", { class: "seat-head" }, h("span", { class: `dot ${us ? "us" : "them"}` }), h("span", { class: "name" }, p.name),
      h("span", {}, `${p.village.length} cards`), ...tags),
    h("div", { class: "row" }, p.village.map((c) => {
      const real = state.players[seat].village.find((x) => x.id === c.id);
      const can = clickable(seat, real);
      const badge = state.amulet.card === c.id ? h("span", { class: "badge" }, "A") : (state.guards[seat] ?? []).includes(c.id) ? h("span", { class: "badge guard" }, "G") : null;
      return cardEl(c, { size: large ? "lg" : "", onclick: can ? () => onCard(seat, real) : null, selected: ui.sel.includes(c.id) || ui.pick.myId === c.id || ui.pick.theirId === c.id, target: can && !large, extra: badge });
    })));
}

function prompt(view) {
  const name = (s) => state.players[s].name;
  if (state.phase === "gameOver") return ["Game over."];
  if (state.phase === "roundOver") return [`Round ${state.round} is over.`];
  if (!myTurn()) {
    const extra = state.caller !== null ? `${name(state.caller)} called — last turns.` : "";
    return [`${name(state.current)} is thinking…`, extra];
  }
  const m = ui.mode;
  const pw = state.pending?.power;
  if (state.phase === "turn") {
    if (m === "takeDiscard") return [`Take the ${state.discard.at(-1).v}: choose which of your cards it replaces.`, "Several cards of the same value can go out together (13 is wild)."];
    if (m === "amulet") return ["Choose one of your cards to protect with the Amulet."];
    if (m === "guard") return ["Choose one of your cards for the Bodyguard to protect."];
    if (m === "empath") return ["Choose one of your face-down cards to look at."];
    const calledNote = state.caller !== null ? `${name(state.caller)} called — this is your last turn!` : "Your turn. Draw a card, take the discard, or call.";
    return [calledNote, "Lowest total wins. Tap Rules for card powers."];
  }
  if (state.phase === "rascal") return ["Rascal: choose which drawn card to keep."];
  if (state.phase === "drawn") {
    const c = state.pending.card;
    if (m === "exchange") return [`Choose which of your cards the ${c.v} replaces.`, "Several cards of the same value can go out together (13 is wild)."];
    const pwr = c.v >= 5 && c.v <= 12 && state.pending.from === "deck" ? ` Discarding it lets you use the ${POWERS[c.v].name}.` : "";
    return [`You drew a ${c.v} (${POWERS[c.v].name}). Keep it by exchanging, or discard it.${pwr}`];
  }
  if (state.phase === "power") {
    const texts = {
      5: "Exposer: choose one of your face-down cards to turn face-up.",
      6: "Revealer: choose any face-down card to turn face-up.",
      7: "Beholder: choose up to two of your face-down cards to look at.",
      8: "Apprentice Seer: choose a face-down card in another village to look at.",
      9: "Seer: choose any face-down card to look at.",
      10: ui.pick.discardId ? "Master: now choose which of your cards it replaces." : "Master: choose a card from the discard pile below.",
      11: `Witch: the top card is a ${state.deck[0]?.v}. Give it to another village (tap their card) or swap it for your own cards.`,
      12: "Robber: choose one of your cards to give and one card in another village to take.",
    };
    return [texts[pw]];
  }
  return [""];
}

function controls(view) {
  const types = legalTypes(state, ME);
  const btn = (label, onclick, cls = "btn", disabled = false) => h("button", { class: cls, onclick, disabled }, label);
  const cancel = () => btn("Cancel", () => { ui = { mode: null, sel: [], pick: {}, note: "" }; render(); });
  if (state.phase === "roundOver" || state.phase === "gameOver") return [];
  if (!myTurn()) return [];
  if (ui.mode && state.phase === "turn") {
    if (ui.mode === "takeDiscard") return [btn("Exchange", () => doAction({ type: "takeDiscard", cardIds: ui.sel }), "btn primary", !ui.sel.length), cancel()];
    return [cancel()];
  }
  if (state.phase === "turn") {
    const out = [];
    if (types.includes("draw")) out.push(btn(`Draw (${state.deck.length})`, () => doAction({ type: "draw" }), "btn primary"));
    if (types.includes("takeDiscard")) out.push(btn(`Take the ${state.discard.at(-1).v}`, () => { ui.mode = "takeDiscard"; ui.sel = []; render(); }));
    if (types.includes("call")) out.push(btn("Call vote", () => { if (confirm("Call for a vote? Everyone else gets one last turn, then lowest team total wins the round.")) doAction({ type: "call" }); }, "btn warn"));
    if (types.includes("placeAmulet")) out.push(btn("Place Amulet", () => { ui.mode = "amulet"; render(); }));
    if (types.includes("guard")) out.push(btn("Bodyguard", () => { ui.mode = "guard"; render(); }));
    if (types.includes("empath")) out.push(btn("Empath peek", () => { ui.mode = "empath"; render(); }));
    return out;
  }
  if (state.phase === "rascal") return [];
  if (state.phase === "drawn") {
    const c = state.pending.card;
    const power = c.v >= 5 && c.v <= 12 && state.pending.from === "deck" && state.caller !== ME;
    if (ui.mode === "exchange") return [btn("Exchange", () => doAction({ type: "exchange", cardIds: ui.sel }), "btn primary", !ui.sel.length), cancel()];
    return [
      btn("Keep it…", () => { ui.mode = "exchange"; ui.sel = []; render(); }, "btn primary"),
      power ? btn(`Discard & use ${POWERS[c.v].name}`, () => { doAction({ type: "discardDrawn", usePower: true }); ui.mode = `power${c.v}`; if (c.v === 11) ui.mode = "power11own"; render(); }) : null,
      btn("Discard", () => doAction({ type: "discardDrawn", usePower: false })),
    ].filter(Boolean);
  }
  if (state.phase === "power") {
    const pw = state.pending.power;
    if (!ui.mode) ui.mode = pw === 11 ? "power11own" : `power${pw}`;
    const out = [];
    if (pw === 7) out.push(btn("Look", () => doAction({ type: "power7", cardIds: ui.sel }), "btn primary", !ui.sel.length));
    if (pw === 10 && ui.pick.discardId) out.push(btn("Exchange", () => doAction({ type: "power10", discardId: ui.pick.discardId, cardIds: ui.sel }), "btn primary", !ui.sel.length));
    if (pw === 11) out.push(btn("Swap for my selected cards", () => doAction({ type: "power11", cardIds: ui.sel }), "btn primary", !ui.sel.length));
    out.push(btn("Skip power", () => doAction({ type: "skipPower" })));
    return out;
  }
  return [];
}

function center(view) {
  const top = state.discard.at(-1);
  const pending = state.pending;
  const kids = [
    h("div", { class: "pile" }, cardEl({ v: null, up: false }), `Deck ${state.deck.length}`),
    h("div", { class: "pile" }, top ? cardEl(top) : h("div", { class: "card back" }), `Discard ${state.discard.length}`),
  ];
  if (state.squire.length) kids.push(h("div", { class: "pile" }, h("div", { class: "row" }, state.squire.map((c, i) =>
    cardEl(c, { onclick: myTurn() && state.phase === "turn" && !ui.mode ? () => doAction({ type: "takeSquire", index: i }) : null }))), "Squire cards"));
  if (myTurn() && state.phase === "rascal") {
    kids.push(h("div", { class: "drawn" }, h("div", { class: "row" }, pending.cards.map((c, i) => cardEl({ ...c, up: true }, { onclick: () => doAction({ type: "rascalKeep", index: i }) }))), "Tap one to keep"));
  }
  if (myTurn() && state.phase === "drawn") kids.push(h("div", { class: "drawn" }, cardEl({ ...pending.card, up: true }), "You drew"));
  if (myTurn() && state.phase === "power" && pending.power === 11 && state.deck[0]) kids.push(h("div", { class: "drawn" }, cardEl({ ...state.deck[0], up: true }), "Top of deck"));
  return h("div", { class: "center" }, kids);
}

function masterPicker() {
  if (!(myTurn() && state.phase === "power" && state.pending.power === 10)) return null;
  const pile = state.discard.slice(0, -1);
  if (!pile.length) return h("p", { class: "msg" }, h("small", {}, "The discard pile has no other cards."));
  return h("div", { class: "seat" }, h("div", { class: "seat-head" }, "Discard pile — choose a card"),
    h("div", { class: "row" }, pile.slice(-24).map((c) => cardEl(c, { onclick: () => { ui.pick.discardId = c.id; ui.sel = []; render(); }, selected: ui.pick.discardId === c.id }))));
}

function roundPanel() {
  const r = state.lastRound;
  if (!r || (state.phase !== "roundOver" && state.phase !== "gameOver")) return null;
  const name = (s) => state.players[s].name;
  const over = state.phase === "gameOver";
  const callerLine = r.caller ? `${name(r.caller.seat)} called — ${r.caller.success ? "and their team was lowest (scores 0)!" : "but their team wasn't lowest (+10)."}` : "No one called this round.";
  return h("div", { class: "overlay" }, h("div", { class: "panel" },
    h("h2", {}, over ? "Game over" : `Round ${r.round} of ${ROUNDS}`),
    over ? h("div", { class: "win" }, state.winner === teamOf(ME) ? "You & Partner win! 🌕" : "West & East win") : null,
    h("p", {}, callerLine),
    h("table", {},
      h("tr", {}, h("th", {}, "Player"), h("th", { class: "num" }, "Cards"), h("th", { class: "num" }, "Hand total")),
      [0, 2, 1, 3].map((s) => h("tr", {}, h("td", {}, h("span", { class: `dot ${teamOf(s) === teamOf(ME) ? "us" : "them"}` }), " ", name(s)),
        h("td", { class: "num" }, state.players[s].village.map((c) => c.v).join(" ")), h("td", { class: "num" }, r.sums[s])))),
    h("table", {},
      h("tr", {}, h("th", {}, "Team"), h("th", { class: "num" }, "Total"), h("th", { class: "num" }, "Round score"), h("th", { class: "num" }, "Game")),
      [0, 1].map((t) => h("tr", {}, h("td", {}, t === teamOf(ME) ? "You & Partner" : "West & East"), h("td", { class: "num" }, r.teamSum[t]), h("td", { class: "num" }, r.roundScore[t]), h("td", { class: "num" }, state.teams[t].score)))),
    h("div", { class: "controls" }, over
      ? h("button", { class: "btn primary", onclick: () => { state = newGame({ names: state.players.map((p) => p.name) }); save(); render(); scheduleBots(); } }, "New game")
      : h("button", { class: "btn primary", onclick: () => { state = act(state, ME, { type: "nextRound" }); save(); render(); scheduleBots(); } }, "Next round"))));
}

function rulesPanel() {
  if (!showRules) return null;
  return h("div", { class: "overlay", onclick: (e) => { if (e.target.classList.contains("overlay")) { showRules = false; render(); } } }, h("div", { class: "panel" },
    h("h2", {}, "How to play"),
    h("p", {}, "Teams: You & Partner (opposite) vs West & East. Your team wants the lowest combined card total after 4 rounds."),
    h("p", {}, "You start each round knowing 2 of your 5 face-down cards. On your turn: draw from the deck (then keep it by exchanging, or discard it — discarding a 5–12 lets you use its power), or take the top discard (you must keep it, face-up)."),
    h("p", {}, "Exchanging several cards at once works only if they share a value (13 matches anything). If they don't match, they go back face-down and you take the new card as an extra one (plus a penalty card if you tried 3 or more)."),
    h("p", {}, "With 4 or fewer cards you may call a vote: everyone else gets one last turn. If your team's total is lowest (ties count), your team scores 0 — otherwise your total + 10. The other team scores its total."),
    h("div", { class: "powers" }, Object.entries(POWERS).flatMap(([n, p]) => [h("b", {}, `${n} ${p.name}`), h("span", {}, p.text)])),
    h("p", { class: "fine" }, "House rules here: partners can't share information; the round also ends when the deck runs out. Unofficial fan version for playing with friends — Silver is designed by Ted Alspach, published by Bezier Games."),
    h("div", { class: "controls" }, h("button", { class: "btn primary", onclick: () => { showRules = false; render(); } }, "Got it"))));
}

function render() {
  const view = v();
  const [line, sub] = prompt(view);
  const us = teamOf(ME);
  const parts = [
    h("div", { class: "top" }, h("span", { class: "brand" }, "SILVER"), h("span", { class: "round" }, `Round ${state.round}/${ROUNDS} · 2 vs 2`), h("span", { class: "spacer" }),
      h("button", { class: "icon-btn", onclick: () => { showRules = true; render(); } }, "Rules"),
      h("button", { class: "icon-btn", onclick: () => { if (confirm("Start a new game?")) { state = newGame({ names: state.players.map((p) => p.name) }); ui = { mode: null, sel: [], pick: {}, note: "" }; save(); render(); scheduleBots(); } } }, "New")),
    h("div", { class: "scores" },
      h("div", { class: "score us" }, h("span", {}, "You & Partner"), h("b", {}, state.teams[us].score)),
      h("div", { class: "score them" }, h("span", {}, "West & East"), h("b", {}, state.teams[1 - us].score))),
    seatEl(view, 2),
    h("div", { class: "opps" }, seatEl(view, 1), seatEl(view, 3)),
    center(view),
    masterPicker(),
    h("div", { class: "msg" }, line, sub ? h("small", {}, sub) : null, ui.note ? h("small", { class: "note" }, ui.note) : null),
    h("div", { class: "controls" }, controls(view)),
    seatEl(view, ME, { large: true }),
    h("div", { class: "log" }, state.log.slice(-3).map((l) => h("div", {}, l))),
    roundPanel(), rulesPanel(),
  ];
  // replaceChildren would print "null" for empty slots.
  app.replaceChildren(...parts.filter((x) => x != null && x !== false));
}

render();
scheduleBots();
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => {});
