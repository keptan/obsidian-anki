import { describe, expect, it } from "vitest";
import type { AnkiNote } from "../src/anki";
import type { PluginState } from "../src/domain";
import { parseMarkdown } from "../src/parser";
import { fingerprint } from "../src/render";
import { isZeroingPlan, planSync, SyncEngine } from "../src/sync";

describe("sync planning", () => {
  it("separates creates, updates, unchanged, and removals", () => {
    const cards = parseMarkdown(
      "Same::A\n^af-same\nChanged::B\n^af-changed\nNew::C\n^af-new\n",
    ).cards;
    const state: PluginState = {
      version: 1,
      cards: {
        same: { noteId: 1, fingerprint: fingerprint(cards[0]!) },
        changed: { noteId: 2, fingerprint: "old" },
        gone: { noteId: 3, fingerprint: "old" },
      },
    };
    const note = (noteId: number): AnkiNote => ({
      noteId,
      modelName: "",
      tags: [],
      fields: {},
    });
    const plan = planSync(
      cards,
      state,
      new Map([
        [1, note(1)],
        [2, note(2)],
        [3, note(3)],
      ]),
    );
    expect(plan.unchanged).toBe(1);
    expect(plan.update.map((x) => x.noteId)).toEqual([2]);
    expect(plan.create.map((x) => x.key)).toEqual(["new"]);
    expect(plan.remove).toEqual([3]);
  });
  it("never deletes state owned by another file", () => {
    const state: PluginState = {
      version: 1,
      cards: { other: { noteId: 99, fingerprint: "x", filePath: "other.md" } },
    };
    expect(planSync([], state, new Map(), "current.md").remove).toEqual([]);
  });
  it("identifies a plan that deletes every card owned by a file", () => {
    const state: PluginState = {
      version: 1,
      cards: {
        one: { noteId: 1, fingerprint: "x", filePath: "note.md" },
        two: { noteId: 2, fingerprint: "x", filePath: "note.md" },
      },
    };
    const plan = planSync([], state, new Map(), "note.md");
    expect(plan.remove).toEqual([1, 2]);
    expect(isZeroingPlan(plan)).toBe(true);
  });
  it("plans an update when only the destination deck changes", () => {
    const card = parseMarkdown("Question::Answer\n^af-key\n").cards[0]!;
    const state: PluginState = {
      version: 1,
      cards: {
        key: {
          noteId: 7,
          fingerprint: fingerprint(card),
          deck: "Old",
          filePath: "note.md",
        },
      },
    };
    const existing = new Map<number, AnkiNote>([
      [7, { noteId: 7, modelName: "", tags: [], fields: {} }],
    ]);
    const plan = planSync([card], state, existing, "note.md", "New");
    expect(plan.update.map((item) => item.noteId)).toEqual([7]);
  });
});

describe("fault isolation", () => {
  it("preserves user-defined fields on Forge note models", async () => {
    const cards = parseMarkdown("Question::Answer\n^af-safe\n").cards;
    const removed: string[] = [];
    const fake = {
      modelNames: async () => ["Anki Forge Basic"],
      modelFieldNames: async () => [
        "Front",
        "Back",
        "Extra",
        "ForgeKey",
        "Mnemonic",
      ],
      modelFieldAdd: async () => null,
      modelFieldRemove: async (_model: string, field: string) => {
        removed.push(field);
        return null;
      },
      modelFieldReposition: async () => null,
      updateModelTemplates: async () => null,
      updateModelStyling: async () => null,
      createModel: async () => 1,
      createDeck: async () => 1,
      addNote: async () => 42,
      deleteNotes: async () => null,
    };

    await new SyncEngine(fake as never).apply(
      { cards, create: cards, update: [], remove: [], unchanged: 0 },
      createStateForTest(),
      "Default",
      "source",
    );

    expect(removed).toEqual([]);
  });

  it("continues creating cards after a duplicate is rejected", async () => {
    const cards = parseMarkdown(
      "Duplicate::A\n^af-dup\nValid::B\n^af-ok\n",
    ).cards;
    const fake = {
      modelNames: async () => [
        "Anki Forge Basic",
        "Anki Forge Basic (reversed)",
        "Anki Forge Cloze",
      ],
      modelFieldNames: async () => [
        "Front",
        "Back",
        "Text",
        "Extra",
        "ForgeKey",
        "ForgeMarkdown",
      ],
      modelFieldAdd: async () => null,
      modelFieldRemove: async () => null,
      modelFieldReposition: async () => null,
      updateModelTemplates: async () => null,
      updateModelStyling: async () => null,
      createModel: async () => 1,
      createDeck: async () => 1,
      addNote: async (note: { fields: Record<string, string> }) =>
        note.fields.Front?.includes("Duplicate") ? null : 42,
      canAddNotesWithErrorDetail: async () => [
        { canAdd: false, error: "duplicate" },
      ],
      multi: async () => [],
      deleteNotes: async () => null,
      findCards: async () => [],
      changeDeck: async () => null,
    };
    const state: PluginState = { version: 1, cards: {} };
    const summary = await new SyncEngine(fake as never).apply(
      { cards, create: cards, update: [], remove: [], unchanged: 0 },
      state,
      "Default",
      "source",
      "",
      ["obsidian"],
    );
    expect(summary.created).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(state.cards.ok?.noteId).toBe(42);
  });
  it("does not record a failed update as synchronized", async () => {
    const cards = parseMarkdown(
      "Broken::A\n^af-broken\nValid::B\n^af-valid\n",
    ).cards;
    const note = (noteId: number): AnkiNote => ({
      noteId,
      modelName: "Anki Forge Basic",
      tags: [],
      fields: {},
      cards: [],
    });
    const fake = {
      modelNames: async () => ["Anki Forge Basic"],
      modelFieldNames: async () => ["Front", "Back", "Extra", "ForgeKey"],
      modelFieldAdd: async () => null,
      modelFieldRemove: async () => null,
      modelFieldReposition: async () => null,
      updateModelTemplates: async () => null,
      updateModelStyling: async () => null,
      createModel: async () => 1,
      createDeck: async () => 1,
      updateNoteFields: async (id: number) => {
        if (id === 1) throw new Error("bad field");
        return null;
      },
      addTags: async () => null,
      removeTags: async () => null,
      findCards: async () => [],
      changeDeck: async () => null,
      deleteNotes: async () => null,
    };
    const state: PluginState = {
      version: 1,
      cards: {
        broken: { noteId: 1, fingerprint: "old" },
        valid: { noteId: 2, fingerprint: "old" },
      },
    };
    const summary = await new SyncEngine(fake as never).apply(
      {
        cards,
        create: [],
        update: [
          { card: cards[0]!, noteId: 1, existing: note(1) },
          { card: cards[1]!, noteId: 2, existing: note(2) },
        ],
        remove: [],
        unchanged: 0,
      },
      state,
      "Default",
      "source",
    );
    expect(summary.updated).toBe(1);
    expect(summary.failures).toEqual(["Line 1: bad field"]);
    expect(state.cards.broken?.fingerprint).toBe("old");
    expect(state.cards.valid?.fingerprint).toBe(fingerprint(cards[1]!));
  });
});

function createStateForTest(): PluginState {
  return { version: 1, cards: {} };
}
