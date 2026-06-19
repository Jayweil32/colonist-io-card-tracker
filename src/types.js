// types.js — shared constants & helpers (JSDoc typed for editor support)

/** The five resource types in Catan. */
export const RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"];

/** Building costs (resources spent). */
export const COSTS = {
  road:       { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city:       { ore: 3, wheat: 2 },
  devcard:    { sheep: 1, wheat: 1, ore: 1 },
};

/** @returns {{wood:number,brick:number,sheep:number,wheat:number,ore:number}} */
export function emptyHand() {
  return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
}

export function cloneHand(h) {
  return { wood: h.wood, brick: h.brick, sheep: h.sheep, wheat: h.wheat, ore: h.ore };
}

export function handTotal(h) {
  return RESOURCES.reduce((s, r) => s + h[r], 0);
}
