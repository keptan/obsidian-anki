import type { PluginState } from "./domain";

const unsafeCardKeys = new Set(["__proto__", "constructor", "prototype"]);

/** Create a card lookup that cannot inherit or mutate Object.prototype. */
export function createState(): PluginState {
  return {
    version: 1,
    cards: Object.create(null) as PluginState["cards"],
  };
}

/** Copy persisted data into a safe lookup and discard reserved property names. */
export function loadState(persisted?: PluginState): PluginState {
  const state = createState();
  if (!persisted?.cards) return state;
  for (const [key, card] of Object.entries(persisted.cards))
    if (!unsafeCardKeys.has(key)) state.cards[key] = card;
  return state;
}
