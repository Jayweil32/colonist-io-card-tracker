// parser.test.js — runs parseLogLine over the real colonist HTML fixture.
// Run: node src/parser.test.js
import fs from "fs";
import { parse } from "node-html-parser";
import { parseLogLine } from "./parser.js";
import { createState, applyEvent, snapshot } from "./engine.js";

const html = fs.readFileSync(new URL("./fixture.html", import.meta.url), "utf8");
const root = parse(html);
const lines = root.querySelectorAll(".scrollItemContainer-WXX2rkzf");

console.log(`found ${lines.length} log lines\n`);

const events = [];
for (const node of lines) {
  const ev = parseLogLine(node);
  const idx = node.getAttribute("data-index");
  if (ev) {
    console.log(`  [${idx}] -> ${JSON.stringify(ev)}`);
    events.push(ev);
  } else {
    const txt = (node.querySelector(".messagePart-XeUsOgLX")?.textContent || "").replace(/\s+/g, " ").trim();
    console.log(`  [${idx}]    (skipped) "${txt.slice(0, 50)}"`);
  }
}

// Feed parsed events into the engine and show resulting hands.
const players = ["Halden", "Carlin#5649", "Drews", "Clarey"];
const s = createState(players);
for (const ev of events) applyEvent(s, ev);

console.log("\n=== resulting hands ===");
for (const [name, hand] of Object.entries(snapshot(s))) {
  console.log(`  ${name.padEnd(12)} ${JSON.stringify(hand)}`);
}

// Sanity checks against what the log literally shows.
function assert(c, m) { console.log(c ? "  ✓ " + m : "  ✗ FAIL: " + m); if (!c) process.exitCode = 1; }
console.log("\n=== checks ===");
const snap = snapshot(s);
// Carlin got: 2 wool, 1 wool, 1 ore = 3 wool total + 1 ore
assert(snap["Carlin#5649"].sheep === "3", "Carlin has 3 sheep (wool) from three 'got' lines");
assert(snap["Carlin#5649"].ore === "1", "Carlin has 1 ore");
// Halden got 2 wool
assert(snap["Halden"].sheep === "2", "Halden has 2 sheep");
// Drews got 1 grain
assert(snap["Drews"].wheat === "1", "Drews has 1 wheat (grain)");
// Clarey got 1 wool
assert(snap["Clarey"].sheep === "1", "Clarey has 1 sheep");
console.log("\nDone.");
