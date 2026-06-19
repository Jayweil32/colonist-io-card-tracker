// parser.js — turns a colonist.io log-line DOM node into an engine event.
//
// Based on real colonist.io DOM (June 2026). Each log line is a
// `.scrollItemContainer-WXX2rkzf` containing a `.messagePart-XeUsOgLX` span.
// Resources are <img> tags whose `alt` attribute names them; players are a
// styled <span> with the name as text.
//
// parseLogLine(node) -> event | null   (null = a line we don't track)

// colonist's resource names (img alt text) -> engine's vocabulary.
// Keys are lowercased at lookup time since colonist is inconsistent about case
// (e.g. "Lumber" in gains but "lumber" in a Monopoly haul).
const RESOURCE_MAP = {
  lumber: "wood",
  brick: "brick",
  wool: "sheep",
  grain: "wheat",
  ore: "ore",
};

function mapResource(alt) {
  if (!alt) return null;
  return RESOURCE_MAP[alt.toLowerCase()] || null;
}

// For a Monopoly haul line ("stole N <res>"), return the single resource type.
function readMonopolyResource(node) {
  const imgs = node.querySelectorAll("img.lobbyChatTextIcon");
  for (const img of imgs) {
    const res = mapResource(img.getAttribute("alt"));
    if (res) return res;
  }
  return null;
}

// --- low-level DOM readers ----------------------------------------------------

// The player name span is the first styled span with a color. Returns its text
// (e.g. "Carlin#5649" or "Halden"). We strip nothing — names include the #tag.
function readPlayerName(node) {
  const span = node.querySelector('span[style*="color"]');
  return span ? span.textContent.trim() : null;
}

// Collect resource <img> alt values from a node (or sub-node), mapped to engine
// names, as a count object: {wood:2, ore:1}. Ignores dice/prob/tile/avatar imgs.
function readResources(scope) {
  const counts = {};
  const imgs = scope.querySelectorAll("img.lobbyChatTextIcon");
  for (const img of imgs) {
    const alt = img.getAttribute("alt");
    const res = mapResource(alt);
    if (!res) continue; // dice_4, prob_9, "lumber tile", etc. are not cards
    counts[res] = (counts[res] || 0) + 1;
  }
  return counts;
}

// Some messages have resources on BOTH sides of a connector word, e.g.
// "gave bank WOOL WOOL and took BRICK" or "gave GRAIN and got BRICK from X".
// To split them we walk the message's child nodes IN ORDER, building a flat
// token stream of {text} and {res} items, then slice by marker regexes.
function tokenize(node) {
  const msg = node.querySelector(".messagePart-XeUsOgLX");
  const tokens = [];
  if (!msg) return tokens;
  const walk = (el) => {
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        // text node
        const t = child.rawText ? child.rawText : child.text;
        if (t && t.trim()) tokens.push({ text: t });
      } else if (child.tagName === "IMG") {
        const alt = child.getAttribute("alt");
        const res = mapResource(alt);
        if (res) tokens.push({ res });
        else tokens.push({ text: "" }); // non-resource icon: position marker only
      } else {
        // element (e.g. span name, vp-text) — descend, but also surface its text
        const txt = child.text;
        if (txt && txt.trim() && !child.querySelector?.("img")) tokens.push({ text: txt });
        else walk(child);
      }
    }
  };
  walk(msg);
  return tokens;
}

function countFromTokens(tokens) {
  const counts = {};
  for (const tk of tokens) if (tk.res) counts[tk.res] = (counts[tk.res] || 0) + 1;
  return counts;
}

// Resources appearing in the token stream strictly between two marker regexes.
function readResourcesBetween(node, startRe, endRe) {
  const tokens = tokenize(node);
  let started = false;
  const slice = [];
  for (const tk of tokens) {
    if (tk.text && startRe.test(tk.text)) { started = true; continue; }
    if (started && tk.text && endRe.test(tk.text)) break;
    if (started) slice.push(tk);
  }
  return countFromTokens(slice);
}

// Resources appearing after a marker regex to the end of the message.
function readResourcesAfter(node, startRe) {
  const tokens = tokenize(node);
  let started = false;
  const slice = [];
  for (const tk of tokens) {
    if (tk.text && startRe.test(tk.text)) { started = true; continue; }
    if (started) slice.push(tk);
  }
  return countFromTokens(slice);
}

// The full visible text of the message (icons collapse to empty), used to detect
// which kind of line this is via its connecting words.
function readText(node) {
  const msg = node.querySelector(".messagePart-XeUsOgLX");
  return msg ? msg.textContent.replace(/\s+/g, " ").trim() : "";
}

// --- the parser ---------------------------------------------------------------

export function parseLogLine(node) {
  const text = readText(node);
  if (!text) return null; // separators (<hr>) and empty lines

  const player = readPlayerName(node);

  // ROLL — "<name> rolled" + two dice imgs. We don't emit an event for the roll
  // itself; resource distribution comes as separate "got" lines. Skip.
  if (/\brolled\b/.test(text)) return null;

  // TRADE OFFER — "wants to give ... for ...". NOT a completed trade. Skip;
  // only accepted trades change hands (need a sample of the accepted format).
  if (/\bwants to give\b/.test(text)) return null;

  // ROBBER BLOCK — "is blocked by the Robber. No resources produced". No hand
  // change. Skip.
  if (/blocked by the Robber/i.test(text)) return null;

  // ROBBER MOVE — "<name> moved Robber to <tile>". Board signal only, no hand
  // change. A steal line may follow separately. Skip.
  if (/moved Robber/i.test(text)) return null;

  // MONOPOLY HAUL — "<name> stole <N> <resource>" (NO "from"). The monopoly
  // play's effect: the player collects N of one resource from all opponents. The
  // count is a NUMBER in the text, not N icons. Must be checked BEFORE the
  // robber-steal branch, which also uses "stole" (but always has "from
  // <victim>"). We model it as the monopolizer gaining N, and every opponent
  // losing ALL of that resource (a monopoly takes everything of that type).
  if (player && /\bstole\b/.test(text) && !/\bfrom\b/.test(text)) {
    const m = text.match(/stole\s+(\d+)/i);
    const count = m ? parseInt(m[1], 10) : 0;
    const res = readMonopolyResource(node);
    if (res) return { type: "monopoly_haul", player, resource: res, count };
    return null;
  }

  // STEAL — handled before generic name branches because the wording differs:
  //  (a) "You stole <res> from <Victim>"  — you are thief, resource VISIBLE
  //  (b) "<Thief> stole <res> from You"    — you are victim, resource VISIBLE  [TODO: confirm wording]
  //  (c) "<Thief> stole <hidden> from <Victim>" — opponents only, resource HIDDEN [TODO: confirm wording]
  // In (a)/(b) we read the real resource; in (c) we emit an unknown steal and
  // let the engine's retroactive resolution narrow it.
  if (/\bstole\b/.test(text)) {
    // Names: colored spans inside the message. "You" appears as bare text.
    const spans = node.querySelectorAll('.messagePart-XeUsOgLX span[style*="color"]');
    const names = spans.map((s) => s.textContent.trim());
    const stolen = readResources(node); // {} if hidden
    const resKeys = Object.keys(stolen);
    const resource = resKeys.length === 1 ? resKeys[0] : null;

    // Determine thief/victim. "from <X>" => X is victim; the other party is thief.
    // Case (a): "You stole ... from <Victim>" — one span (victim), thief="You".
    // Case (b): "<Thief> stole ... from You" — one span (thief), victim="You".
    // Case (c): "<Thief> stole ... from <Victim>" — two spans.
    let thief, victim;
    if (/^You stole/i.test(text)) {
      thief = "You"; victim = names[0] || null;
    } else if (/from You\b/i.test(text)) {
      thief = names[0] || null; victim = "You";
    } else {
      thief = names[0] || null; victim = names[1] || null;
    }
    if (!thief || !victim) return null; // malformed; skip safely
    return { type: "steal", thief, victim, resource: resource || undefined };
  }

  // GOT — "<name> got <resources>". A plain resource gain (roll payout, etc.).
  // Exclude accepted player trades ("gave ... and got ... from ..."), which also
  // contain "got" but are handled by the player-trade branch below.
  if (player && /\bgot\b/.test(text) && !/\bgave\b/.test(text)) {
    const gains = readResources(node);
    if (Object.keys(gains).length === 0) return null;
    return { type: "roll_gain", player, gains };
  }

  // STARTING RESOURCES — "<name> received starting resources <res...>". The
  // second-settlement payout at game start. Counts as a gain.
  if (player && /received starting resources/i.test(text)) {
    const gains = readResources(node);
    if (Object.keys(gains).length === 0) return null;
    return { type: "roll_gain", player, gains };
  }

  // PLACED — "<name> placed a Settlement|Road|City". FREE opening placement:
  // the structure goes on the board but NO resources are spent. We emit a
  // distinct event so the board layer can note it without charging cost.
  if (player && /\bplaced a\b/.test(text)) {
    const m = text.match(/placed a (Settlement|Road|City)/i);
    if (m) return { type: "place_free", player, item: m[1].toLowerCase() };
    return null;
  }

  // BUILT — "<name> built a Road|Settlement|City". PAID mid-game build: charge
  // the resource cost. (Distinct wording from the free "placed a" opening.)
  if (player && /\bbuilt a\b/.test(text)) {
    const m = text.match(/built a (Road|Settlement|City)/i);
    if (m) return { type: "build", player, item: m[1].toLowerCase() };
    return null;
  }

  // DEV CARD BUY — "<name> bought <Development Card>". Charge dev card cost
  // (sheep + wheat + ore). The card itself is hidden (card back), which is fine —
  // we only track the resource spend.
  if (player && /\bbought\b/.test(text)) {
    return { type: "build", player, item: "devcard" };
  }

  // BANK TRADE — "<name> gave bank <res...> and took <res...>". Deterministic.
  if (player && /\bgave bank\b/.test(text)) {
    const give = readResourcesBetween(node, /gave bank/i, /and took/i);
    const receive = readResourcesAfter(node, /and took/i);
    return { type: "bank_trade", player, give, receive };
  }

  // TOOK FROM BANK — "<name> took from bank <res...>". The resource gain from a
  // Year of Plenty play (the preceding "used Year of Plenty" line is skipped).
  if (player && /took from bank/i.test(text)) {
    const cards = readResourcesAfter(node, /took from bank/i);
    return { type: "year_of_plenty", player, cards };
  }

  // DISCARD — "<name> discarded <res...>". Loss (e.g. over 7 on a robber roll).
  if (player && /\bdiscarded\b/.test(text)) {
    const cards = readResourcesAfter(node, /discarded/i);
    return { type: "discard", player, cards };
  }

  // DEV CARD "used" ANNOUNCEMENTS — "<name> used Year of Plenty|Monopoly|Knight|
  // Road Building". These only label the play; the actual effect comes on the
  // following line(s) (took from bank / stole / moved Robber / placed roads), so
  // the announcement itself is a no-op. Skip it.
  if (player && /\bused\b/.test(text)) return null;

  // PLAYER TRADE (accepted) — "<A> gave <res...> and got <res...> from <B>".
  // A (leading span) gives `gave` to B and receives `got` from B.
  if (player && /\bgave\b/.test(text) && /\bgot\b/.test(text) && /\bfrom\b/.test(text)) {
    const spans = node.querySelectorAll('.messagePart-XeUsOgLX span[style*="color"]');
    const from = spans.length >= 2 ? spans[spans.length - 1].textContent.trim() : null;
    const gave = readResourcesBetween(node, /\bgave\b/i, /\band got\b/i);
    const got = readResourcesBetween(node, /\band got\b/i, /\bfrom\b/i);
    if (from) return { type: "player_trade", from: player, to: from, gave, got };
  }

  // ----- patterns below need real samples to finalize (see TODO note) -----
  // BUILD:      probably "<name> built a <road|settlement|city>"
  // BUY DEV:    probably "<name> bought <devcard>"
  // BANK TRADE: probably "<name> gave bank <res> and took <res>" or "traded ... with bank"
  // PLAYER TRADE (accepted): probably "<name> gave <res> to <name> and got <res>" or "traded with"
  // STEAL (you involved):   probably "<name> stole <res> from <name>"
  // STEAL (opponents only): probably "<name> stole <hidden> from <name>" / "stole a card"
  // DISCARD (on 7):         probably "<name> discarded <res>"
  // MONOPOLY:               probably "<name> took all of <res>" / "stole N <res> ..."
  // YEAR OF PLENTY:         probably "<name> took <res> <res> from bank"

  return null; // unrecognized / untracked line
}

export { RESOURCE_MAP };
