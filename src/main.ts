import { Notice, Plugin, TFile } from "obsidian";
import { AnkiClient } from "./anki";
import type { PluginState } from "./domain";
import {
  duplicateCardKeys,
  insertMarkers,
  type ParserOptions,
  parseMarkdown,
  removeForgeMarkers,
  separateInlineForgeMarkers,
} from "./parser";
import { DEFAULT_SETTINGS, type Settings, SettingsTab } from "./settings";
import { planSync, SyncEngine } from "./sync";
import { expandNoteEmbeds, uploadMedia } from "./media";
import { pullFromAnki } from "./pull";
import { ReportModal } from "./report-modal";
import { approveSync } from "./sync-preview-modal";
import { snapshot } from "./render";
import { createState, loadState } from "./state";

interface Data {
  settings: Settings;
  state: PluginState;
}
export default class AnkiForgePlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  private state: PluginState = createState();
  private running = new Set<string>();
  async onload() {
    const data = (await this.loadData()) as Partial<Data> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...data?.settings };
    this.state = loadState(data?.state);
    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note to Anki",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) void this.sync(file);
        return true;
      },
    });
    this.addRibbonIcon("layers", "Sync flashcards to Anki", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) void this.sync(file);
      else new Notice("Open a Markdown note first.");
    });
    this.addCommand({
      id: "sync-all-notes",
      name: "Sync all opted-in notes",
      callback: () =>
        void this.syncFiles(
          this.app.vault.getMarkdownFiles().filter((f) => this.hasAnkiDeck(f)),
        ),
    });
    this.addCommand({
      id: "sync-current-folder",
      name: "Sync opted-in notes in current folder",
      checkCallback: (checking) => {
        const folder = this.app.workspace.getActiveFile()?.parent?.path;
        if (folder === undefined) return false;
        if (!checking)
          void this.syncFiles(
            this.app.vault
              .getMarkdownFiles()
              .filter((f) => f.parent?.path === folder && this.hasAnkiDeck(f)),
          );
        return true;
      },
    });
    this.addSettingTab(new SettingsTab(this.app, this));
    const status = this.addStatusBarItem();
    const updateStatus = async () => {
      try {
        await new AnkiClient(this.settings.endpoint, 2_500).version();
        status.setText("Anki ⚡");
        status.setAttr("aria-label", "AnkiConnect is available");
      } catch {
        status.setText("Anki ○");
        status.setAttr("aria-label", "AnkiConnect is unavailable");
      }
    };
    this.app.workspace.onLayoutReady(() => {
      void updateStatus();
      this.registerInterval(
        window.setInterval(() => void updateStatus(), 15_000),
      );
      const current = this.app.workspace.getActiveFile();
      if (this.settings.pullOnOpen && current && this.hasAnkiDeck(current))
        void this.pull(current);
    });
    let previous = this.app.workspace.getActiveFile();
    this.registerEvent(
      this.app.workspace.on("file-open", (current) => {
        const closed = previous;
        previous = current;
        if (
          this.settings.syncOnClose &&
          closed &&
          closed.path !== current?.path &&
          this.hasAnkiDeck(closed)
        ) {
          // Let Obsidian finish flushing the editor buffer before reading the file.
          const timeout = window.setTimeout(
            () => void this.sync(closed, false, true),
            250,
          );
          this.register(() => window.clearTimeout(timeout));
        }
        if (this.settings.pullOnOpen && current && this.hasAnkiDeck(current))
          void this.pull(current);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        let changed = false;
        for (const stored of Object.values(this.state.cards))
          if (stored.filePath === oldPath) {
            stored.filePath = file.path;
            // The source URL is rendered into Anki, so force a reviewed update.
            stored.fingerprint = "";
            changed = true;
          }
        if (changed) void this.saveSettings();
      }),
    );
  }
  async saveSettings() {
    await this.saveData({
      settings: this.settings,
      state: this.state,
    } satisfies Data);
  }
  private parserOptions(): ParserOptions {
    return {
      cardTag: this.settings.cardTag,
      context: this.settings.context,
      inlineSeparator: this.settings.inlineSeparator,
      reverseSeparator: this.settings.reverseSeparator,
    };
  }
  private managedTags(): string[] {
    return this.settings.defaultTag ? [this.settings.defaultTag] : [];
  }
  private pullChanges(client: AnkiClient, file: TFile) {
    return pullFromAnki(
      this.app,
      client,
      file,
      this.state,
      this.parserOptions(),
      this.managedTags(),
    );
  }
  private hasAnkiDeck(file: TFile): boolean {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return (
      typeof frontmatter?.["anki-deck"] === "string" &&
      frontmatter["anki-deck"].trim().length > 0
    );
  }
  private async sync(
    file: TFile,
    announceRunning = true,
    silentWhenUnchanged = false,
  ) {
    if (this.running.has(file.path)) {
      if (announceRunning) new Notice("That note is already syncing.");
      return;
    }
    this.running.add(file.path);
    let provisionalKeys: string[] = [];
    try {
      const client = new AnkiClient(this.settings.endpoint);
      if ((await client.version()) < 6)
        throw new Error("AnkiConnect API 6 or newer is required");
      let source = await this.app.vault.read(file);
      const repaired = separateInlineForgeMarkers(source);
      if (repaired !== source) {
        source = repaired;
        await this.app.vault.process(file, () => source);
      }
      let parsed = parseMarkdown(source, this.parserOptions());
      if (parsed.diagnostics.length)
        throw new Error(
          parsed.diagnostics
            .map((item) => `Line ${item.line}: ${item.message}`)
            .join("; "),
        );
      const duplicateKeys = duplicateCardKeys(parsed.cards);
      if (duplicateKeys.length)
        throw new Error(
          `Duplicate Forge key${duplicateKeys.length === 1 ? "" : "s"}: ${duplicateKeys.join(", ")}. Give each card its own ^af-… line.`,
        );
      const reconcileWarnings = await this.reconcileKeys(
        client,
        parsed.cards,
        file.path,
      );
      // Reconciliation must precede pulling. This lets a copied/imported note
      // adopt its existing Anki notes before either side is changed.
      await this.pullChanges(client, file);
      source = await this.app.vault.read(file);
      parsed = parseMarkdown(source, this.parserOptions());
      const existingKeys = new Set(
        parsed.cards.map((card) => card.key).filter(Boolean),
      );
      const marked = insertMarkers(source, parsed.cards, () =>
        this.shortKey(existingKeys),
      );
      provisionalKeys = marked.keys;
      if (marked.source !== source) {
        await this.app.vault.process(file, () => marked.source);
        source = marked.source;
        parsed = parseMarkdown(source, this.parserOptions());
      }
      const ids = [
        ...new Set(
          parsed.cards.flatMap((c) =>
            c.key && this.state.cards[c.key]
              ? [this.state.cards[c.key]!.noteId]
              : [],
          ),
        ),
      ];
      const mediaWarnings = await expandNoteEmbeds(
        this.app,
        file,
        parsed.cards,
      );
      const existing = new Map(
        (await client.notesInfo(ids)).map((note) => [note.noteId, note]),
      );
      const parentPath = file.parent?.path;
      const deck =
        parsed.deck ??
        (this.settings.folderDecks && parentPath && parentPath !== "/"
          ? parentPath.replaceAll("/", "::")
          : this.settings.deck);
      const plan = planSync(
        parsed.cards,
        this.state,
        existing,
        file.path,
        deck,
      );
      if (!(await approveSync(this.app, file.path, plan))) {
        await this.removeUncommittedMarkers(file, provisionalKeys);
        provisionalKeys = [];
        new Notice(
          "Anki Forge sync cancelled. No planned Anki changes were applied.",
        );
        await this.saveSettings();
        return;
      }
      mediaWarnings.push(
        ...(await uploadMedia(this.app, client, file, parsed.cards)),
      );
      const summary = await new SyncEngine(client).apply(
        plan,
        this.state,
        deck,
        `obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}&file=${encodeURIComponent(file.path)}`,
        file.path,
        this.managedTags(),
      );
      const failedKeys = provisionalKeys.filter(
        (key) => !this.state.cards[key],
      );
      await this.removeUncommittedMarkers(file, failedKeys);
      provisionalKeys = [];
      summary.failures.push(...reconcileWarnings, ...mediaWarnings);
      await this.saveSettings();
      const changed = summary.created + summary.updated + summary.deleted > 0;
      if (!silentWhenUnchanged || changed || summary.failures.length)
        new Notice(
          `Anki Forge: ${summary.created} created, ${summary.updated} updated, ${summary.deleted} deleted, ${summary.unchanged} unchanged.`,
        );
      if (summary.failures.length) new ReportModal(this.app, summary).open();
    } catch (error) {
      await this.removeUncommittedMarkers(
        file,
        provisionalKeys.filter((key) => !this.state.cards[key]),
      );
      console.error("Anki Forge sync failed", error);
      new Notice(
        `Anki Forge failed: ${error instanceof Error ? error.message : String(error)}`,
        10_000,
      );
    } finally {
      this.running.delete(file.path);
    }
  }
  private async reconcileKeys(
    client: AnkiClient,
    cards: ReturnType<typeof parseMarkdown>["cards"],
    filePath: string,
  ): Promise<string[]> {
    const warnings: string[] = [];
    for (const card of cards)
      if (card.key) {
        const ids = await client.findNotes(`ForgeKey:${card.key}`);
        const stored = this.state.cards[card.key];
        if (
          stored?.filePath &&
          stored.filePath !== filePath &&
          (await this.fileStillOwnsKey(stored.filePath, card.key))
        )
          throw new Error(
            `Forge key ${card.key} also exists in ${stored.filePath}. Remove or replace one block ID before syncing.`,
          );
        if (!stored && ids.length) {
          const baseline = snapshot(card);
          this.state.cards[card.key] = {
            noteId: ids[0]!,
            fingerprint: "",
            source: baseline,
            remote: baseline,
            filePath,
          };
        } else if (stored && ids.length && !ids.includes(stored.noteId))
          this.state.cards[card.key] = {
            ...stored,
            noteId: ids[0]!,
            fingerprint: "",
            filePath,
          };
        else if (stored && stored.filePath !== filePath) {
          stored.filePath = filePath;
          stored.fingerprint = "";
        }
        if (ids.length > 1)
          warnings.push(
            `Line ${card.range.line}: ${ids.length} Anki notes share Forge key ${card.key}. Forge will not create another; remove the unwanted duplicate manually.`,
          );
      }
    return warnings;
  }
  private async fileStillOwnsKey(path: string, key: string): Promise<boolean> {
    const candidate = this.app.vault.getAbstractFileByPath(path);
    if (!(candidate instanceof TFile)) return false;
    const parsed = parseMarkdown(
      await this.app.vault.cachedRead(candidate),
      this.parserOptions(),
    );
    return parsed.cards.some((card) => card.key === key);
  }
  private async removeUncommittedMarkers(file: TFile, keys: string[]) {
    if (!keys.length) return;
    await this.app.vault.process(file, (source) =>
      removeForgeMarkers(source, keys),
    );
  }
  private async pull(file: TFile) {
    if (this.running.has(file.path)) return;
    this.running.add(file.path);
    try {
      const summary = await this.pullChanges(
        new AnkiClient(this.settings.endpoint),
        file,
      );
      if (summary.changed || summary.detached) {
        await this.saveSettings();
        new Notice(
          `Anki Forge: pulled ${summary.changed} edit(s), detached ${summary.detached} deleted card(s).`,
        );
      }
    } catch (error) {
      console.warn("Anki Forge pull skipped", error);
      new Notice(
        `Anki Forge pull skipped: ${error instanceof Error ? error.message : String(error)}`,
        10_000,
      );
    } finally {
      this.running.delete(file.path);
    }
  }
  private shortKey(existing: Set<string | undefined>): string {
    let key: string;
    do {
      const values = crypto.getRandomValues(new Uint32Array(2));
      key = `${values[0]!.toString(36)}${values[1]!.toString(36)}`.slice(0, 10);
    } while (existing.has(key));
    existing.add(key);
    return key;
  }
  private async syncFiles(files: TFile[]) {
    let done = 0;
    for (const file of files) {
      await this.sync(file, false);
      done++;
    }
    new Notice(`Anki Forge finished ${done} note(s).`);
  }
}
