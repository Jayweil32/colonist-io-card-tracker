// ==UserScript==
// @name         Colonist Card Tracker
// @namespace    catan-tracker
// @version      0.1.0
// @description  Tracks opponents' likely resource cards on colonist.io from the public game log.
// @match        https://colonist.io/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // =========================================================================
  // 0) CONFIG
  // =========================================================================
  // Debug mode: logs every parsed event and the resulting hands to the console.
  // Toggle at runtime from the browser console with:  __catanDebug(true|false)
  // or flip this default to true.
  let DEBUG = false;
  window.__catanDebug = (on) => { DEBUG = !!on; console.log("[catan] debug", DEBUG ? "ON" : "OFF"); };

  // =========================================================================
  // 1) TYPES / CONSTANTS
  // =========================================================================
  const RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"];
  const COSTS = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    devcard: { sheep: 1, wheat: 1, ore: 1 },
  };
  const RESOURCE_MAP = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };
  const RESOURCE_GLYPH = { wood: "🌲", brick: "🧱", sheep: "🐑", wheat: "🌾", ore: "⛰️" };
  // Real colonist.io card icons (from captured CDN assets). If a hashed filename
  // changes after a colonist redeploy and the image 404s, the <img> onerror
  // swaps in the emoji glyph above, so the panel never shows blank boxes.
  const RESOURCE_ICON = {
    wood:  "https://cdn.colonist.io/dist/assets/card_lumber.cf22f8083cf89c2a29e7.svg",
    brick: "https://cdn.colonist.io/dist/assets/card_brick.5950ea07a7ea01bc54a5.svg",
    sheep: "https://cdn.colonist.io/dist/assets/card_wool.17a6dea8d559949f0ccc.svg",
    wheat: "https://cdn.colonist.io/dist/assets/card_grain.09c9d82146a64bce69b5.svg",
    ore:   "https://cdn.colonist.io/dist/assets/card_ore.117f64dab28e1c987958.svg",
  };
  const DEV_ICON = "https://cdn.colonist.io/dist/assets/card_devcardback.92569a1abd04a8c1c17e.svg";

  const emptyHand = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });

  // =========================================================================
  // 2) STATE ENGINE  (range-per-resource with retroactive steal resolution)
  // =========================================================================
  function createState() {
    return { players: {}, steals: [], colors: {}, turn: null, roadHolder: null, truth: {} };
  }
  function ensurePlayer(state, name) {
    if (!state.players[name]) {
      state.players[name] = { min: emptyHand(), max: emptyHand(), devCards: 0, knights: 0 };
    }
    return state.players[name];
  }
  function gain(state, name, res, n = 1) {
    const p = ensurePlayer(state, name);
    p.min[res] += n; p.max[res] += n;
  }
  function lose(state, name, res, n = 1) {
    const p = ensurePlayer(state, name);
    p.min[res] = Math.max(0, p.min[res] - n);
    p.max[res] = Math.max(0, p.max[res] - n);
  }
  function loseAndConstrain(state, name, res, n = 1) {
    for (const steal of state.steals) {
      if (steal.resolved || steal.victim !== name) continue;
      if (!steal.candidates.includes(res)) continue;
      const p = state.players[name];
      if (p.min[res] < n) {
        steal.candidates = steal.candidates.filter((c) => c !== res);
        state.players[steal.thief].max[res] -= 1;
        p.min[res] = Math.min(p.min[res] + 1, p.max[res]);
      }
    }
    lose(state, name, res, n);
    resolveSteals(state);
  }
  function spend(state, name, cost) {
    for (const res of Object.keys(cost)) loseAndConstrain(state, name, res, cost[res]);
  }
  function recordSteal(state, thief, victim, knownResource) {
    const v = ensurePlayer(state, victim);
    ensurePlayer(state, thief);
    if (knownResource) {
      lose(state, victim, knownResource, 1);
      gain(state, thief, knownResource, 1);
      return;
    }
    const candidates = RESOURCES.filter((r) => v.max[r] > 0);
    const steal = { thief, victim, candidates, resolved: false };
    state.steals.push(steal);
    for (const r of candidates) {
      state.players[thief].max[r] += 1;
      state.players[victim].min[r] = Math.max(0, state.players[victim].min[r] - 1);
    }
    resolveSteals(state);
  }
  function resolveSteals(state) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const steal of state.steals) {
        if (steal.resolved) continue;
        const v = state.players[steal.victim];
        const t = state.players[steal.thief];
        const live = steal.candidates.filter((r) => v.max[r] > 0);
        if (live.length !== steal.candidates.length) {
          for (const r of steal.candidates) if (!live.includes(r)) t.max[r] -= 1;
          steal.candidates = live;
          changed = true;
        }
        if (steal.candidates.length === 1) {
          const r = steal.candidates[0];
          t.max[r] -= 1; gain(state, steal.thief, r, 1);
          v.min[r] = Math.max(0, v.min[r] - 1); lose(state, steal.victim, r, 1);
          steal.resolved = true;
          changed = true;
        }
      }
    }
  }
  function applyEvent(state, ev) {
    switch (ev.type) {
      case "roll_gain":
        for (const r of Object.keys(ev.gains)) gain(state, ev.player, r, ev.gains[r]);
        break;
      case "roll":
        // Marks the start of a player's turn — used for current-turn highlight.
        state.turn = ev.player;
        break;
      case "build":
        spend(state, ev.player, COSTS[ev.item]);
        if (ev.item === "devcard") ensurePlayer(state, ev.player).devCards += 1;
        break;
      case "knight":
        // Playing a knight: it leaves the player's hand and counts toward army.
        {
          const p = ensurePlayer(state, ev.player);
          if (p.devCards > 0) p.devCards -= 1;
          p.knights += 1;
        }
        break;
      case "play_dev":
        // Any other dev card played (YoP/Monopoly/Road Building): leaves hand.
        {
          const p = ensurePlayer(state, ev.player);
          if (p.devCards > 0) p.devCards -= 1;
        }
        break;
      case "place_free":
        break; // free opening placement, no cost
      case "bank_trade":
        for (const r of Object.keys(ev.give)) loseAndConstrain(state, ev.player, r, ev.give[r]);
        for (const r of Object.keys(ev.receive)) gain(state, ev.player, r, ev.receive[r]);
        break;
      case "player_trade":
        for (const r of Object.keys(ev.gave)) { loseAndConstrain(state, ev.from, r, ev.gave[r]); gain(state, ev.to, r, ev.gave[r]); }
        for (const r of Object.keys(ev.got)) { loseAndConstrain(state, ev.to, r, ev.got[r]); gain(state, ev.from, r, ev.got[r]); }
        resolveSteals(state);
        break;
      case "steal":
        recordSteal(state, ev.thief, ev.victim, ev.resource || null);
        break;
      case "discard":
        for (const r of Object.keys(ev.cards)) loseAndConstrain(state, ev.player, r, ev.cards[r]);
        resolveSteals(state);
        break;
      case "year_of_plenty":
        for (const r of Object.keys(ev.cards)) gain(state, ev.player, r, ev.cards[r]);
        break;
      case "monopoly_haul":
        for (const name of Object.keys(state.players)) {
          if (name === ev.player) continue;
          state.players[name].min[ev.resource] = 0;
          state.players[name].max[ev.resource] = 0;
        }
        gain(state, ev.player, ev.resource, ev.count);
        resolveSteals(state);
        break;
      default:
        break;
    }
    return state;
  }

  // =========================================================================
  // 3) PARSER  (colonist DOM log line -> engine event)
  // =========================================================================
  function mapResource(alt) {
    if (!alt) return null;
    return RESOURCE_MAP[alt.toLowerCase()] || null;
  }
  function msgText(node) {
    const parts = node.querySelectorAll(".messagePart-XeUsOgLX");
    let t = "";
    for (const p of parts) t += " " + p.textContent;
    return t.replace(/\s+/g, " ").trim();
  }
  function leadName(node) {
    const span = node.querySelector('span[style*="color"]');
    return span ? span.textContent.trim() : null;
  }
  function colorOf(node) {
    const span = node.querySelector('span[style*="color"]');
    if (!span) return null;
    const m = (span.getAttribute("style") || "").match(/color:\s*(#[0-9a-fA-F]{3,6})/);
    return m ? m[1] : null;
  }
  // Flat ordered token stream of {text} / {res} to split resources by connectors.
  function tokenize(node) {
    const tokens = [];
    const parts = node.querySelectorAll(".messagePart-XeUsOgLX");
    const walk = (el) => {
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent && child.textContent.trim()) tokens.push({ text: child.textContent });
        } else if (child.tagName === "IMG") {
          const res = mapResource(child.getAttribute("alt"));
          if (res) tokens.push({ res }); else tokens.push({ text: "" });
        } else {
          walk(child);
        }
      }
    };
    for (const p of parts) walk(p);
    // include tooltip spans (dev card names) — harmless, they carry no resources
    return tokens;
  }
  function countTokens(tokens) {
    const c = {};
    for (const tk of tokens) if (tk.res) c[tk.res] = (c[tk.res] || 0) + 1;
    return c;
  }
  function between(node, startRe, endRe) {
    const tokens = tokenize(node);
    let started = false; const slice = [];
    for (const tk of tokens) {
      if (tk.text && startRe.test(tk.text)) { started = true; continue; }
      if (started && tk.text && endRe.test(tk.text)) break;
      if (started) slice.push(tk);
    }
    return countTokens(slice);
  }
  function after(node, startRe) {
    const tokens = tokenize(node);
    let started = false; const slice = [];
    for (const tk of tokens) {
      if (tk.text && startRe.test(tk.text)) { started = true; continue; }
      if (started) slice.push(tk);
    }
    return countTokens(slice);
  }
  function allResources(node) {
    const c = {};
    for (const img of node.querySelectorAll("img.lobbyChatTextIcon")) {
      const r = mapResource(img.getAttribute("alt"));
      if (r) c[r] = (c[r] || 0) + 1;
    }
    return c;
  }

  function parseLogLine(node) {
    const text = msgText(node);
    if (!text) return null;
    const player = leadName(node);

    if (/\brolled\b/.test(text)) {
      // Resources from the roll arrive as separate "got" lines; here we only
      // emit a turn marker so the overlay can highlight the active player.
      return player ? { type: "roll", player } : null;
    }
    if (/\bwants to give\b/.test(text)) return null;
    if (/blocked by the Robber/i.test(text)) return null;
    if (/moved Robber/i.test(text)) return null;

    // MONOPOLY HAUL: "<name> stole <N> <res>" (no "from").
    if (player && /\bstole\b/.test(text) && !/\bfrom\b/.test(text)) {
      const m = text.match(/stole\s+(\d+)/i);
      const count = m ? parseInt(m[1], 10) : 0;
      let res = null;
      for (const img of node.querySelectorAll("img.lobbyChatTextIcon")) {
        const r = mapResource(img.getAttribute("alt"));
        if (r) { res = r; break; }
      }
      if (res) return { type: "monopoly_haul", player, resource: res, count };
      return null;
    }

    // STEAL: "You stole <res> from <V>" / "<T> stole <res> from you" / "<T> stole <hidden> from <V>".
    if (/\bstole\b/.test(text)) {
      const spans = node.querySelectorAll('.messagePart-XeUsOgLX span[style*="color"]');
      const names = Array.from(spans).map((s) => s.textContent.trim());
      const res = allResources(node);
      const keys = Object.keys(res);
      const resource = keys.length === 1 ? keys[0] : null;
      let thief, victim;
      if (/^You stole/i.test(text)) { thief = "You"; victim = names[0] || null; }
      else if (/from you\b/i.test(text)) { thief = names[0] || null; victim = "You"; }
      else { thief = names[0] || null; victim = names[1] || null; }
      if (!thief || !victim) return null;
      return { type: "steal", thief, victim, resource: resource || undefined };
    }

    if (player && /\bgot\b/.test(text) && !/\bgave\b/.test(text)) {
      const gains = allResources(node);
      if (!Object.keys(gains).length) return null;
      return { type: "roll_gain", player, gains };
    }
    if (player && /received starting resources/i.test(text)) {
      const gains = allResources(node);
      if (!Object.keys(gains).length) return null;
      return { type: "roll_gain", player, gains };
    }
    if (player && /\bplaced a\b/.test(text)) {
      const m = text.match(/placed a (Settlement|Road|City)/i);
      if (m) return { type: "place_free", player, item: m[1].toLowerCase() };
      return null;
    }
    if (player && /\bbuilt a\b/.test(text)) {
      const m = text.match(/built a (Road|Settlement|City)/i);
      if (m) return { type: "build", player, item: m[1].toLowerCase() };
      return null;
    }
    if (player && /\bbought\b/.test(text)) {
      return { type: "build", player, item: "devcard" };
    }
    if (player && /\bgave bank\b/.test(text)) {
      const give = between(node, /gave bank/i, /and took/i);
      const receive = after(node, /and took/i);
      return { type: "bank_trade", player, give, receive };
    }
    if (player && /took from bank/i.test(text)) {
      const cards = after(node, /took from bank/i);
      return { type: "year_of_plenty", player, cards };
    }
    if (player && /\bdiscarded\b/.test(text)) {
      const cards = after(node, /discarded/i);
      return { type: "discard", player, cards };
    }
    if (player && /\bgave\b/.test(text) && /\bgot\b/.test(text) && /\bfrom\b/.test(text)) {
      const spans = node.querySelectorAll('.messagePart-XeUsOgLX span[style*="color"]');
      const from = spans.length >= 2 ? spans[spans.length - 1].textContent.trim() : null;
      const gave = between(node, /\bgave\b/i, /\band got\b/i);
      const got = between(node, /\band got\b/i, /\bfrom\b/i);
      if (from) return { type: "player_trade", from: player, to: from, gave, got };
    }
    if (player && /\bused\b/.test(text)) {
      // Dev-card play announcement. The effect lands on following lines; here we
      // just decrement the player's unplayed dev-card count, and flag Knights so
      // Largest Army can be tracked. The card name sits in a tooltip span.
      if (/\bKnight\b/i.test(text)) return { type: "knight", player };
      return { type: "play_dev", player };
    }
    // TODO: Road Building (2 free roads) — capture wording, must not charge cost.
    return null;
  }

  // =========================================================================
  // 4) OVERLAY
  // =========================================================================
  const PANEL_ID = "catan-tracker-panel";
  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);
    const el = document.createElement("div");
    el.id = PANEL_ID;
    el.innerHTML = `
      <style>
        #${PANEL_ID}{position:fixed;top:84px;right:14px;z-index:99999;
          width:300px;font-family:"Segoe UI",system-ui,sans-serif;
          background:rgba(17,21,28,.94);backdrop-filter:blur(7px);
          color:#e8eaed;border:1px solid #2b3340;border-radius:12px;
          box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden;font-size:13px;}
        #${PANEL_ID} .ctt-head{display:flex;align-items:center;justify-content:space-between;
          padding:10px 13px;background:#0e1116;border-bottom:1px solid #2b3340;cursor:move;}
        #${PANEL_ID} .ctt-title{font-weight:700;letter-spacing:.4px;font-size:12px;color:#cdd3db;}
        #${PANEL_ID} .ctt-btn{cursor:pointer;color:#7d8794;font-size:13px;padding:0 5px;user-select:none;}
        #${PANEL_ID} .ctt-btn:hover{color:#e8eaed;}
        #${PANEL_ID} .ctt-body{padding:8px 9px 10px;}
        #${PANEL_ID} .ctt-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;
          border:1px solid transparent;}
        #${PANEL_ID} .ctt-row + .ctt-row{margin-top:4px;}
        #${PANEL_ID} .ctt-row.active{background:rgba(240,180,41,.09);border-color:rgba(240,180,41,.35);}
        #${PANEL_ID} .ctt-namecol{flex:0 0 80px;display:flex;flex-direction:column;gap:2px;min-width:0;}
        #${PANEL_ID} .ctt-name{font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;
          text-overflow:ellipsis;display:flex;align-items:center;gap:4px;}
        #${PANEL_ID} .ctt-badges{display:flex;gap:3px;height:13px;}
        #${PANEL_ID} .ctt-badge{font-size:9px;line-height:13px;padding:0 4px;border-radius:4px;
          font-weight:700;letter-spacing:.2px;}
        #${PANEL_ID} .ctt-badge.army{background:#7c2d12;color:#fdba74;}
        #${PANEL_ID} .ctt-badge.road{background:#1e3a5f;color:#93c5fd;}
        #${PANEL_ID} .ctt-badge.turn{background:#f0b429;color:#1a1d23;}
        #${PANEL_ID} .ctt-cards{display:flex;gap:9px;flex:1;justify-content:flex-end;align-items:center;}
        #${PANEL_ID} .ctt-card{display:flex;flex-direction:column;align-items:center;gap:1px;
          font-variant-numeric:tabular-nums;}
        #${PANEL_ID} .ctt-icon{width:13px;height:18px;object-fit:contain;opacity:.92;display:block;}
        #${PANEL_ID} .ctt-glyph{font-size:12px;line-height:18px;}
        #${PANEL_ID} .ctt-num{font-size:12px;font-weight:600;text-align:center;color:#e8eaed;}
        #${PANEL_ID} .ctt-num.zero{color:#3f4754;font-weight:400;}
        #${PANEL_ID} .ctt-num.range{color:#f0b429;}
        #${PANEL_ID} .ctt-meta{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;
          gap:1px;margin-left:4px;min-width:30px;}
        #${PANEL_ID} .ctt-total{font-size:13px;font-weight:700;color:#e8eaed;font-variant-numeric:tabular-nums;}
        #${PANEL_ID} .ctt-total.range{color:#f0b429;}
        #${PANEL_ID} .ctt-total.mismatch{color:#ef4444;text-decoration:underline dotted;cursor:help;}
        #${PANEL_ID} .ctt-sub{display:flex;align-items:center;gap:5px;margin-top:1px;}
        #${PANEL_ID} .ctt-vp{font-size:10px;color:#fcd34d;}
        #${PANEL_ID} .ctt-dev{font-size:10px;color:#a78bfa;display:flex;align-items:center;gap:2px;}
        #${PANEL_ID} .ctt-dev img{width:8px;height:11px;object-fit:contain;}
        #${PANEL_ID} .ctt-empty{padding:18px 12px;color:#7d8794;font-size:12px;text-align:center;line-height:1.6;}
        #${PANEL_ID}.ctt-collapsed .ctt-body{display:none;}
        #${PANEL_ID} .ctt-foot{padding:6px 13px;border-top:1px solid #2b3340;color:#5b6470;font-size:10px;
          display:flex;justify-content:space-between;}
        /* log section */
        #${PANEL_ID} .ctt-log{display:none;border-top:1px solid #2b3340;background:#0b0e13;}
        #${PANEL_ID}.ctt-logopen .ctt-log{display:block;}
        #${PANEL_ID} .ctt-log-head{display:flex;align-items:center;justify-content:space-between;
          padding:6px 11px;border-bottom:1px solid #1b2129;}
        #${PANEL_ID} .ctt-log-title{font-size:10px;font-weight:700;letter-spacing:.4px;color:#7d8794;}
        #${PANEL_ID} .ctt-log-actions{display:flex;gap:8px;}
        #${PANEL_ID} .ctt-log-btn{cursor:pointer;font-size:10px;color:#7d8794;user-select:none;
          padding:1px 6px;border:1px solid #2b3340;border-radius:4px;}
        #${PANEL_ID} .ctt-log-btn:hover{color:#e8eaed;border-color:#3a4452;}
        #${PANEL_ID} .ctt-log-btn.on{color:#f0b429;border-color:#5b4a1a;}
        #${PANEL_ID} .ctt-log-list{max-height:200px;overflow-y:auto;padding:6px 11px;
          font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:11px;line-height:1.55;
          color:#aeb6c0;white-space:pre-wrap;word-break:break-word;}
        #${PANEL_ID} .ctt-log-line{padding:1px 0;}
        #${PANEL_ID} .ctt-log-line.skip{color:#5b6470;}
        #${PANEL_ID} .ctt-log-list::-webkit-scrollbar{width:8px;}
        #${PANEL_ID} .ctt-log-list::-webkit-scrollbar-thumb{background:#2b3340;border-radius:4px;}
      </style>
      <div class="ctt-head">
        <span class="ctt-title">CARD TRACKER</span>
        <span>
          <span class="ctt-btn" data-act="log" title="Show/hide game log">📋</span>
          <span class="ctt-btn" data-act="debug" title="Toggle console debug logging">⚙</span>
          <span class="ctt-btn" data-act="reset" title="Reset counts">⟳</span>
          <span class="ctt-btn" data-act="toggle" title="Collapse">–</span>
        </span>
      </div>
      <div class="ctt-body"><div class="ctt-empty">Waiting for the game log…<br>Play or refresh after a few actions.</div></div>
      <div class="ctt-log">
        <div class="ctt-log-head">
          <span class="ctt-log-title">GAME LOG</span>
          <span class="ctt-log-actions">
            <span class="ctt-log-btn" data-act="log-skips" title="Include lines the tracker ignored">skips</span>
            <span class="ctt-log-btn" data-act="log-copy" title="Copy log to clipboard">copy</span>
            <span class="ctt-log-btn" data-act="log-clear" title="Clear log">clear</span>
          </span>
        </div>
        <div class="ctt-log-list"></div>
      </div>
      <div class="ctt-foot"><span data-foot="status">idle</span><span data-foot="count">0 events</span></div>
    `;
    document.body.appendChild(el);

    // dragging
    const head = el.querySelector(".ctt-head");
    let drag = null;
    head.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("ctt-btn")) return;
      const r = el.getBoundingClientRect();
      drag = { x: e.clientX - r.left, y: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      el.style.left = (e.clientX - drag.x) + "px";
      el.style.top = (e.clientY - drag.y) + "px";
      el.style.right = "auto";
    });
    window.addEventListener("mouseup", () => (drag = null));

    el.querySelector('[data-act="toggle"]').addEventListener("click", () => {
      el.classList.toggle("ctt-collapsed");
      el.querySelector('[data-act="toggle"]').textContent = el.classList.contains("ctt-collapsed") ? "+" : "–";
    });
    el.querySelector('[data-act="reset"]').addEventListener("click", () => {
      if (confirm("Reset all tracked counts? Use this if the tracker started mid-game and is out of sync.")) {
        window.__catanReset && window.__catanReset();
      }
    });
    el.querySelector('[data-act="debug"]').addEventListener("click", () => {
      DEBUG = !DEBUG;
      const btn = el.querySelector('[data-act="debug"]');
      btn.style.color = DEBUG ? "#f0b429" : "";
      console.log("[catan] debug", DEBUG ? "ON — open console to watch parsed events" : "OFF");
    });
    el.querySelector('[data-act="log"]').addEventListener("click", () => {
      el.classList.toggle("ctt-logopen");
      el.querySelector('[data-act="log"]').style.color = el.classList.contains("ctt-logopen") ? "#f0b429" : "";
      renderLog();
    });
    el.querySelector('[data-act="log-skips"]').addEventListener("click", (e) => {
      showSkips = !showSkips;
      e.target.classList.toggle("on", showSkips);
      renderLog();
    });
    el.querySelector('[data-act="log-copy"]').addEventListener("click", () => {
      const text = logEntries
        .filter((en) => showSkips || en.kind !== "skip")
        .map((en) => en.text)
        .join("\n");
      navigator.clipboard.writeText(text).then(
        () => flash(el.querySelector('[data-act="log-copy"]'), "copied!"),
        () => flash(el.querySelector('[data-act="log-copy"]'), "blocked")
      );
    });
    el.querySelector('[data-act="log-clear"]').addEventListener("click", () => {
      logEntries.length = 0;
      renderLog();
    });
    return el;
  }

  // Briefly change a button's text to give click feedback, then restore.
  function flash(btn, msg) {
    const prev = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => (btn.textContent = prev), 1100);
  }

  function renderPanel(state, meta) {
    const el = buildPanel();
    const body = el.querySelector(".ctt-body");
    const truth = state.truth || {};
    // Show every player we know about from either source.
    const names = Array.from(new Set([...Object.keys(state.players), ...Object.keys(truth)]))
      .filter((n) => n !== "You");
    el.querySelector('[data-foot="status"]').textContent = meta.status || "tracking";
    el.querySelector('[data-foot="count"]').textContent = meta.events + " events";

    if (!names.length) return;

    // Largest Army / Longest Road come straight from the game's own badges:
    // a player holds the title when their achievement count shows as the holder.
    // colonist marks the holder via these counts; we treat the max (>=3 army,
    // >=5 road) sole leader as holder, matching Catan rules.
    let armyHolder = null, armyMax = 2, roadHolder = null, roadMax = 4;
    for (const name of names) {
      const a = truth[name]?.army, r = truth[name]?.road;
      if (a != null) { if (a > armyMax) { armyMax = a; armyHolder = name; } else if (a === armyMax) armyHolder = null; }
      if (r != null) { if (r > roadMax) { roadMax = r; roadHolder = name; } else if (r === roadMax) roadHolder = null; }
    }

    let html = "";
    for (const name of names) {
      const p = state.players[name] || { min: emptyHand(), max: emptyHand(), devCards: 0, knights: 0 };
      const t = truth[name] || {};
      const color = state.colors[name] || "#9aa4b2";

      // Per-resource breakdown (which cards) — the estimate.
      let cards = "", sumMin = 0, sumMax = 0;
      for (const r of RESOURCES) {
        const lo = p.min[r], hi = p.max[r];
        sumMin += lo; sumMax += hi;
        const exact = lo === hi;
        const cls = exact ? (lo === 0 ? "zero" : "") : "range";
        const val = exact ? String(lo) : `${lo}–${hi}`;
        cards += `<span class="ctt-card">` +
          `<img class="ctt-icon" src="${RESOURCE_ICON[r]}" alt="" ` +
          `onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ctt-glyph',textContent:'${RESOURCE_GLYPH[r]}'}))">` +
          `<span class="ctt-num ${cls}">${val}</span></span>`;
      }

      // TOTAL: authoritative game count when available, else our estimate.
      const realTotal = t.cards;
      let totLabel, totCls = "", totTitle = "";
      if (realTotal != null) {
        totLabel = String(realTotal);
        // Reconcile: if our known minimum already exceeds the real total, or the
        // real total exceeds our max, something's off — flag it.
        if (sumMin > realTotal || (sumMax < realTotal && sumMin !== sumMax)) {
          totCls = "mismatch"; totTitle = `breakdown ${sumMin}–${sumMax} vs game ${realTotal} (out of sync?)`;
        } else if (realTotal > sumMin) {
          // We can't fully attribute the total — some cards unknown.
          totTitle = `${realTotal} cards; ${realTotal - sumMin} not yet attributed`;
        }
      } else {
        totLabel = sumMin === sumMax ? `${sumMin}` : `${sumMin}–${sumMax}`;
        totCls = sumMin === sumMax ? "" : "range";
      }

      // DEV count: authoritative when available.
      const devCount = t.dev != null ? t.dev : p.devCards;
      const dev = devCount > 0
        ? `<span class="ctt-dev" title="${devCount} dev card(s)"><img src="${DEV_ICON}" alt="dev">${devCount}</span>`
        : "";

      const vp = t.vp != null ? `<span class="ctt-vp" title="Victory points">${t.vp}★</span>` : "";

      const display = name.length > 10 ? name.slice(0, 9) + "…" : name;
      const isTurn = state.turn === name;
      const badges =
        (isTurn ? `<span class="ctt-badge turn" title="Current turn">TURN</span>` : "") +
        (armyHolder === name ? `<span class="ctt-badge army" title="Largest Army">ARMY</span>` : "") +
        (roadHolder === name ? `<span class="ctt-badge road" title="Longest Road">ROAD</span>` : "");

      html += `<div class="ctt-row ${isTurn ? "active" : ""}">
        <span class="ctt-namecol">
          <span class="ctt-name" style="color:${color}" title="${name}">${display}</span>
          <span class="ctt-badges">${badges}</span>
        </span>
        <span class="ctt-cards">${cards}</span>
        <span class="ctt-meta">
          <span class="ctt-total ${totCls}" title="${totTitle}">${totLabel}</span>
          <span class="ctt-sub">${vp}${dev}</span>
        </span>
      </div>`;
    }
    body.innerHTML = html;
  }

  // =========================================================================
  // 5) OBSERVER  (virtual-scroller aware: dedupe by data-index)
  // =========================================================================
  let state = createState();
  let processed = new Set();   // data-index values already applied
  let eventCount = 0;

  // ---- human-readable game log ---------------------------------------------
  const logEntries = [];   // { kind: "event"|"skip", text }
  let showSkips = false;

  const ICON_WORD = { wood: "wood", brick: "brick", sheep: "sheep", wheat: "wheat", ore: "ore" };
  function fmtCards(obj) {
    if (!obj) return "";
    const parts = [];
    for (const r of RESOURCES) if (obj[r]) parts.push(`${obj[r]} ${ICON_WORD[r]}`);
    return parts.join(", ");
  }
  // Turn a parsed event into a plain-English line.
  function describeEvent(ev) {
    switch (ev.type) {
      case "roll": return `— ${ev.player}'s turn —`;
      case "roll_gain": return `${ev.player} got ${fmtCards(ev.gains)}`;
      case "build": return ev.item === "devcard"
        ? `${ev.player} bought a dev card`
        : `${ev.player} built a ${ev.item}`;
      case "place_free": return `${ev.player} placed a ${ev.item} (free)`;
      case "bank_trade": return `${ev.player} traded ${fmtCards(ev.give)} → ${fmtCards(ev.receive)} (bank)`;
      case "player_trade": return `${ev.from} gave ${fmtCards(ev.gave)} → got ${fmtCards(ev.got)} from ${ev.to}`;
      case "steal": return ev.resource
        ? `${ev.thief} stole ${ev.resource} from ${ev.victim}`
        : `${ev.thief} stole 1 (hidden) from ${ev.victim}`;
      case "discard": return `${ev.player} discarded ${fmtCards(ev.cards)}`;
      case "year_of_plenty": return `${ev.player} took ${fmtCards(ev.cards)} (Year of Plenty)`;
      case "monopoly_haul": return `${ev.player} monopolized ${ev.count} ${ev.resource}`;
      case "knight": return `${ev.player} played a Knight`;
      case "play_dev": return `${ev.player} played a dev card`;
      default: return ev.type;
    }
  }
  function renderLog() {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    const list = el.querySelector(".ctt-log-list");
    if (!list) return;
    const rows = logEntries.filter((en) => showSkips || en.kind !== "skip");
    list.innerHTML = rows.map((en) =>
      `<div class="ctt-log-line ${en.kind === "skip" ? "skip" : ""}">${escapeHtml(en.text)}</div>`
    ).join("") || `<div class="ctt-log-line skip">No events yet.</div>`;
    list.scrollTop = list.scrollHeight; // keep latest in view
  }
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }


  window.__catanReset = function () {
    state = createState();
    processed = new Set();
    eventCount = 0;
    logEntries.length = 0;
    renderLog();
    renderPanel(state, { status: "reset", events: 0 });
  };

  function recordColor(node, ev) {
    // remember each player's colonist color for the overlay
    const c = colorOf(node);
    if (!c) return;
    const who = ev.player || ev.from || ev.thief;
    if (who && !state.colors[who]) state.colors[who] = c;
    // also victim span (second colored span), if any
    const spans = node.querySelectorAll('.messagePart-XeUsOgLX span[style*="color"]');
    if (spans.length >= 2 && ev.to) {
      const m = (spans[spans.length - 1].getAttribute("style") || "").match(/color:\s*(#[0-9a-fA-F]{3,6})/);
      if (m && !state.colors[ev.to]) state.colors[ev.to] = m[1];
    }
  }

  function processNode(node) {
    const idx = node.getAttribute("data-index");
    if (idx === null) return;
    if (processed.has(idx)) return;
    processed.add(idx);
    let ev;
    try { ev = parseLogLine(node); } catch (e) {
      if (DEBUG) console.warn("[catan] parse error on", idx, e);
      return;
    }
    if (!ev) {
      const t = msgText(node);
      if (t) {  // skip separators/empties
        logEntries.push({ kind: "skip", text: `· (ignored) ${t}` });
        renderLog();
        if (DEBUG) console.log("%c[catan] no-event", "color:#7d8794", `#${idx}`, JSON.stringify(t.slice(0, 80)));
      }
      return;
    }
    recordColor(node, ev);
    applyEvent(state, ev);
    resolveYou();
    eventCount++;
    logEntries.push({ kind: "event", text: describeEvent(ev) });
    renderLog();
    if (DEBUG) {
      console.log("%c[catan] event", "color:#5b9bd5", `#${idx}`, ev);
      console.log("%c[catan] hands", "color:#70ad47", snapshotForLog(state));
    }
    renderPanel(state, { status: "tracking", events: eventCount });
  }

  // Compact hands snapshot for console logging.
  function snapshotForLog(state) {
    const out = {};
    for (const [name, p] of Object.entries(state.players)) {
      const parts = [];
      for (const r of RESOURCES) {
        const v = p.min[r] === p.max[r] ? p.min[r] : `${p.min[r]}-${p.max[r]}`;
        if (v !== 0) parts.push(`${r}:${v}`);
      }
      out[name] = parts.join(" ") || "—";
    }
    return out;
  }

  // ---- "You" identity resolution -------------------------------------------
  // The log refers to the local player as "You" in steals, but that same player
  // also appears under their real colonist name elsewhere. Left alone, this
  // creates a phantom "You" entry. We detect the real name from the page and
  // merge the phantom into it. Detection is retroactive-safe: whenever the name
  // becomes known, any accumulated "You" state folds into the real player.
  let youName = null;

  function mergePlayers(state, fromName, intoName) {
    if (fromName === intoName) return;
    const from = state.players[fromName];
    if (!from) return;
    const into = ensurePlayer(state, intoName);
    for (const r of RESOURCES) { into.min[r] += from.min[r]; into.max[r] += from.max[r]; }
    into.devCards += from.devCards || 0;
    into.knights += from.knights || 0;
    delete state.players[fromName];
    // repoint any steal records that referenced the phantom
    for (const s of state.steals) {
      if (s.thief === fromName) s.thief = intoName;
      if (s.victim === fromName) s.victim = intoName;
    }
    if (state.colors[fromName] && !state.colors[intoName]) state.colors[intoName] = state.colors[fromName];
    delete state.colors[fromName];
    if (state.turn === fromName) state.turn = intoName;
  }

  // Try to read the local player's real name from colonist's player panel.
  // colonist marks the local player's seat; we look for common markers and fall
  // back to scanning for a name that the log uses but that is also tagged "you".
  function detectYouName() {
    if (youName) return youName;
    // 1) Player panels carry the seat owner's name; the local player's panel is
    //    usually distinguished. Try a few selectors colonist has used.
    const sel = [
      ".player-info-name", "[class*='playerUsername']", "[class*='player_name']",
      "[class*='username']",
    ];
    // 2) Most robust observed signal: the "settings"/self menu shows your name.
    //    Search visible elements whose text matches a known game participant.
    const known = new Set(Object.keys(state.players).filter((n) => n !== "You"));
    for (const q of sel) {
      for (const el of document.querySelectorAll(q)) {
        const t = (el.textContent || "").trim();
        if (t && known.has(t)) { youName = t; return youName; }
      }
    }
    return null;
  }

  // Allow manual override from the console if auto-detect ever fails:
  //   __catanSetName("YourColonistName#1234")
  window.__catanSetName = function (name) {
    youName = name;
    mergePlayers(state, "You", name);
    renderPanel(state, { status: "tracking", events: eventCount });
    console.log("[catan] local player set to", name);
  };

  // Called after each event: if we can resolve "You" to a real name, merge.
  function resolveYou() {
    if (!state.players["You"]) return;       // no phantom to merge
    const real = youName || detectYouName();
    if (real && real !== "You") mergePlayers(state, "You", real);
  }

  function scanAll(container) {
    for (const node of container.querySelectorAll(".scrollItemContainer-WXX2rkzf")) processNode(node);
  }

  // ---- authoritative player-panel reader -----------------------------------
  // colonist's side panel shows each player's TRUE totals: resource-card count,
  // dev-card count, victory points, largest-army count, longest-road segments,
  // and player color. We read these as ground truth. Your own row is NOT an
  // "opponentPlayerRow", which is how we auto-detect "You".
  const COLOR_CLASS = {
    red: "#CF4449", orange: "#CF6B2E", blue: "#285FBD", green: "#228103",
    white: "#d8dde3", brown: "#8a5a2b",
  };
  function readPlayerPanel() {
    const rows = document.querySelectorAll(".playerRow-RMhJ5mpg");
    if (!rows.length) return;
    state.truth = state.truth || {};
    let detectedYou = null;
    for (const row of rows) {
      const nameEl = row.querySelector(".username-M7Jbo6j0");
      if (!nameEl) continue;
      const name = nameEl.textContent.trim();
      const isOpponent = row.classList.contains("opponentPlayerRow-AYNGolhx");
      if (!isOpponent) detectedYou = name; // your own row

      const resEl = row.querySelector('[data-resource-card="true"] .count-Dh6MtdiN');
      const devEl = row.querySelector('[data-development-card="true"] .count-Dh6MtdiN');
      const vpEl = row.querySelector(".victoryPoints-u0xGd7sj");
      const achs = row.querySelectorAll(".achievementItem-frxefOzP .achievementCount-CobfrMoe");
      const num = (el) => { const n = parseInt((el?.textContent || "").trim(), 10); return isNaN(n) ? null : n; };

      state.truth[name] = {
        cards: num(resEl),
        dev: num(devEl),
        vp: num(vpEl),
        army: achs[0] ? num(achs[0]) : null,
        road: achs[1] ? num(achs[1]) : null,
      };

      // color from the avatar wrapper class (e.g. "blue-JPbw6Gaq")
      const av = row.querySelector("[class*='avatar-wo8dAsb3'], .avatarWrapper-bai5xF5I div");
      if (av) {
        for (const cls of (row.querySelector("[class*='hasBackground']")?.className || "").split(/\s+/)) {
          const key = cls.split("-")[0];
          if (COLOR_CLASS[key] && !state.colors[name]) state.colors[name] = COLOR_CLASS[key];
        }
      }
    }
    // Auto-resolve "You" using the detected own-row name.
    if (detectedYou && !youName) { youName = detectedYou; }
    if (state.players["You"] && youName) mergePlayers(state, "You", youName);

    renderPanel(state, { status: "tracking", events: eventCount });
  }

  function start() {
    const container = document.querySelector(".virtualScroller-lSkdkGJi");
    if (!container) return false;
    buildPanel();
    scanAll(container);
    const obs = new MutationObserver(() => scanAll(container));
    obs.observe(container, { childList: true, subtree: true });

    // Second observer: the player panel (authoritative totals). It may live in a
    // different part of the DOM; observe the whole document body for changes to
    // any player row, throttled.
    readPlayerPanel();
    let pending = false;
    const panelObs = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; readPlayerPanel(); });
    });
    const panelRoot = document.querySelector(".playerRow-RMhJ5mpg")?.closest("[class*='ScrollContainer'], body") || document.body;
    panelObs.observe(panelRoot, { childList: true, subtree: true, characterData: true });

    renderPanel(state, { status: "tracking", events: eventCount });
    return true;
  }

  // The log container appears only once a game is loaded. Poll until present.
  const boot = setInterval(() => {
    if (start()) clearInterval(boot);
  }, 1500);

})();
