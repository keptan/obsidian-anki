import { describe, expect, it } from "vitest";
import type { PluginState } from "../src/domain";
import { createState, loadState } from "../src/state";

describe("plugin state", () => {
  it("stores untrusted card keys without inheriting Object.prototype", () => {
    const state = createState();

    expect(Object.getPrototypeOf(state.cards)).toBeNull();
    expect(state.cards.__proto__).toBeUndefined();

    state.cards.__proto__ = { noteId: 1, fingerprint: "changed" };

    expect(state.cards.__proto__?.noteId).toBe(1);
    expect((Object.prototype as { fingerprint?: string }).fingerprint).toBeUndefined();
  });

  it("sanitizes reserved keys while hydrating persisted state", () => {
    const persisted = JSON.parse(`{
      "version": 1,
      "cards": {
        "safe": { "noteId": 2, "fingerprint": "ok" },
        "__proto__": { "noteId": 3, "fingerprint": "bad" },
        "constructor": { "noteId": 4, "fingerprint": "bad" },
        "prototype": { "noteId": 5, "fingerprint": "bad" }
      }
    }`) as PluginState;

    const state = loadState(persisted);

    expect(Object.keys(state.cards)).toEqual(["safe"]);
    expect(state.cards.safe?.noteId).toBe(2);
    expect(Object.getPrototypeOf(state.cards)).toBeNull();
  });
});
