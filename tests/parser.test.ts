import { describe, expect, it } from "vitest";
import {
  applyRemoteCards,
  duplicateCardKeys,
  insertMarkers,
  parseMarkdown,
  separateInlineForgeMarkers,
} from "../src/parser";
import { extractMediaPaths } from "../src/media";
import {
  markdownToAnki,
  preserveEquivalentMarkdown,
  renderCard,
} from "../src/render";

describe("Markdown scanner", () => {
  it("preserves spaces in embedded media paths", () => {
    expect(
      extractMediaPaths("![[Pasted image 20260805144412.png|323]]"),
    ).toEqual(["Pasted image 20260805144412.png"]);
  });
  it("renders wiki images as HTML elements rather than escaped markup", () => {
    const html = markdownToAnki("![[Pasted image 20260805144412.png|323]]");
    expect(html).toContain('<img src="pasted%20image%2020260805144412.png"');
    expect(html).not.toContain("&lt;img");
  });
  it("preserves original math when Anki only normalizes rendered HTML", () => {
    const original = String.raw`$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$`;
    const stripParagraph = (html: string) =>
      html.replace(/^<p>|<\/p>\n?$/g, "");
    const normalizedByAnki = markdownToAnki(original)
      .replace("<p>", "<div>")
      .replace("</p>", "</div>");
    const normalizeBlocks = (html: string) =>
      stripParagraph(html.replace(/^<div>|<\/div>\n?$/g, ""));

    expect(
      preserveEquivalentMarkdown(normalizedByAnki, original, normalizeBlocks),
    ).toBe(original);
    expect(
      preserveEquivalentMarkdown("<div>(y)</div>", original, normalizeBlocks),
    ).toBe("(y)");
  });
  it("preserves multiline math when Anki changes its line layout", () => {
    const original = String.raw`$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$`;
    const ankiHtml = String.raw`<div>\[x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}\]</div>`;
    const htmlToMarkdown = (html: string) =>
      html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/?(?:p|div)>/gi, "")
        .trim();

    expect(preserveEquivalentMarkdown(ankiHtml, original, htmlToMarkdown)).toBe(
      original,
    );
  });
  it("does not insert HTML line breaks inside display math", () => {
    const rendered = markdownToAnki(String.raw`$$
\begin{aligned}
x &= 1 \\
y &= 2
\end{aligned}
$$`);
    const math = rendered.match(/\\\[([\s\S]*?)\\\]/)?.[1];
    expect(math).toContain("\\begin{aligned}");
    expect(math).not.toContain("<br");
  });
  it("does not confuse user text with its display-math placeholder", () => {
    const rendered = markdownToAnki(
      "ANKIFORGEDISPLAYMATH0TOKEN\n\n$$x^2$$",
    );
    expect(rendered).toContain("ANKIFORGEDISPLAYMATH0TOKEN");
    expect(rendered).toContain(String.raw`\[x^2\]`);
  });
  it("restores multiline math layout when other Anki text changed", () => {
    const original = String.raw`Old explanation
$$
\begin{aligned}
x &= 1 \\
y &= 2
\end{aligned}
$$`;
    const remote = String.raw`<div>New explanation</div><div>\[\begin{aligned}x &= 1 \\ y &= 2\end{aligned}\]</div>`;
    const pulled = preserveEquivalentMarkdown(remote, original, (html) =>
      html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?div>/gi, "\n").trim(),
    );
    expect(pulled).toContain(String.raw`$$
\begin{aligned}
x &= 1 \\
y &= 2
\end{aligned}
$$`);
  });
  it("does not discard meaningful whitespace edits in math text", () => {
    const original = String.raw`$$
\text{prey population}
$$`;
    const pulled = preserveEquivalentMarkdown(
      String.raw`<div>\[\text{preypopulation}\]</div>`,
      original,
      (html) => html.replace(/<\/?div>/gi, "").trim(),
    );
    expect(pulled).toBe(String.raw`$$
\text{preypopulation}
$$`);
  });
  it("converts math created in Anki back to Obsidian math syntax", () => {
    const htmlToMarkdown = (html: string) =>
      html.replace(/<\/?(?:p|div)>/gi, "").trim();
    expect(
      preserveEquivalentMarkdown(
        String.raw`<div>\[\int_x^y f(x) dx\]</div>`,
        "No math yet",
        htmlToMarkdown,
      ),
    ).toBe(String.raw`$$
\int_x^y f(x) dx
$$`);
    expect(
      preserveEquivalentMarkdown(
        String.raw`<div>The value is \(x^2\)</div>`,
        "The value changed",
        htmlToMarkdown,
      ),
    ).toBe("The value is $x^2$");
  });
  it("keeps cloze syntax only in the visible cloze field", () => {
    const card = parseMarkdown("Learn {1:this} and {2:that}\n").cards[0]!;
    const fields = renderCard(card, "obsidian://source");
    expect(fields).not.toHaveProperty("ForgeMarkdown");
    expect("Cloze" in fields && fields.Cloze).toContain("{{c1::this}}");
  });
  it("parses compatible card styles and context", () => {
    const doc = parseMarkdown(
      `---\nanki-deck: Study::Biology\ntags: #school #bio/cells\n---\n# Cells\nMitochondria::Powerhouse #exam\nCapital of France:::Paris\nRemember ==ATP==\nPrompt only #card-spaced\n`,
    );
    expect(doc.deck).toBe("Study::Biology");
    expect(doc.cards.map((c) => c.kind)).toEqual([
      "basic",
      "reversed",
      "cloze",
      "spaced",
    ]);
    expect(doc.cards[0]?.context).toEqual(["Cells"]);
    expect(doc.cards[0]?.tags).toEqual(["school", "bio::cells", "exam"]);
    expect(doc.cards[2]?.front).toContain("{{c1::ATP}}");
  });
  it("parses ordinary YAML frontmatter tags", () => {
    const doc = parseMarkdown(
      "---\nanki-deck: Study\ntags: [school, bio/cells]\n---\nQ::A\n",
    );
    expect(doc.globalTags).toEqual(["school", "bio::cells"]);
    expect(doc.cards[0]?.tags).toEqual(["school", "bio::cells"]);
  });

  it("ignores syntax inside fenced code", () => {
    const doc = parseMarkdown(
      "```ts\nconst fake = 'Question::Answer';\n```\nReal::Card\n",
    );
    expect(doc.cards).toHaveLength(1);
    expect(doc.cards[0]?.front).toBe("Real");
  });

  it("inserts stable markers without corrupting offsets", () => {
    const source = "One::1\nTwo::2\n";
    const parsed = parseMarkdown(source);
    let id = 0;
    const result = insertMarkers(source, parsed.cards, () => `key-${++id}`);
    expect(result.source).toBe("One::1\n^af-key-1\nTwo::2\n^af-key-2\n");
    expect(parseMarkdown(result.source).cards.map((c) => c.key)).toEqual([
      "key-1",
      "key-2",
    ]);
  });
  it("keeps adjacent cards separate through a pull round trip", () => {
    const source = "One::1\n^af-one\nTwo::2\n^af-two\n";
    const cards = parseMarkdown(source).cards;
    const pulled = applyRemoteCards(
      source,
      cards.map((card) => ({ card, value: { ...card } })),
    );
    const reparsed = parseMarkdown(pulled).cards;

    expect(pulled).toBe(source);
    expect(
      reparsed.map(({ key, front, back }) => ({ key, front, back })),
    ).toEqual([
      { key: "one", front: "One", back: "1" },
      { key: "two", front: "Two", back: "2" },
    ]);
  });

  it("puts a block ID on its own line when the file has no final newline", () => {
    const source = "One::1";
    const result = insertMarkers(
      source,
      parseMarkdown(source).cards,
      () => "key",
    );
    expect(result.source).toBe("One::1\n^af-key\n");
    expect(parseMarkdown(result.source).cards[0]?.back).toBe("1");
  });
  it("repairs early inline Forge block IDs", () => {
    expect(separateInlineForgeMarkers("Question::Answer^af-key")).toBe(
      "Question::Answer\n^af-key",
    );
  });
  it("ignores fully struck cards", () => {
    expect(
      parseMarkdown("~~Retired::Card~~\nLive::Card\n").cards.map(
        (c) => c.front,
      ),
    ).toEqual(["Live"]);
  });
  it("strikes deleted cards without disturbing neighboring content", () => {
    const source = "Keep::This\nDelete::This\n^af-doomed\nAfter::This\n";
    const cards = parseMarkdown(source).cards;
    const result = applyRemoteCards(source, [], [cards[1]!]);
    expect(result).toBe(
      "Keep::This\n~~Delete::This~~\n^af-doomed\nAfter::This\n",
    );
  });
  it("never treats LaTeX or code braces as clozes", () => {
    const source =
      "Math $\\frac{a}{b}$ and {real}\nCode `const x = {a: 1}` and {2:outside}\nEscaped \\{literal\\}\n";
    const cards = parseMarkdown(source).cards;
    expect(cards).toHaveLength(2);
    expect(cards[0]?.front).toContain("$\\frac{a}{b}$");
    expect(cards[0]?.front).toContain("{{c1::real}}");
    expect(cards[1]?.front).toContain("`const x = {a: 1}`");
    expect(cards[1]?.front).toContain("{{c2::outside}}");
  });
  it("ignores braces throughout multiline display math", () => {
    expect(
      parseMarkdown("$$\n\\frac{a}{b}\n$$\nOutside {cloze}\n").cards.map(
        (c) => c.front,
      ),
    ).toEqual(["Outside {{c1::cloze}}"]);
  });

  it("parses multiline tagged answers as one card", () => {
    const cards = parseMarkdown(
      "Why? #card\nBecause line one\nand line two\n\nNext::Card\n",
    ).cards;
    expect(cards).toHaveLength(2);
    expect(cards[0]?.back).toBe("Because line one\nand line two");
  });
  it("separates a multiline card from an adjacent inline card", () => {
    const source = "Why? #card\nBecause\nNext::Card\n";
    const cards = parseMarkdown(source).cards;
    expect(cards.map(({ front, back }) => ({ front, back }))).toEqual([
      { front: "Why?", back: "Because" },
      { front: "Next", back: "Card" },
    ]);

    let index = 0;
    const marked = insertMarkers(
      source,
      cards,
      () => ["multi", "inline"][index++]!,
    );
    expect(marked.source).toBe(
      "Why? #card\nBecause\n^af-multi\nNext::Card\n^af-inline\n",
    );
    expect(
      parseMarkdown(marked.source).cards.map(({ key, front, back }) => ({
        key,
        front,
        back,
      })),
    ).toEqual([
      { key: "multi", front: "Why?", back: "Because" },
      { key: "inline", front: "Next", back: "Card" },
    ]);
  });
  it("places a multiline card marker after an entire display-math answer", () => {
    const source = String.raw`Solve this #card
$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$
Next::Card
`;
    const cards = parseMarkdown(source).cards;
    expect(cards).toHaveLength(2);
    expect(cards[0]?.back).toContain(
      String.raw`\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`,
    );

    let index = 0;
    const marked = insertMarkers(
      source,
      cards,
      () => ["math", "inline"][index++]!,
    ).source;
    expect(marked).toContain("\n$$\n^af-math\nNext::Card");
    expect(marked).not.toContain("$$\n^af-math\nx =");
    expect(parseMarkdown(marked).cards.map((card) => card.key)).toEqual([
      "math",
      "inline",
    ]);
  });
  it("keeps multiline display math in a spaced inline card answer", () => {
    const source = String.raw`Find the equilibria :: $$
\begin{cases}
ax-bxy=0 \\
-cy+dxy=0
\end{cases}
$$
Next::Card
`;
    const cards = parseMarkdown(source).cards;
    expect(cards).toHaveLength(2);
    expect(cards[0]?.front).toBe("Find the equilibria");
    expect(cards[0]?.back).toBe(String.raw`$$
\begin{cases}
ax-bxy=0 \\
-cy+dxy=0
\end{cases}
$$`);

    let index = 0;
    const marked = insertMarkers(
      source,
      cards,
      () => ["math", "next"][index++]!,
    ).source;
    expect(marked).toContain("\\end{cases}\n$$\n^af-math\nNext::Card");
    expect(marked).not.toContain("Find the equilibria :: $$\n^af-math");

    const reparsed = parseMarkdown(marked).cards;
    expect(reparsed.map((card) => card.key)).toEqual(["math", "next"]);
    const fields = renderCard(reparsed[0]!, "source");
    expect("Back" in fields && fields.Back).toContain(String.raw`\[`);
    expect("Back" in fields && fields.Back).toContain(String.raw`\begin{cases}`);
    expect("Back" in fields && fields.Back).toContain(String.raw`\]`);
  });
  it("preserves tagged multiline syntax when applying an Anki edit", () => {
    const source = "Why? #card\nOld answer\n^af-key\n";
    const card = parseMarkdown(source).cards[0]!;
    const updated = applyRemoteCards(source, [
      { card, value: { ...card, back: "New answer" } },
    ]);
    expect(updated).toBe("Why? #card\nNew answer\n^af-key\n");
  });
  it("promotes an inline card when Anki adds a multiline answer", () => {
    const source = "Why?::Old answer\n^af-key\n";
    const card = parseMarkdown(source, { cardTag: "flashcard" }).cards[0]!;
    const updated = applyRemoteCards(source, [
      { card, value: { ...card, back: "Line one\nLine two" } },
    ]);
    expect(updated).toBe("Why? #flashcard\nLine one\nLine two\n^af-key\n");
    expect(
      parseMarkdown(updated, { cardTag: "flashcard" }).cards[0]?.back,
    ).toBe("Line one\nLine two");
  });
  it("does not discard tags that merely begin with the card-tag name", () => {
    expect(parseMarkdown("Q::A #cardiology\n").cards[0]?.tags).toEqual([
      "cardiology",
    ]);
  });
  it("does not copy inherited frontmatter tags onto edited card lines", () => {
    const source =
      "---\ntags: [school, parser/check]\n---\nQuestion::Old\n^af-key\n";
    const doc = parseMarkdown(source);
    const updated = applyRemoteCards(
      source,
      [
        {
          card: doc.cards[0]!,
          value: {
            ...doc.cards[0]!,
            back: "New",
            tags: ["school", "parser::check", "anki-only"],
          },
        },
      ],
      [],
      doc.globalTags,
    );
    expect(updated).toContain("Question::New #anki-only\n^af-key");
    expect(updated).not.toContain("Question::New #school");
    expect(updated).not.toContain("Question::New #parser/check");
  });
  it("keeps Anki paragraphs together until an existing Forge marker", () => {
    const source =
      "Why is the sky blue? #card\nShorter wavelengths scatter more strongly.\n^af-sky\nNext::Card\n^af-next\n";
    const card = parseMarkdown(source).cards[0]!;
    const pulled = applyRemoteCards(source, [
      {
        card,
        value: {
          ...card,
          back: "Shorter wavelengths\n\nscatter more strongly.",
        },
      },
    ]);
    const reparsed = parseMarkdown(pulled);
    expect(reparsed.cards.map((item) => item.key)).toEqual(["sky", "next"]);
    expect(reparsed.cards[0]?.back).toBe(
      "Shorter wavelengths\n\nscatter more strongly.",
    );
    expect(
      insertMarkers(pulled, reparsed.cards, () => "unexpected").keys,
    ).toEqual([]);
  });
  it("round-trips Anki-created display math in a multiline card", () => {
    const source = "Why is the sky blue? #card\nShorter wavelengths\n^af-sky\n";
    const card = parseMarkdown(source).cards[0]!;
    const back = preserveEquivalentMarkdown(
      String.raw`<div>Shorter wavelengths</div><div><br></div><div>scatter more</div><div>\[\int_x^y f(x) dx\]</div>`,
      card.back,
      (html) =>
        html
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/?div>/gi, "\n")
          .trim(),
    );
    const pulled = applyRemoteCards(source, [
      { card, value: { ...card, back } },
    ]);
    const reparsed = parseMarkdown(pulled).cards[0]!;
    expect(reparsed.key).toBe("sky");
    expect(reparsed.back).toContain("$$\n\\int_x^y f(x) dx\n$$");
    const fields = renderCard(reparsed, "source");
    expect("Back" in fields).toBe(true);
    const rendered = "Back" in fields ? fields.Back : "";
    expect(rendered).toContain(String.raw`\[`);
    expect(rendered).toContain(String.raw`\int_x^y f(x) dx`);
    expect(rendered).toContain(String.raw`\]`);
  });
  it("keeps fenced code inside a multiline answer", () => {
    const source =
      "Explain #card\n```ts\nconst answer = { value: 42 };\n```\nNext::Card\n";
    const cards = parseMarkdown(source).cards;
    expect(cards).toHaveLength(2);
    expect(cards[0]?.back).toContain("const answer = { value: 42 };");
    expect(cards[1]?.front).toBe("Next");
  });
  it("treats configured card tags as literal text", () => {
    const cards = parseMarkdown("Question #[\nAnswer\n", {
      cardTag: "[",
    }).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]?.back).toBe("Answer");
  });
  it("detects duplicate Forge keys", () => {
    const cards = parseMarkdown("One::1\n^af-same\nTwo::2\n^af-same\n").cards;
    expect(duplicateCardKeys(cards)).toEqual(["same"]);
  });
  it("does not parse separators or tags inside inline code and math", () => {
    const source =
      "`std::vector::iterator`\n$left::right$\nReal::Card `#literal` #actual\n";
    const cards = parseMarkdown(source).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]?.front).toBe("Real");
    expect(cards[0]?.tags).toEqual(["actual"]);
  });
  it.each([
    ["---\nanki-deck: Math\nCard::Hidden\n", "Unterminated YAML frontmatter"],
    ["```ts\nCard::Hidden\n", "Unterminated code fence"],
    ["$$\nCard::Hidden\n", "Unterminated display math"],
  ])("diagnoses an unterminated protected region", (source, message) => {
    const parsed = parseMarkdown(source);
    expect(parsed.diagnostics.map((item) => item.message)).toContain(message);
  });
  it("diagnoses an unterminated protected region in a multiline card", () => {
    const parsed = parseMarkdown("Question #card\n$$\nx = 2\nNext::Card\n");
    expect(parsed.diagnostics.map((item) => item.message)).toContain(
      "Unterminated display math in card answer",
    );
  });
});
