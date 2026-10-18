# Silver: 2 vs 2

An unofficial web version of **Silver** (designed by Ted Alspach, published by Bezier Games), played as two teams: you and your partner against two computer players. Made for playing with friends; the card art is original.

**Play:** https://masmae.github.io/silver/. On iPhone, open it in Safari, then tap Share → Add to Home Screen. It works offline.

## House rules (2 vs 2)

- **Teams:** partners sit opposite each other. A team's round total is the sum of both partners' cards.
- **Calling:** you may call with 4 or fewer cards, and everyone else then gets one last turn. If your team's total is lowest (ties count), your team scores 0; otherwise it scores its total + 10. The other team scores its total.
- **No table talk:** you only know what you've seen yourself, and the computer players play the same way.
- **Deck runs out:** the round ends. (The rulebook continues with Squire cards, which can stall the game.)
- **Squire cards:** taking one works like drawing from the deck, and a 5–12 can use its power.
- **Memory:** at the start of each round you see two of your cards for a few seconds; anything you peek at later also shows only briefly, then flips back face-down.

## Code

- `js/engine.js`: the rules as a pure, serializable state machine, ready to sync for online play later.
- `js/bot.js`: the computer players. They weigh every option by expected points and won 77% of games against the first simple version (`js/bot-basic.js`, kept for that benchmark).
- `js/ui.js`: the table.
- **Tests:** `node --test tests/*.test.mjs` simulates 300 full bot games and checks card conservation, scoring and hidden information.
