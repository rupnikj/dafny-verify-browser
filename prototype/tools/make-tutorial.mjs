// Bake the Dafny OnlineTutorial (docs/OnlineTutorial in the pinned Dafny
// checkout — the maintained successor of the rise4fun Dafny tutorial, MIT)
// into a single JSON asset for the demo's Tutorial tab. Each ```dafny fence
// carries a directive comment: %check-verify[-warn] <expect-file> (runnable,
// expected outcome recorded), %check-resolve (runnable, resolution-only),
// %no-check (fragment). We bake runnability + whether errors are expected.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tutorialRoot = resolve(prototypeRoot, "../upstream-dafny/docs/OnlineTutorial");
const CHAPTERS = [
  ["guide", "Getting Started"],
  ["Sequences", "Sequences"],
  ["Sets", "Sets"],
  ["Termination", "Termination"],
  ["Lemmas", "Lemmas & Induction"],
  ["Modules", "Modules"],
  ["ValueTypes", "Value Types"]
];

async function expectedOutcome(expectFile) {
  if (!expectFile) return null;
  try {
    const text = await readFile(join(tutorialRoot, expectFile), "utf8");
    const errors = /(^|\n).*Error/.test(text) || /\b[1-9]\d* errors\b/.test(text);
    return { expectFile, expectErrors: errors, expectText: text.trim().slice(0, 500) };
  } catch {
    return { expectFile, expectErrors: false, expectText: null };
  }
}

const chapters = [];
for (const [file, title] of CHAPTERS) {
  let markdown = await readFile(join(tutorialRoot, file + ".md"), "utf8");
  markdown = markdown.replace(/^---\ntitle:.*?\n---\n/s, "");
  // Split into segments at directive-annotated fences.
  const segments = [];
  const fence = /<!--\s*(%[a-z-]+)(?:\s+(\S+?))?\s*-->\s*\n```dafny\n(.*?)```/gs;
  let cursor = 0, match;
  while ((match = fence.exec(markdown)) !== null) {
    if (match.index > cursor) {
      segments.push({ kind: "prose", html: marked.parse(markdown.slice(cursor, match.index)) });
    }
    const [, directive, expectFile, code] = match;
    const runnable = directive !== "%no-check";
    segments.push({
      kind: "code",
      code: code.replace(/\s+$/, ""),
      runnable,
      directive,
      ...(runnable ? { expected: await expectedOutcome(expectFile) } : {})
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < markdown.length) {
    segments.push({ kind: "prose", html: marked.parse(markdown.slice(cursor)) });
  }
  chapters.push({ id: file, title, segments });
  const runnableCount = segments.filter(s => s.kind === "code" && s.runnable).length;
  console.log(`${file}: ${segments.length} segments, ${runnableCount} runnable blocks`);
}

const out = { generated: "from dafny-lang/dafny docs/OnlineTutorial (MIT)", chapters };
await writeFile(resolve(prototypeRoot, "wwwroot/tutorial.json"), JSON.stringify(out));
const bytes = JSON.stringify(out).length;
console.log(`tutorial.json: ${(bytes / 1024).toFixed(0)} KB`);
