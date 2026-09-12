import type { AnkiCreateNote, AnkiNote } from "./anki";
import { AnkiClient } from "./anki";
import type { ParsedCard, PluginState } from "./domain";
import { fingerprint, renderCard, snapshot } from "./render";

export interface SyncPlan {
  cards: ParsedCard[];
  create: ParsedCard[];
  update: { card: ParsedCard; noteId: number; existing: AnkiNote }[];
  remove: number[];
  unchanged: number;
}
export interface SyncSummary {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  failures: string[];
}

export const isZeroingPlan = (plan: SyncPlan): boolean =>
  plan.cards.length === 0 && plan.remove.length > 0;

const model = (card: ParsedCard) =>
  card.kind === "cloze"
    ? "Anki Forge Cloze"
    : card.kind === "reversed"
      ? "Anki Forge Basic (reversed)"
      : "Anki Forge Basic";

export function planSync(
  cards: ParsedCard[],
  state: PluginState,
  existing: Map<number, AnkiNote>,
  filePath = "",
  deck = "",
): SyncPlan {
  const liveKeys = new Set(
    cards.map((c) => c.key).filter((x): x is string => Boolean(x)),
  );
  const create: ParsedCard[] = [];
  const update: SyncPlan["update"] = [];
  let unchanged = 0;
  for (const card of cards) {
    const stored = card.key ? state.cards[card.key] : undefined;
    const noteId = stored?.noteId;
    const hash = fingerprint(card);
    if (!noteId || !existing.has(noteId)) create.push(card);
    else if (
      !stored ||
      stored.fingerprint !== hash ||
      (deck.length > 0 && stored.deck !== deck)
    )
      update.push({ card, noteId, existing: existing.get(noteId)! });
    else unchanged++;
  }
  const remove = Object.entries(state.cards)
    .filter(
      ([key, value]) =>
        (!filePath || value.filePath === filePath) && !liveKeys.has(key),
    )
    .map(([, value]) => value.noteId);
  return { cards, create, update, remove, unchanged };
}

export class SyncEngine {
  constructor(private readonly anki: AnkiClient) {}
  async apply(
    plan: SyncPlan,
    state: PluginState,
    deck: string,
    sourceLink: string,
    filePath = "",
    managedTags: string[] = [],
  ): Promise<SyncSummary> {
    const summary: SyncSummary = {
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: plan.unchanged,
      failures: [],
    };
    await this.ensureModels(plan.cards);
    await this.anki.createDeck(deck);
    if (plan.create.length) {
      const notes: AnkiCreateNote[] = plan.create.map((card) => ({
        deckName: deck,
        modelName: model(card),
        fields: renderCard(card, sourceLink),
        tags: [...new Set([...card.tags, ...managedTags])],
        // ForgeKey, not first-field text, is the identity. Anki's native
        // duplicate check rejects legitimate clozes/basic cards that happen
        // to share text and often reports only "unknown reason".
        options: { allowDuplicate: true },
      }));
      // A duplicate or malformed note must not abort creation of unrelated cards.
      // Keep a small worker pool so large notes remain fast without flooding AnkiConnect.
      let cursor = 0;
      const worker = async () => {
        while (cursor < notes.length) {
          const index = cursor++;
          const note = notes[index];
          const card = plan.create[index];
          if (!note || !card) continue;
          try {
            const id = await this.addNote(note);
            if (card.key)
              state.cards[card.key] = {
                noteId: id,
                fingerprint: fingerprint(card),
                deck,
                source: snapshot(card),
                remote: snapshot(card),
                filePath,
              };
            summary.created++;
          } catch (error) {
            summary.failures.push(
              `Line ${card.range.line}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(4, notes.length) }, worker),
      );
    }
    for (const { card, noteId, existing } of plan.update) {
      try {
        const wanted = new Set([...card.tags, ...managedTags]);
        const current = new Set(existing.tags);
        await this.anki.updateNoteFields(noteId, renderCard(card, sourceLink));
        const added = [...wanted].filter((tag) => !current.has(tag));
        const removed = [...current].filter((tag) => !wanted.has(tag));
        if (added.length) await this.anki.addTags([noteId], added.join(" "));
        if (removed.length)
          await this.anki.removeTags([noteId], removed.join(" "));
        const cardIds =
          existing.cards ?? (await this.anki.findCards(`nid:${noteId}`));
        await this.anki.changeDeck(cardIds, deck);
        if (card.key)
          state.cards[card.key] = {
            noteId,
            fingerprint: fingerprint(card),
            deck,
            source: snapshot(card),
            remote: snapshot(card),
            filePath,
          };
        summary.updated++;
      } catch (error) {
        summary.failures.push(
          `Line ${card.range.line}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await this.anki.deleteNotes(plan.remove);
    summary.deleted = plan.remove.length;
    for (const [key, stored] of Object.entries(state.cards))
      if (plan.remove.includes(stored.noteId)) delete state.cards[key];
    return summary;
  }

  private async addNote(note: AnkiCreateNote): Promise<number> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const id = await this.anki.addNote(note);
        if (id) return id;
        const detail = await this.anki.canAddNotesWithErrorDetail([note]);
        const reason = detail[0]?.error;
        if (reason) throw new Error(reason);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/unknown reason/i.test(message) || attempt === 2) throw error;
      }
      // Anki can briefly reject note generation immediately after its model
      // templates are updated, despite validating the same note successfully.
      await new Promise((resolve) =>
        window.setTimeout(resolve, 150 * (attempt + 1)),
      );
    }
    throw new Error("Anki rejected the note after retrying");
  }

  private async ensureModels(cards: ParsedCard[]) {
    const existing = new Set(await this.anki.modelNames());
    const css = `
.card{box-sizing:border-box;max-width:760px;margin:0 auto;padding:28px 22px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;font-size:20px;line-height:1.55;text-align:center;color:#25232a;background:#faf9fc}
.forge-card{width:100%}.forge-content>p:first-child{margin-top:0}.forge-content>p:last-child{margin-bottom:0}
.forge-answer{font-weight:500}.forge-divider{height:1px;border:0;background:#ddd8e5;margin:24px auto;max-width:560px}
.forge-tags{display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-top:20px}.forge-tag{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;background:#eee8ff;color:#6542a5;font-size:12px;font-weight:650;line-height:1.4}.forge-tag::before{content:"#";opacity:.65}
.forge-source{margin-top:22px;font-size:13px;opacity:.62}.forge-source p{margin:0}.forge-source a{color:inherit}
.card img{display:block;max-width:100%;max-height:70vh;width:auto;height:auto;margin:18px auto;border-radius:8px}
.card pre{overflow-x:auto;margin:18px 0;padding:14px 16px;text-align:left;border-radius:8px;background:#eeeaf2;font-size:14px;line-height:1.45}.card code{font-family:"SFMono-Regular",Consolas,monospace}.card :not(pre)>code{padding:2px 5px;border-radius:4px;background:#eeeaf2;font-size:.85em}
.card blockquote{margin:18px auto;padding:8px 16px;border-left:3px solid #8b6fc0;text-align:left;color:#5f5868}.card ul,.card ol{text-align:left;display:table;margin:16px auto}.card a{color:#6d48ae}.cloze{font-weight:750;color:#7251b5}
.nightMode.card,.night_mode .card{color:#e9e5ee;background:#1f1d23}.nightMode .forge-divider,.night_mode .forge-divider{background:#403b48}.nightMode .forge-tag,.night_mode .forge-tag{background:#382d50;color:#cdb9f5}.nightMode pre,.nightMode :not(pre)>code,.night_mode pre,.night_mode :not(pre)>code{background:#2d2933}.nightMode .cloze,.night_mode .cloze{color:#cbb4fa}
@media(max-width:480px){.card{padding:20px 14px;font-size:18px}.forge-divider{margin:20px auto}}
`;
    const tags = `<div class="forge-tags"><span class="forge-tags-raw">{{Tags}}</span></div><script>(()=>{document.querySelectorAll('.forge-tags:not([data-ready])').forEach(el=>{el.dataset.ready='1';const raw=el.querySelector('.forge-tags-raw');const values=(raw?.textContent||'').trim().split(/\\s+/).filter(Boolean);el.textContent='';values.forEach(value=>{const pill=document.createElement('span');pill.className='forge-tag';pill.textContent=value;el.appendChild(pill)});if(!values.length)el.remove()})})()</script>`;
    const basicFront = `<main class="forge-card"><section class="forge-content forge-question">{{Front}}</section>${tags}</main>`;
    const basicBack = `<main class="forge-card"><section class="forge-content forge-question">{{Front}}</section><hr class="forge-divider"><section class="forge-content forge-answer">{{Back}}</section>${tags}<footer class="forge-source">{{Extra}}</footer></main>`;
    const reverseFront = `<main class="forge-card"><section class="forge-content forge-question">{{Back}}</section>${tags}</main>`;
    const reverseBack = `<main class="forge-card"><section class="forge-content forge-question">{{Back}}</section><hr class="forge-divider"><section class="forge-content forge-answer">{{Front}}</section>${tags}<footer class="forge-source">{{Extra}}</footer></main>`;
    const clozeFront = `<main class="forge-card"><section class="forge-content forge-question">{{cloze:Cloze}}</section>${tags}</main>`;
    const clozeBack = `<main class="forge-card"><section class="forge-content forge-answer">{{cloze:Cloze}}</section>${tags}<footer class="forge-source">{{Extra}}</footer></main>`;
    const definitions = [
      {
        modelName: "Anki Forge Basic",
        inOrderFields: ["Front", "Back", "Extra", "ForgeKey"],
        css,
        cardTemplates: [
          { Name: "Front / Back", Front: basicFront, Back: basicBack },
        ],
      },
      {
        modelName: "Anki Forge Basic (reversed)",
        inOrderFields: ["Front", "Back", "Extra", "ForgeKey"],
        css,
        cardTemplates: [
          { Name: "Front / Back", Front: basicFront, Back: basicBack },
          { Name: "Back / Front", Front: reverseFront, Back: reverseBack },
        ],
      },
      {
        modelName: "Anki Forge Cloze",
        inOrderFields: ["Cloze", "Extra", "ForgeKey"],
        css,
        isCloze: true,
        cardTemplates: [{ Name: "Cloze", Front: clozeFront, Back: clozeBack }],
      },
    ];
    const required = new Set<string>(cards.map((card) => model(card)));
    for (const definition of definitions.filter((item) =>
      required.has(item.modelName),
    )) {
      if (!existing.has(definition.modelName))
        await this.anki.createModel(definition);
      else {
        const fields = await this.anki.modelFieldNames(definition.modelName);
        // Extra fields may contain user-authored data across the entire model.
        // Forge owns its required fields, but must not delete fields it did not create.
        for (const field of definition.inOrderFields)
          if (!fields.includes(field))
            await this.anki.modelFieldAdd(definition.modelName, field);
        for (const [index, field] of definition.inOrderFields.entries())
          await this.anki.modelFieldReposition(
            definition.modelName,
            field,
            index,
          );
        await this.anki.updateModelTemplates(
          definition.modelName,
          Object.fromEntries(
            definition.cardTemplates.map((template) => [
              template.Name,
              { Front: template.Front, Back: template.Back },
            ]),
          ),
        );
        await this.anki.updateModelStyling(definition.modelName, css);
      }
    }
  }
}
