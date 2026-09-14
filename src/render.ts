import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import type { CardSnapshot, ParsedCard } from "./domain";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const md: MarkdownIt = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  highlight(code: string, language: string): string {
    if (language && hljs.getLanguage(language))
      return `<pre><code class="hljs language-${language}">${hljs.highlight(code, { language }).value}</code></pre>`;
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  },
});
const RENDER_VERSION = 5;
const mediaName = (path: string) =>
  (path.split("/").pop() ?? path).toLocaleLowerCase("en-US");
export function snapshot(card: ParsedCard): CardSnapshot {
  return {
    kind: card.kind,
    front: card.front,
    back: card.back,
    tags: [...card.tags].sort(),
  };
}
export function markdownToAnki(value: string): string {
  const displayMath: string[] = [];
  let displayMathToken = "ANKIFORGEDISPLAYMATH";
  while (value.includes(displayMathToken)) displayMathToken += "X";
  const expanded = value
    .replace(
      /!\[\[([^\]|]+\.(?:mp3|wav|m4a|ogg|flac))(?:\|[^\]]+)?\]\]/gi,
      (_m, path: string) => `[sound:${mediaName(path)}]`,
    )
    .replace(
      /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g,
      (_m, path: string) => `![](${mediaName(path)})`,
    )
    .replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_m, alt: string, path: string) =>
        `![${alt}](${encodeURI(mediaName(path))})`,
    )
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "[$2]($1)")
    .replace(/\[\[([^\]]+)\]\]/g, "[$1]($1)")
    // Keep display math out of markdown-it while it applies `breaks: true`.
    // Otherwise every source newline becomes a <br> inside Anki's MathJax
    // delimiter and Anki later serializes the equation as a single line.
    .replace(/\$\$([\s\S]+?)\$\$/g, (_match, body: string) => {
      const token = `${displayMathToken}${displayMath.length}TOKEN`;
      displayMath.push(body);
      return `\n\n${token}\n\n`;
    })
    .replace(/(^|[^$])\$([^\n$]+?)\$/g, "$1\\\\($2\\\\)");
  return md
    .render(expanded)
    .replace(
      new RegExp(`<p>${displayMathToken}(\\d+)TOKEN<\\/p>\\n?`, "g"),
      (_match, index: string) =>
        `<div>\\[${escapeHtml(displayMath[Number(index)] ?? "")}\\]</div>\n`,
    );
}
export function preserveEquivalentMarkdown(
  remoteHtml: string,
  originalMarkdown: string,
  htmlToMarkdown: (html: string) => string,
): string {
  const remoteMarkdown = htmlToMarkdown(remoteHtml).trim();
  const renderedMarkdown = htmlToMarkdown(
    markdownToAnki(originalMarkdown),
  ).trim();
  const canonical = (value: string) =>
    value
      .replaceAll("\r\n", "\n")
      .replace(
        /\\\[([\s\S]*?)\\\]/g,
        (_match, body: string) =>
          `\\[${body.replace(/[ \t]*\n[ \t]*/g, "")}\\]`,
      )
      .replace(
        /\$\$([\s\S]*?)\$\$/g,
        (_match, body: string) =>
          `\\[${body.replace(/[ \t]*\n[ \t]*/g, "")}\\]`,
      )
      .trim();
  if (canonical(remoteMarkdown) === canonical(renderedMarkdown))
    return originalMarkdown;
  const converted = remoteMarkdown
    .replace(
      /\\\[([\s\S]*?)\\\]/g,
      (_match, body: string) => `$$\n${body.trim()}\n$$`,
    )
    .replace(/\\\(([^\n]*?)\\\)/g, (_match, body: string) => `$${body}$`);
  const originalBlocks = [
    ...originalMarkdown.matchAll(/\$\$([\s\S]*?)\$\$/g),
  ];
  const used = new Set<number>();
  const whitespaceSensitiveArguments = (body: string) =>
    [...body.matchAll(/\\(?:text|operatorname|mbox|textrm|textsf|texttt)\s*\{([^{}]*)\}/g)].map(
      (match) => (match[1] ?? "").replace(/\s+/g, " ").trim(),
    );
  const equivalentMath = (left: string, right: string) =>
    left.replace(/\s+/g, "") === right.replace(/\s+/g, "") &&
    JSON.stringify(whitespaceSensitiveArguments(left)) ===
      JSON.stringify(whitespaceSensitiveArguments(right));
  return converted.replace(/\$\$([\s\S]*?)\$\$/g, (block, body: string) => {
    const match = originalBlocks.findIndex(
      (item, index) =>
        !used.has(index) && equivalentMath(item[1] ?? "", body),
    );
    if (match < 0) return block;
    used.add(match);
    return originalBlocks[match]![0];
  });
}
export function renderCard(card: ParsedCard, sourceLink: string) {
  const context = card.context.join(" › ");
  const extra = [context, `[Open source note](${sourceLink})`]
    .filter(Boolean)
    .join("\n\n");
  const common = {
    Extra: markdownToAnki(extra),
    ForgeKey: card.key ?? "",
  };
  return card.kind === "cloze"
    ? { Cloze: markdownToAnki(card.front), ...common }
    : {
        Front: markdownToAnki(card.front),
        Back: markdownToAnki(card.back),
        ...common,
      };
}

export function fingerprint(card: ParsedCard): string {
  const stable = JSON.stringify({
    renderVersion: RENDER_VERSION,
    kind: card.kind,
    front: card.front,
    back: card.back,
    tags: [...card.tags].sort(),
    context: card.context,
  });
  let hash = 2166136261;
  for (let i = 0; i < stable.length; i++) {
    hash ^= stable.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
