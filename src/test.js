// test.js — offline tests. Run: node src/test.js
import { createState, applyEvent, snapshot } from "./engine.js";

function show(state, label) {
  console.log(`\n=== ${label} ===`);
  const snap = snapshot(state);
  for (const [name, hand] of Object.entries(snap)) {
    console.log(`  ${name.padEnd(8)} ${JSON.stringify(hand)}`);
  }
}

function assert(cond, msg) {
  if (!cond) { console.error("  ✗ FAIL:", msg); process.exitCode = 1; }
  else console.log("  ✓", msg);
}

const s = createState(["Alice", "Bob", "Carol"]);

// Alice rolls into 2 wood, 1 brick.
applyEvent(s, { type: "roll_gain", player: "Alice", gains: { wood: 2, brick: 1 } });
// Bob gains 1 sheep.
applyEvent(s, { type: "roll_gain", player: "Bob", gains: { sheep: 1 } });
show(s, "after rolls");

// Steal #1: Bob steals an unknown from Alice. Alice has wood+brick only,
// so candidates = {wood, brick}. Ambiguous for now.
applyEvent(s, { type: "steal", thief: "Bob", victim: "Alice", });
show(s, "after Bob steals unknown from Alice (ambiguous)");
assert(snapshot(s).Bob.wood === "0-1" && snapshot(s).Bob.brick === "0-1",
  "Bob's wood/brick now uncertain (0-1 each)");

// Alice builds a road: costs 1 wood + 1 brick. She had min wood already.
applyEvent(s, { type: "build", player: "Alice", item: "road" });
show(s, "after Alice builds road");

// Now Alice bank-trades away brick she shouldn't have if the steal took brick.
// She trades 1 brick -> 1 ore. For this to be legal she must still hold brick,
// which forces the earlier steal to have been WOOD, not brick.
applyEvent(s, { type: "bank_trade", player: "Alice", give: { brick: 1 }, receive: { ore: 1 } });
show(s, "after Alice bank-trades brick→ore (should retro-resolve steal to wood)");

const snap = snapshot(s);
assert(snap.Bob.wood === "1", "steal retro-resolved: Bob definitely has the stolen WOOD");
assert(snap.Bob.brick === "0", "Bob's brick collapses back to 0");

// Monopoly: Carol declares sheep monopoly, takes Bob's 1 sheep.
applyEvent(s, { type: "monopoly", player: "Carol", resource: "sheep", takenFrom: { Bob: 1 } });
show(s, "after Carol's sheep monopoly");
assert(snapshot(s).Carol.sheep === "1", "Carol got 1 sheep via monopoly");
assert(snapshot(s).Bob.sheep === "0", "Bob lost his sheep");

console.log("\nDone.");

// --- second scenario: ambiguity that should NOT resolve ---
console.log("\n########## scenario 2: persistent ambiguity ##########");
const s2 = createState(["X", "Y"]);
applyEvent(s2, { type: "roll_gain", player: "X", gains: { wood: 1, ore: 1 } });
applyEvent(s2, { type: "steal", thief: "Y", victim: "X" }); // candidates wood/ore
show(s2, "Y stole unknown from X (should stay ambiguous)");
const a = snapshot(s2);
assert(a.Y.wood === "0-1" && a.Y.ore === "0-1", "Y stays ambiguous wood/ore (no constraint yet)");
assert(a.X.wood === "0-1" && a.X.ore === "0-1", "X stays ambiguous too");
console.log("\nAll scenarios done.");
