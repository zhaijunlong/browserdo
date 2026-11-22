import { renderAnnotatedContent } from "./annotated_content.js";

/**
 * What browser_wait and browser_batch decide by plain rules, on rendered snapshots: whether a
 * text is on the page, which element shows a text, and which lines changed between two shots.
 */

/** Lower case, white space squashed: how page text and a sought text are compared. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A link in a sentence as the renderer writes it: [words](#12). */
const INLINE_LINK = /\[((?:[^\]\\]|\\.)*)\]\(#(\d+)\)/g;

/** Whether the page's text, names and values included, contains text. */
export function pageHasText(annotatedContent: string, text: string): boolean {
  return norm(renderAnnotatedContent(annotatedContent, { numbers: false })).includes(norm(text));
}

export interface Find {
  text: string;
  tag?: string;
  nth?: number;
}

type Candidate = { emsn: number; line: number; depth: number; inline: boolean; shown: string; exact: boolean };

/**
 * The number of the element whose line shows find.text (its words, name, value or hint), in a
 * rendered snapshot. The innermost one wins: a list item's line also carries its link's words.
 * Where some show exactly the text and others only contain it, the exact ones are kept. Several
 * left without nth is an error listing them, not a guess.
 */
export function findElement(rendered: string, find: Find): { emsn: number } | { error: string } {
  const want = norm(find.text);
  const tag = find.tag?.toUpperCase();
  const lines = rendered.split("\n");
  const depthOf = (l: string) => /^\t*/.exec(l)![0].length;
  const all: Candidate[] = [];
  lines.forEach((raw, i) => {
    const depth = depthOf(raw);
    const body = raw.slice(depth);
    const el = /^(\d+) (\S+)(.*)$/.exec(body);
    if (el) {
      const words = el[3].replace(INLINE_LINK, "$1");
      // Exact: one quoted text or name is the whole of it.
      const parts = [...words.matchAll(/"([^"]*)"|\[([^\]]*)\]/g)].map((m) => norm(m[1] ?? m[2]));
      if ((!tag || el[2].split(":")[0] === tag) && norm(words).includes(want)) {
        all.push({ emsn: Number(el[1]), line: i, depth, inline: false, shown: body, exact: parts.includes(want) });
      }
    }
    for (const m of body.matchAll(INLINE_LINK)) {
      if ((!tag || tag === "A") && norm(m[1]).includes(want)) {
        all.push({ emsn: Number(m[2]), line: i, depth: depth + 1, inline: true, shown: `${m[2]} A "${m[1]}" (in: ${body})`, exact: norm(m[1]) === want });
      }
    }
  });
  // An element containing another match is dropped for it.
  const end = (c: Candidate) => {
    let k = c.line + 1;
    while (k < lines.length && depthOf(lines[k]) > c.depth) k++;
    return k;
  };
  const inner = all.filter(
    (c) => c.inline || !all.some((o) => o !== c && (o.line === c.line ? o.inline : o.line > c.line && o.line < end(c))),
  );
  const exact = inner.filter((c) => c.exact);
  const found = exact.length ? exact : inner;
  const what = `"${find.text}"${tag ? ` with tag ${tag}` : ""}`;
  if (!found.length) return { error: `no numbered element shows ${what}` };
  if (find.nth !== undefined) {
    if (find.nth > found.length) return { error: `nth ${find.nth}, but only ${found.length} element(s) show ${what}` };
    return { emsn: found[find.nth - 1].emsn };
  }
  if (found.length === 1) return { emsn: found[0].emsn };
  const listed = found.slice(0, 8).map((c, i) => `${i + 1}) ${c.shown}`);
  if (found.length > 8) listed.push(`... ${found.length - 8} more`);
  return { error: `${found.length} elements show ${what}; give nth (1 to ${found.length}) or a tag:\n${listed.join("\n")}` };
}

/**
 * The lines of after not in before ("+"), with the unchanged lines they sit inside (" ") so the
 * Tab indents still say where they are, then the lines of before gone from after ("-"). Lines
 * are compared whole but for the offscreen mark, which a scroll alone changes: an element keeps
 * its number across the shots of a page, so a line is the same element saying the same thing.
 */
export function changedLines(before: string, after: string): { text: string; added: number; gone: number } {
  const left = new Map<string, number>();
  const take = (l: string) => {
    const n = left.get(unmarked(l)) ?? 0;
    if (n > 0) left.set(unmarked(l), n - 1);
    return n > 0;
  };
  for (const l of linesOf(before)) left.set(unmarked(l), (left.get(unmarked(l)) ?? 0) + 1);
  const lines = linesOf(after);
  const added = lines.map((l) => !take(l));
  const depthOf = (l: string) => /^\t*/.exec(l)![0].length;
  const shown = new Set<number>();
  lines.forEach((l, i) => {
    if (!added[i]) return;
    shown.add(i);
    // The lines it sits inside: the nearest one less indented, and so on up.
    for (let d = depthOf(l), k = i - 1; d > 0 && k >= 0; k--) {
      if (depthOf(lines[k]) < d) {
        shown.add(k);
        d = depthOf(lines[k]);
      }
    }
  });
  const out = [...shown].sort((a, b) => a - b).map((i) => `${added[i] ? "+" : " "} ${lines[i]}`);
  const gone = linesOf(before).filter(take);
  out.push(...gone.map((l) => `- ${l}`));
  return { text: out.join("\n"), added: added.filter(Boolean).length, gone: gone.length };
}

/** An empty page renders as "", which has no lines. */
function linesOf(rendered: string): string[] {
  return rendered ? rendered.split("\n") : [];
}

function unmarked(line: string): string {
  return line.replace(/ (?:partly )?offscreen$/, "");
}

/** The lines of a snapshot that were on the screen: all but those marked offscreen, which only a snapshot reading around the screen has. */
export function onScreen(rendered: string): string {
  return rendered.split("\n").filter((l) => !/(?<!partly) offscreen$/.test(l)).join("\n");
}
