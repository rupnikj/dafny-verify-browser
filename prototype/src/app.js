import { Compartment, EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  crosshairCursor,
  drawSelection,
  dropCursor,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection
} from "@codemirror/view";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting
} from "@codemirror/language";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab
} from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { javascript } from "@codemirror/legacy-modes/mode/javascript";
import { tags } from "@lezer/highlight";
import { createDafny } from "./dafny-browser.js";
import { runCompiled } from "./dafny-runner.js";
import { encodeShareFragment, decodeShareFragment, shareFragmentFrom } from "./share-codec.js";

const examples = {
  abs: [
    "method Abs(x: int) returns (y: int)",
    "  ensures y >= 0",
    "{",
    "  if x < 0 {",
    "    y := -x;",
    "  } else {",
    "    y := x;",
    "  }",
    "}"
  ].join("\n"),
  bad: [
    "method Bad(x: int) returns (y: int)",
    "  ensures y > x",
    "{",
    "  y := x;",
    "}"
  ].join("\n"),
  leap: [
    "// The folk rule \"every fourth year is a leap year\" served Rome well —",
    "// until 1582. Can the verifier find the year it breaks?",
    "predicate IsLeapYear(year: int) {",
    "  year % 400 == 0 || (year % 4 == 0 && year % 100 != 0)",
    "}",
    "",
    "method CheckLeapYear(year: int) returns (leap: bool)",
    "  requires 1583 <= year <= 9999",
    "  ensures leap == IsLeapYear(year)",
    "{",
    "  leap := year % 4 == 0;",
    "}"
  ].join("\n"),
  sum: [
    "// Sum the array. Looks right, compiles in most languages,",
    "// crashes on the last iteration. Watch i in the counterexample.",
    "method Sum(a: array<int>) returns (total: int)",
    "{",
    "  total := 0;",
    "  var i := 0;",
    "  while i <= a.Length",
    "    invariant 0 <= i <= a.Length + 1",
    "  {",
    "    total := total + a[i];",
    "    i := i + 1;",
    "  }",
    "}"
  ].join("\n"),
  first: [
    "// Works on every list you tested. The verifier tests one more.",
    "method First(s: seq<int>) returns (x: int)",
    "{",
    "  x := s[0];",
    "}"
  ].join("\n"),
  count: [
    "// Count the integers from lo to hi, inclusive. The spec says",
    "// inclusive; does the loop agree?",
    "method CountRange(lo: int, hi: int) returns (n: int)",
    "  requires lo <= hi",
    "  ensures n == hi - lo + 1",
    "{",
    "  n := 0;",
    "  var i := lo;",
    "  while i < hi",
    "    invariant lo <= i <= hi",
    "    invariant n == i - lo",
    "  {",
    "    n := n + 1;",
    "    i := i + 1;",
    "  }",
    "}"
  ].join("\n"),
  fastfib: [
    "// The classic payoff of verification: prove the fast iterative",
    "// implementation equal to the obviously-correct recursive spec —",
    "// then actually run it, right here in the browser.",
    "function Fib(n: nat): nat {",
    "  if n < 2 then n else Fib(n - 1) + Fib(n - 2)",
    "}",
    "",
    "method FastFib(n: nat) returns (b: nat)",
    "  ensures b == Fib(n)",
    "{",
    "  var i := 0;",
    "  b := 0;",
    "  var c := 1;",
    "  while i < n",
    "    invariant 0 <= i <= n",
    "    invariant b == Fib(i) && c == Fib(i + 1)",
    "  {",
    "    b, c := c, b + c;",
    "    i := i + 1;",
    "  }",
    "}",
    "",
    "method Main() {",
    "  var i := 0;",
    "  while i <= 40 {",
    "    var f := FastFib(i);",
    "    print \"Fib(\", i, \") = \", f, \"\\n\";",
    "    i := i + 10;",
    "  }",
    "}"
  ].join("\n"),
  r4f_hello: "// From the rise4fun Dafny demo (Microsoft Research), recovered via the Internet Archive.\n// (Lightly modernized for Dafny 4 style.)\nmethod Main() {\n  print \"hello, Dafny\\n\";\n  assert 10 < 2;\n}\n",
  r4f_fib: "// From the rise4fun Dafny demo (Microsoft Research), recovered via the Internet Archive.\n// (Lightly modernized for Dafny 4 style.)\nfunction Fibonacci(n: int): int\n  decreases n\n{\n  if n < 2 then n else Fibonacci(n+2) + Fibonacci(n+1)\n}\n",
  r4f_ack: "// From the rise4fun Dafny demo (Microsoft Research), recovered via the Internet Archive.\n// (Lightly modernized for Dafny 4 style.)\nfunction Ackermann(m: int, n: int): int\n  // The following lexicographic pair allows Dafny to prove termination.\n  // Still, you may not want to sit around and wait for a call to Ackermann\n  // to terminate.\n  decreases m, n\n{\n  if m <= 0 then\n    n + 1\n  else if n <= 0 then\n    Ackermann(m - 1, 1)\n  else\n    Ackermann(m - 1, Ackermann(m, n - 1))\n}\n",
  r4f_add: "// From the rise4fun Dafny demo (Microsoft Research), recovered via the Internet Archive.\n// (Lightly modernized for Dafny 4 style.)\n// The following program is intended to compute\n// twice 'x' plus 'y' into the out-parameter 'r',\n// given that 'x' and 'y' are non-negative integers.\n// The precondition (keyword 'requires') states the\n// non-negative assumption and the postcondition\n// (keyword 'ensures') states the intended result.\n// The loop invariant (keyword 'invariant') states\n// a condition that is intended to hold at the top\n// of every loop iteration, just before the loop\n// guard is evaluated.\n// Can you correct the program and get Dafny to\n// verify it?\n\nmethod Add(x: int, y: int) returns (r: int)\n  requires 0 <= x && 0 <= y\n  ensures r == 2*x + y\n{\n  r := x;\n  var n := y;\n  while (n != 0)\n    invariant r == x+y-n && 0 <= n\n  {\n    r := r + 1;\n    n := n - 1;\n  }\n}\n",
  r4f_mul: "// From the rise4fun Dafny demo (Microsoft Research), recovered via the Internet Archive.\n// (Lightly modernized for Dafny 4 style.)\n// Multiply two numbers by addition to the next smaller multiple,\n// the smaller multiple being computed recursively.\n// Can you find the error below?\n\nmethod Mul(x: int, y: int) returns (r: int)\n  requires 0 <= x && 0 <= y\n  ensures r == x*y\n  decreases x\n{\n  if (x == 0) {\n    r := 0;\n  } else {\n    var m := Mul(x-1, y);\n    r := m + x;\n  }\n}\n",
  r4f_countton: "// From the rise4fun Dafny demo (Microsoft Research), recovered via the Internet Archive.\n// (Lightly modernized for Dafny 4 style.)\nclass Example {\n  method M(n: int)\n  {\n    // count up to 'n'; will this program terminate?\n    var i := 0;\n    while (i < n)\n    {\n      i := i + 1;\n    }\n  }\n}\n",
  r4f_countreturn: "// From the rise4fun Dafny demo (Microsoft Research), recovered via the Internet Archive.\n// (Lightly modernized for Dafny 4 style.)\n// This example uses specifications.  There is a postcondition\n// (keyword 'ensures') that says the method is intended to set\n// the out-parameter 'r' to 'n'.  Other possible specifications\n// are preconditions (keyword 'requires') and loop invariants\n// (keyword 'invariant', place just before the open-curly brace\n// of the loop body).\n\n// Can you make the program verify?\nmethod M(n: int) returns (r: int)\n  ensures r == n\n{\n  var i := 0;\n  while (i < n)\n  {\n    i := i + 1;\n  }\n  r := i;\n}\n",
  r4f_cube: "// From the rise4fun Dafny demo (Microsoft Research), recovered via the Internet Archive.\n// (Lightly modernized for Dafny 4 style.)\n// This method is supposed to compute out-parameter 'c' to\n// be the cube of 'N'.  Can you correct the program?\nmethod Cube(N: int) returns (c: int)\n  requires 0 <= N\n  ensures c == N*N*N\n{\n  c := 0;\n  var n := 0;\n  var k := 0;\n  var m := 0;\n  while (n < N)\n    invariant n <= N\n    invariant c == n*n*n\n    invariant k == 3*n*n + 3*n + 1\n    invariant m == 6*n + 6\n  {\n    c := c + k;\n    k := k + m;\n    m := m + 6;\n    n := n + 1;\n  }\n}\n",
  r4f_zunebug: "// From the rise4fun Dafny demo (Microsoft Research), recovered via the Internet Archive.\n// (Lightly modernized for Dafny 4 syntax.)\nfunction isLeapYear(y: int): bool {\n  (y % 4 == 0) && ((y % 100 != 0) || (y % 400 == 0))\n}\n\n// Does this method terminate?\nmethod WhichYear_InfiniteLoop(d: int) returns (year: int) {\n  var days := d;\n  year := 1980;\n  while (days > 365) {\n    if (isLeapYear(year)) {\n      if (days > 366) {\n        days := days - 366;\n        year := year + 1;\n      }\n    } else {\n      days := days - 365;\n      year := year + 1;\n    }\n  }\n}\n",
  r4f_zunefixed: "// From the rise4fun Dafny demo (Microsoft Research), recovered via the Internet Archive.\n// (Lightly modernized for Dafny 4 syntax.)\nfunction isLeapYear(y: int): bool {\n  (y % 4 == 0) && ((y % 100 != 0) || (y % 400 == 0))\n}\n\n// Does this method terminate?\nmethod WhichYear(d: int) returns (year: int) {\n  var days := d;\n  year := 1980;\n  while (days > 365) {\n    if (isLeapYear(year)) {\n      if (days > 366) {\n        days := days - 366;\n        year := year + 1;\n      } else {\n        break;\n      }\n    } else {\n      days := days - 365;\n      year := year + 1;\n    }\n  }\n}\n",
  r4f_summax: "// From the rise4fun Dafny demo (Microsoft Research), recovered via the Internet Archive.\n// (Lightly modernized for Dafny 4 style.)\n// This method computes the sum and max of a given array of\n// integers.  The method's postcondition only promises that\n// 'sum' will be no greater than 'max'.  Can you write a\n// different method body that also achieves this postcondition?\n// Hint: Your program does not have to compute the sum and\n// max of the array, despite the suggestive names of the\n// out-parameters.\nmethod M(N: int, a: array<int>) returns (sum: int, max: int)\n  requires 0 <= N && a.Length == N\n  ensures sum <= N * max\n{\n  sum := 0;\n  max := 0;\n  var i := 0;\n  while (i < N)\n    invariant i <= N && sum <= i * max\n  {\n    if (max < a[i]) {\n      max := a[i];\n    }\n    sum := sum + a[i];\n    i := i + 1;\n  }\n}\n",
  max: [
    "method MaxArray(a: array<int>) returns (m: int)",
    "  requires a.Length > 0",
    "  ensures forall i :: 0 <= i < a.Length ==> a[i] <= m",
    "  ensures exists i :: 0 <= i < a.Length && a[i] == m",
    "{",
    "  m := a[0];",
    "  var j := 1;",
    "  while j < a.Length",
    "    invariant 1 <= j <= a.Length",
    "    invariant forall i :: 0 <= i < j ==> a[i] <= m",
    "    invariant exists i :: 0 <= i < j && a[i] == m",
    "  {",
    "    if a[j] > m {",
    "      m := a[j];",
    "    }",
    "    j := j + 1;",
    "  }",
    "}"
  ].join("\n")
};

const keywordWords = new Set([
  "abstract", "allocated", "as", "assert", "assume", "break", "by", "calc",
  "case", "class", "const", "constructor", "datatype", "decreases", "else",
  "ensures", "exists", "export", "extends", "forall", "fresh", "function",
  "ghost", "if", "import", "in", "include", "invariant", "iterator", "label",
  "lemma", "match", "method", "modifies", "module", "new", "old", "opened",
  "predicate", "reads", "refines", "requires", "return", "returns", "reveal",
  "then", "this", "trait", "twostate", "type", "var", "while", "yield", "yields"
]);

const definitionWords = new Set([
  "class", "const", "constructor", "datatype", "function", "iterator", "lemma",
  "method", "module", "predicate", "trait", "type"
]);

const typeWords = new Set([
  "bool", "char", "int", "imap", "iset", "map", "multiset", "nat", "object",
  "ORDINAL", "real", "seq", "set", "string"
]);

const atomWords = new Set(["false", "null", "true"]);

function readQuoted(stream, quote) {
  let escaped = false;
  stream.next();
  while (!stream.eol()) {
    const character = stream.next();
    if (character === quote && !escaped) {
      break;
    }
    escaped = !escaped && character === "\\";
  }
  return "string";
}

const dafnyLanguage = StreamLanguage.define({
  name: "dafny",
  startState: () => ({ blockComment: false, expectDefinition: false }),
  token(stream, state) {
    if (state.blockComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.blockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }

    if (stream.eatSpace()) {
      return null;
    }

    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }

    if (stream.match("/*")) {
      state.blockComment = true;
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.blockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }

    if (stream.match("{:")) {
      stream.skipTo("}");
      stream.eat("}");
      return "meta";
    }

    const next = stream.peek();
    if (next === "\"" || next === "'") {
      return readQuoted(stream, next);
    }

    if (stream.match(/^(?:0[xX][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]+)?)/)) {
      return "number";
    }

    if (stream.match(/^[A-Za-z_][A-Za-z0-9_']*/)) {
      const word = stream.current();
      if (state.expectDefinition) {
        state.expectDefinition = false;
        return "definition";
      }
      if (definitionWords.has(word)) {
        state.expectDefinition = true;
        return "keyword";
      }
      if (keywordWords.has(word)) {
        return "keyword";
      }
      if (typeWords.has(word)) {
        return "typeName";
      }
      if (atomWords.has(word)) {
        return "bool";
      }
      return /^[A-Z]/.test(word) ? "typeName" : "variableName";
    }

    if (stream.match(/^(?:<==>|==>|<==|:=|::|==|!=|<=|>=|&&|\|\||!!|\+\+|--|[-+*/%<>=!&|^~?:])/)) {
      return "operator";
    }

    stream.next();
    return "punctuation";
  }
});

// Colors come from the --syn-* CSS tokens, so the one style follows the
// page theme; only CodeMirror's dark flag needs a live swap (compartments).
const dafnyHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: [tags.typeName, tags.className], color: "var(--syn-type)" },
  { tag: tags.definition(tags.variableName), color: "var(--syn-def)" },
  { tag: tags.variableName, color: "var(--syn-var)" },
  { tag: [tags.bool, tags.null], color: "var(--syn-atom)" },
  { tag: tags.number, color: "var(--syn-number)" },
  { tag: tags.string, color: "var(--syn-string)" },
  { tag: tags.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: tags.meta, color: "var(--syn-meta)" },
  { tag: tags.operator, color: "var(--syn-operator)" },
  { tag: tags.punctuation, color: "var(--syn-punct)" }
]);

const makeEditorTheme = dark => EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--editor-bg)"
  },
  ".cm-content": {
    padding: "14px 0 60px",
    caretColor: "var(--ed-caret)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "13px",
    lineHeight: "1.58"
  },
  ".cm-line": {
    padding: "0 12px 0 8px"
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--ed-caret)"
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--ed-selection) !important"
  },
  ".cm-activeLine": {
    backgroundColor: "var(--ed-activeline)"
  },
  ".cm-gutters": {
    color: "var(--ed-gutter)",
    backgroundColor: "var(--editor-bg)",
    border: "none",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "12px"
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "38px",
    padding: "0 8px 0 6px"
  },
  ".cm-activeLineGutter": {
    color: "var(--ed-gutter-active)",
    backgroundColor: "var(--ed-activeline)"
  },
  ".cm-panels": {
    color: "var(--text)",
    backgroundColor: "var(--surface-2)"
  },
  ".cm-search": {
    borderTop: "1px solid var(--border) !important"
  },
  ".cm-search input, .cm-search button, .cm-search label": {
    color: "var(--text)"
  },
  ".cm-search input": {
    backgroundColor: "var(--surface-0)",
    border: "1px solid var(--border-strong)"
  },
  ".cm-tooltip": {
    color: "var(--text)",
    backgroundColor: "var(--ed-tooltip-bg)",
    border: "1px solid var(--ed-tooltip-border)"
  }
}, { dark });

// ---------- Theme (System / Light / Dark) ----------
// A head script resolved the initial data-theme before first paint; this
// section owns the setting, the system-preference listener, and swapping
// CodeMirror's dark flag on every live editor via compartments.
const THEME_KEY = "dafny-verify-theme";
const darkSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const themedEditors = [];

function isDarkNow() {
  return document.documentElement.dataset.theme !== "light";
}

// Returns the compartment-wrapped theme extension and registers the editor
// (resolved lazily — the JS/SMT panes are created on demand).
function themedEditorExtension(getView) {
  const compartment = new Compartment();
  themedEditors.push({ compartment, getView });
  return compartment.of(makeEditorTheme(isDarkNow()));
}

function themeSetting() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme() {
  const setting = themeSetting();
  const dark = setting === "dark" || (setting === "system" && darkSchemeQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  for (const { compartment, getView } of themedEditors) {
    getView()?.dispatch({ effects: compartment.reconfigure(makeEditorTheme(dark)) });
  }
}

const themeSelect = document.querySelector("#theme-select");
themeSelect.value = themeSetting();
themeSelect.addEventListener("change", () => {
  try {
    if (themeSelect.value === "system") {
      localStorage.removeItem(THEME_KEY);
    } else {
      localStorage.setItem(THEME_KEY, themeSelect.value);
    }
  } catch {}
  applyTheme();
});
darkSchemeQuery.addEventListener("change", () => {
  if (themeSetting() === "system") applyTheme();
});

const setDiagnosticsEffect = StateEffect.define();

// ---------- Counterexample presentation ----------

// "assume 0 == x && 0 == y;" -> ["x == 0", "y == 0"]
function counterexampleConstraints(assumption) {
  let expr = assumption.trim()
    .replace(/^assume\b\s*(\{:[^}]*\}\s*)?/, "")
    .replace(/;$/, "")
    .trim();
  const parts = [];
  let depth = 0, start = 0, inString = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inString) {
      if (ch === '"' && expr[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (depth === 0 && expr.startsWith(" && ", i)) {
      parts.push(expr.slice(start, i));
      start = i + 4;
      i += 3;
    }
  }
  parts.push(expr.slice(start));
  const isLiteral = text => /^(-?[\d][\w.]*|true|false|null|\[\]|\{\}|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(text);
  const seen = new Set();
  const cleaned = [];
  for (const part of parts) {
    let text = part.trim();
    // Dafny synthesises ghost guards to describe loop iterations; the
    // assignments are bookkeeping, and implications just scope a fact to
    // "after some loop iterations" — show the fact itself.
    if (/^counterexampleLoopGuard\d+\s*:=/.test(text)) continue;
    // Reference types are non-null by construction; the model restates it.
    if (/^[A-Za-z_][\w'.]*\s*!=\s*null$/.test(text)) continue;
    text = text.replace(/^counterexampleLoopGuard\d+\s*==>\s*/, "");
    // Model output tends to say "0 == x"; people read "x == 0".
    const eq = text.match(/^(.+?)\s*==\s*(.+)$/);
    if (eq && isLiteral(eq[1]) && !isLiteral(eq[2])) {
      text = eq[2] + " == " + eq[1];
    }
    if (text.length > 0 && !seen.has(text)) {
      seen.add(text);
      cleaned.push(text);
    }
  }
  return cleaned;
}

const CEX_KEYWORDS = new Set(["true", "false", "null", "forall", "exists", "in", "old", "if", "then", "else"]);

// Lightweight Dafny expression highlighter matching the editor palette.
function highlightConstraint(text) {
  const fragment = document.createDocumentFragment();
  const tokens = text.match(/\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][\w']*|-?\d[\w.]*|<==>|==>|<==|::|==|!=|<=|>=|&&|\|\||[-+*\/%<>=!&|^~?:.,()\[\]{}]|\s+/g) ?? [text];
  for (const token of tokens) {
    const span = document.createElement("span");
    span.textContent = token;
    if (token.startsWith("//")) span.className = "cex-tok-comment";
    else if (/^["']/.test(token)) span.className = "cex-tok-string";
    else if (/^-?\d/.test(token)) span.className = "cex-tok-number";
    else if (CEX_KEYWORDS.has(token)) span.className = "cex-tok-keyword";
    else if (/^[A-Za-z_]/.test(token)) span.className = "cex-tok-name";
    else if (/^\s+$/.test(token)) span.className = "";
    else span.className = "cex-tok-op";
    fragment.append(span);
  }
  return fragment;
}

function counterexampleStateLabel(state) {
  if (state.isInitial || /initial state/.test(state.name)) return "on entry";
  return "line " + state.line;
}

// Editor ghost values: debugger-style inline annotations at each state line.
class CounterexampleGhost extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return other.text === this.text; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-cex-ghost";
    span.textContent = "  ⇐ " + this.text;
    return span;
  }
  ignoreEvent() { return true; }
}

const setCounterexampleGhostsEffect = StateEffect.define();

const counterexampleGhostField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) return Decoration.none;
    for (const effect of transaction.effects) {
      if (effect.is(setCounterexampleGhostsEffect)) {
        const doc = transaction.state.doc;
        const byLine = new Map();
        for (const ghost of effect.value) {
          if (Number.isInteger(ghost.line) && ghost.line >= 1 && ghost.line <= doc.lines) {
            byLine.set(ghost.line, ghost.text);
          }
        }
        return Decoration.set([...byLine.entries()].map(([line, text]) =>
          Decoration.widget({ widget: new CounterexampleGhost(text), side: 1 })
            .range(doc.line(line).to)), true);
      }
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

// The states of one counterexample, as ghost annotations showing what is NEW
// at each step of the trace.
function ghostsForCounterexample(states) {
  const ghosts = [];
  let previous = new Set();
  for (const state of states) {
    const constraints = counterexampleConstraints(state.assumption);
    const fresh = constraints.filter(constraint => !previous.has(constraint));
    previous = new Set(constraints);
    if (fresh.length > 0) {
      let text = fresh.join(", ");
      if (text.length > 64) {
        text = text.slice(0, 61) + "…";
      }
      ghosts.push({ line: state.line, text });
    }
  }
  return ghosts;
}

const emptyDiagnosticState = {
  decorations: Decoration.none,
  markers: RangeSet.empty,
  diagnostics: []
};

const severityPriority = { error: 3, warning: 2, info: 1 };

class DiagnosticGutterMarker extends GutterMarker {
  constructor(severity, messages) {
    super();
    this.severity = severity;
    this.messages = messages;
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = "diagnostic-gutter-marker " + this.severity;
    marker.title = this.messages.join("\n");
    marker.setAttribute("aria-label", this.severity + ": " + this.messages.join(". "));
    return marker;
  }
}

function normalizedSeverity(severity) {
  return severity === "error" || severity === "warning" ? severity : "info";
}

function diagnosticTokenRange(doc, line, column) {
  let start = line.from + Math.max(0, (column ?? 1) - 1);
  start = Math.min(Math.max(start, line.from), line.to);
  if (line.length === 0) {
    return null;
  }
  if (start === line.to) {
    start = Math.max(line.from, line.to - 1);
  }

  let end = start;
  const first = doc.sliceString(start, Math.min(start + 1, line.to));
  const word = /[A-Za-z0-9_']/u.test(first);
  while (end < line.to) {
    const character = doc.sliceString(end, end + 1);
    if (word ? !/[A-Za-z0-9_']/u.test(character) : /\s/u.test(character)) {
      break;
    }
    end++;
  }
  if (end === start) {
    end = Math.min(line.to, start + 1);
  }
  return end > start ? { from: start, to: end } : null;
}

function createDiagnosticState(doc, diagnostics) {
  const valid = diagnostics
    .filter(diagnostic => Number.isInteger(diagnostic.line) &&
      diagnostic.line >= 1 && diagnostic.line <= doc.lines)
    .map(diagnostic => ({ ...diagnostic, severity: normalizedSeverity(diagnostic.severity) }));
  const decorations = [];
  const lineGroups = new Map();

  for (const diagnostic of valid) {
    const line = doc.line(diagnostic.line);
    const existing = lineGroups.get(diagnostic.line) ?? [];
    existing.push(diagnostic);
    lineGroups.set(diagnostic.line, existing);

    const tokenRange = diagnosticTokenRange(doc, line, diagnostic.column);
    if (tokenRange) {
      decorations.push(Decoration.mark({
        class: "cm-diagnostic-range-" + diagnostic.severity,
        attributes: {
          title: diagnostic.message,
          "aria-label": diagnostic.severity + ": " + diagnostic.message
        }
      }).range(tokenRange.from, tokenRange.to));
    }
  }

  const markers = [];
  for (const [lineNumber, lineDiagnostics] of lineGroups) {
    const severity = lineDiagnostics.reduce((current, diagnostic) =>
      severityPriority[diagnostic.severity] > severityPriority[current]
        ? diagnostic.severity
        : current, "info");
    const line = doc.line(lineNumber);
    decorations.push(Decoration.line({
      attributes: {
        class: "cm-diagnostic-line-" + severity,
        title: lineDiagnostics.map(diagnostic => diagnostic.message).join("\n")
      }
    }).range(line.from));
    markers.push(new DiagnosticGutterMarker(
      severity,
      lineDiagnostics.map(diagnostic => diagnostic.message)
    ).range(line.from));
  }

  return {
    decorations: Decoration.set(decorations, true),
    markers: RangeSet.of(markers, true),
    diagnostics: valid
  };
}

const diagnosticField = StateField.define({
  create: () => emptyDiagnosticState,
  update(value, transaction) {
    let next = transaction.docChanged ? emptyDiagnosticState : value;
    for (const effect of transaction.effects) {
      if (effect.is(setDiagnosticsEffect)) {
        next = createDiagnosticState(transaction.state.doc, effect.value);
      }
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

const diagnosticGutter = gutter({
  class: "cm-diagnostic-gutter",
  markers: view => view.state.field(diagnosticField).markers,
  initialSpacer: () => new DiagnosticGutterMarker("info", [])
});

const diagnosticHover = hoverTooltip((view, position) => {
  const line = view.state.doc.lineAt(position);
  const diagnostics = view.state.field(diagnosticField).diagnostics
    .filter(diagnostic => diagnostic.line === line.number);
  if (diagnostics.length === 0) {
    return null;
  }

  return {
    pos: line.from,
    end: line.to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-tooltip-diagnostic";
      for (const diagnostic of diagnostics) {
        const row = document.createElement("div");
        row.className = "diagnostic-tooltip-row " + diagnostic.severity;
        const label = document.createElement("strong");
        label.textContent = diagnostic.severity;
        const message = document.createElement("span");
        message.textContent = diagnostic.message;
        row.append(label, message);
        dom.append(row);
      }
      return { dom };
    }
  };
}, { hoverTime: 250 });

const runtimeState = document.querySelector("#runtime-state");
const runtimeDot = document.querySelector("#runtime-dot");
const runtimeLabel = document.querySelector("#runtime-label");
const runtimeNote = document.querySelector("#runtime-note");
const loadProgress = document.querySelector("#load-progress");
const loadProgressFill = document.querySelector("#load-progress-fill");
const editorHost = document.querySelector("#editor");
const verifyButton = document.querySelector("#verify");
const verifyLabel = document.querySelector("#verify-label");
const modifiedDot = document.querySelector("#modified-dot");
const problemsTab = document.querySelector("#problems-tab");
const outputTab = document.querySelector("#output-tab");
const problemsView = document.querySelector("#problems-view");
const outputView = document.querySelector("#output-view");
const output = document.querySelector("#output");
const runButton = document.querySelector("#run");
const runLabel = document.querySelector("#run-label");
const runTab = document.querySelector("#run-tab");
const runView = document.querySelector("#run-view");
const runOutput = document.querySelector("#run-output");
const jsTab = document.querySelector("#js-tab");
const jsView = document.querySelector("#js-view");
const jsOutput = document.querySelector("#js-output");
const boogieTab = document.querySelector("#boogie-tab");
const boogieView = document.querySelector("#boogie-view");
const boogieOutput = document.querySelector("#boogie-output");
const boogieNote = document.querySelector("#boogie-note");
const smtTab = document.querySelector("#smt-tab");
const smtView = document.querySelector("#smt-view");
const smtOutput = document.querySelector("#smt-output");
const smtNote = document.querySelector("#smt-note");
const problemCount = document.querySelector("#problem-count");
const problemFilters = document.querySelector("#problem-filters");
const problemsList = document.querySelector("#problems-list");
const emptyState = document.querySelector("#empty-state");
const resultSummary = document.querySelector("#result-summary");
const resultIcon = document.querySelector("#result-icon");
const resultTitle = document.querySelector("#result-title");
const resultDetail = document.querySelector("#result-detail");
const verificationStage = document.querySelector("#verification-stage");
const cursorPosition = document.querySelector("#cursor-position");

let currentDiagnostics = [];
let activeSeverity = "all";
let running = false;
let suppressEmptyState = false;
let editor;

document.querySelector("#verify-kbd").textContent =
  /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘↵" : "Ctrl+↵";

const RESULT_SVG = {
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  idle: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.9" y="4.9" width="6.2" height="6.2" rx="1" transform="rotate(45 8 8)" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  busy: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>'
};
function setResultIcon(kind) {
  resultIcon.innerHTML = RESULT_SVG[kind];
}

let dafnyInstance = null;

const verifierReady = createDafny({
  onProgress({ stage, loadedBytes, totalBytes }) {
    const megabytes = (loadedBytes / (1024 * 1024)).toFixed(0);
    runtimeLabel.textContent = loadedBytes > 0
      ? stage + "… " + megabytes + " MB"
      : stage + "…";
    const percent = Math.min(99, Math.round((loadedBytes / totalBytes) * 100));
    loadProgress.setAttribute("aria-valuenow", String(percent));
    loadProgressFill.style.width = Math.max(2, percent) + "%";
  },
  onRestart(reason) {
    runtimeDot.className = "status-dot is-loading";
    runtimeLabel.textContent = reason === "cancelled"
      ? "Cancelled — restarting verifier…"
      : "Verifier crashed — restarting…";
    verifyButton.disabled = true;
    runButton.disabled = true;
    dafnyInstance?.whenReady().then(() => {
      runtimeDot.className = "status-dot is-ready";
      runtimeLabel.textContent = "Verifier ready";
      verifyButton.disabled = false;
      runButton.disabled = false;
    }).catch(() => {
      runtimeDot.className = "status-dot is-error";
      runtimeLabel.textContent = "Verifier unavailable — reload the page";
    });
  }
});
verifierReady.then(dafny => { dafnyInstance = dafny; });
const parse = source => verifierReady.then(dafny => dafny.parse(source));
const verify = (source, verifyOptions) => verifierReady.then(dafny => dafny.verify(source, verifyOptions));
const getLastSmtTranscript = () => verifierReady.then(dafny => dafny.getLastSmtTranscript());
const getLastBoogie = () => verifierReady.then(dafny => dafny.getLastBoogie());
window.dafny = { parse, verify, getLastSmtTranscript, getLastBoogie };

function updateCursor(view) {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  cursorPosition.textContent = "Ln " + line.number + ", Col " + (head - line.from + 1);
}

function clearResultForEdit() {
  currentDiagnostics = [];
  suppressEmptyState = false;
  renderProblems();
  modifiedDot.classList.add("is-visible");
  resultSummary.className = "result-summary is-idle";
  setResultIcon("idle");
  resultTitle.textContent = "Source modified";
  resultDetail.textContent = "Verify to refresh diagnostics.";
  verificationStage.textContent = "Modified";
}

editor = new EditorView({
  parent: editorHost,
  state: EditorState.create({
    doc: examples.abs,
    extensions: [
      lineNumbers(),
      diagnosticGutter,
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      search({ top: true }),
      dafnyLanguage,
      syntaxHighlighting(dafnyHighlight),
      themedEditorExtension(() => editor),
      diagnosticField,
      counterexampleGhostField,
      diagnosticHover,
      EditorState.tabSize.of(2),
      keymap.of([
        { key: "Mod-Enter", run: () => { runVerification(); return true; } },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap
      ]),
      EditorView.updateListener.of(update => {
        updateCursor(update.view);
        if (update.docChanged) {
          clearResultForEdit();
          scheduleLiveVerify();
        }
      })
    ]
  })
});
updateCursor(editor);

const panels = {
  problems: [problemsTab, problemsView],
  output: [outputTab, outputView],
  run: [runTab, runView],
  js: [jsTab, jsView],
  boogie: [boogieTab, boogieView],
  smt: [smtTab, smtView]
};

// The expert views (compiled JS, SMT transcript, raw result) live behind one
// "Under the hood" tab that first-time visitors don't see: a muted
// "internals" affordance reveals it, "hide" tucks it away, and the choice
// persists per browser. Students meet Problems + Run and nothing else.
const hoodTab = document.querySelector("#hood-tab");
const hoodBar = document.querySelector("#hood-bar");
const internalsReveal = document.querySelector("#internals-reveal");
const internalsHide = document.querySelector("#internals-hide");
const HOOD_VIEWS = ["js", "boogie", "smt", "output"];
const INTERNALS_KEY = "dafny-verify-internals";
let lastHoodView = "js";

function setPanel(panel) {
  const inHood = HOOD_VIEWS.includes(panel);
  if (inHood) {
    lastHoodView = panel;
    if (hoodTab.hidden) {
      setInternalsOpen(true);
    }
  }
  for (const [name, [tab, view]] of Object.entries(panels)) {
    const active = name === panel;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    view.hidden = !active;
  }
  hoodTab.classList.toggle("is-active", inHood);
  hoodTab.setAttribute("aria-selected", String(inHood));
  hoodBar.hidden = !inHood;
}

function setInternalsOpen(open) {
  hoodTab.hidden = !open;
  internalsReveal.hidden = open;
  try {
    if (open) {
      localStorage.setItem(INTERNALS_KEY, "1");
    } else {
      localStorage.removeItem(INTERNALS_KEY);
    }
  } catch {
    // Private browsing / storage-blocked contexts: the session still works,
    // the preference just doesn't persist.
  }
}

try {
  setInternalsOpen(localStorage.getItem(INTERNALS_KEY) === "1");
} catch {
  setInternalsOpen(false);
}

problemsTab.addEventListener("click", () => setPanel("problems"));
runTab.addEventListener("click", () => setPanel("run"));
hoodTab.addEventListener("click", () => {
  setPanel(lastHoodView);
  if (lastHoodView === "smt") renderSmtTranscript();
  if (lastHoodView === "boogie") renderBoogie();
});
internalsReveal.addEventListener("click", () => {
  setInternalsOpen(true);
  setPanel(lastHoodView);
});
internalsHide.addEventListener("click", () => {
  setInternalsOpen(false);
  setPanel("problems");
});
jsTab.addEventListener("click", () => setPanel("js"));
boogieTab.addEventListener("click", () => { setPanel("boogie"); renderBoogie(); });
outputTab.addEventListener("click", () => setPanel("output"));
smtTab.addEventListener("click", () => { setPanel("smt"); renderSmtTranscript(); });

// ---------- Resizable dividers ----------
// The workspace grid reserves 5px splitter tracks; dragging writes a pixel
// value into the matching CSS variable. Double-click resets to the
// responsive default; sizes persist per browser.
const workspace = document.querySelector(".workspace");
const LAYOUT_KEY = "dafny-verify-layout";
let layoutSizes = {};
try {
  layoutSizes = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") ?? {};
} catch {}

const LAYOUT_VARS = { panel: "--panel-col", tutorial: "--tutorial-col", panelRow: "--panel-row" };

function applyLayoutSizes() {
  for (const [key, cssVar] of Object.entries(LAYOUT_VARS)) {
    if (layoutSizes[key] > 0) {
      workspace.style.setProperty(cssVar, layoutSizes[key] + "px");
    } else {
      workspace.style.removeProperty(cssVar);
    }
  }
}
applyLayoutSizes();

function saveLayoutSizes() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutSizes));
  } catch {}
}

function wireSplitter(element, getTarget) {
  element.addEventListener("pointerdown", event => {
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    element.classList.add("is-dragging");
    document.body.classList.add("is-resizing");
    const bounds = workspace.getBoundingClientRect();
    const target = getTarget();
    const onMove = ev => {
      const value = target.horizontal
        ? Math.min(Math.max(bounds.bottom - ev.clientY, 120), bounds.height - 160)
        : Math.min(Math.max(bounds.right - ev.clientX, 280), bounds.width - 380);
      layoutSizes[target.key] = Math.round(value);
      applyLayoutSizes();
    };
    const onUp = () => {
      element.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onUp);
      saveLayoutSizes();
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onUp);
  });
  element.addEventListener("dblclick", () => {
    delete layoutSizes[getTarget().key];
    applyLayoutSizes();
    saveLayoutSizes();
  });
}

// The vertical divider resizes whichever column it borders: the panel
// normally, the tutorial when tutorial mode has the right column.
wireSplitter(document.querySelector("#split-main"), () =>
  document.body.classList.contains("tutorial-on")
    ? { key: "tutorial", horizontal: false }
    : { key: "panel", horizontal: false });
wireSplitter(document.querySelector("#split-panel"), () => ({ key: "panelRow", horizontal: true }));

// ---------- Toolbar dropdown menus ----------

const MENUS = [
  ["#examples-menu-button", "#examples-menu"],
  ["#share-menu-button", "#share-menu"],
  ["#settings-menu-button", "#settings-menu"]
];
function closeAllMenus() {
  for (const [buttonSel, menuSel] of MENUS) {
    document.querySelector(menuSel).hidden = true;
    document.querySelector(buttonSel).setAttribute("aria-expanded", "false");
  }
}
for (const [buttonSel, menuSel] of MENUS) {
  const button = document.querySelector(buttonSel);
  const menu = document.querySelector(menuSel);
  button.addEventListener("click", event => {
    event.stopPropagation();
    const willOpen = menu.hidden;
    closeAllMenus();
    menu.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
  });
  menu.addEventListener("click", event => {
    event.stopPropagation();
    const item = event.target.closest(".menu-item");
    // Items close the menu after their own handler ran; rows marked
    // keep-open (toggles, copy feedback) leave it up.
    if (item && !item.classList.contains("keep-open")) {
      setTimeout(closeAllMenus, 0);
    }
  });
}
document.addEventListener("click", closeAllMenus);
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeAllMenus();
});

document.querySelector("#examples-menu").addEventListener("click", event => {
  const item = event.target.closest("[data-example]");
  if (!item) return;
  const source = examples[item.dataset.example] ?? examples.abs;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: source },
    selection: { anchor: 0 },
    effects: EditorView.scrollIntoView(0, { y: "start" })
  });
  editor.focus();
});

// ---------- Boogie translation tab ----------
// The readable middle layer: Dafny -> Boogie -> verification conditions ->
// SMT. Fetched lazily on tab open; prelude declarations are filtered on the
// C# side, so this is the program-specific translation only.
const boogieLanguage = StreamLanguage.define({
  name: "boogie",
  startState: () => ({ blockComment: false }),
  token(stream, state) {
    if (state.blockComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.blockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/*")) { state.blockComment = true; return "comment"; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^\{:/)) { stream.match(/^[\w.]+/); return "meta"; }
    if (stream.match(/^-?\d+(?:\.\d+|bv\d+|e-?\d+)?/)) return "number";
    if (stream.match(/^[a-zA-Z_$'#.@!^?`~][\w$'#.@!^?`~]*/)) {
      const word = stream.current();
      if (BOOGIE_KEYWORDS.has(word)) return "keyword";
      if (BOOGIE_TYPES.has(word)) return "typeName";
      if (word === "true" || word === "false") return "bool";
      return "variableName";
    }
    if (stream.match(/^(?:==>|<==>|&&|\|\||[=<>!+\-*\/%:]=?)/)) return "operator";
    stream.next();
    return null;
  }
});
const BOOGIE_KEYWORDS = new Set(["type", "const", "function", "axiom", "var",
  "procedure", "implementation", "returns", "requires", "ensures", "modifies",
  "free", "invariant", "assert", "assume", "havoc", "call", "goto", "return",
  "if", "else", "while", "break", "where", "unique", "complete", "finite",
  "old", "forall", "exists", "lambda", "cast", "div", "mod", "uses", "hideable", "reveal"]);
const BOOGIE_TYPES = new Set(["bool", "int", "real", "bv8", "bv16", "bv32", "bv64"]);

// Hover explanations for the recurring verification-encoding symbols.
const ENCODING_GLOSSARY = [
  [/^\$?Heap[@\d]*$/, "the model of Dafny's mutable heap — a map from (reference, field) to values; updated on writes, quantified over in frame axioms"],
  [/^ControlFlow$/, "Boogie's encoding of the program's control-flow graph: ControlFlow(0, block) picks the successor, letting one formula cover every path"],
  [/^T@U$/, "the universal box sort — every Dafny value is boxed into it so one SMT sort covers all types"],
  [/^T@T$/, "the sort of type descriptors — Dafny types reified as values, for typing axioms"],
  [/^\$?(Box|Unbox)$/, "coercion between a typed value and the universal box sort T@U"],
  [/^alloc$/, "the ghost field marking whether an object is allocated in a given heap"],
  [/^tickleBool$/, "a benign axiom that mentions both booleans, nudging Z3's triggers — pure solver pragmatics"],
  [/^\$generated(@@\d+)?$/, "a normalized identifier (solver-cache determinism) — flip 'readable names' to see the real one"],
  [/^\$_ModifiesFrame[@\d]*$/, "the method's frame: which (object, field) pairs it may modify"],
  [/^\$_reverifyPost$/, "bookkeeping for Dafny's incremental re-verification of postconditions"],
  [/^(Tag|Tclass\..*|TagClass.*)$/, "type-descriptor plumbing: tags distinguish which Dafny type a descriptor stands for"],
  [/^UOrdering\d$/, "ordering predicates used for datatype rank comparisons (termination proofs)"]
];

function glossaryTooltip(view, pos) {
  const { from, to, text } = view.state.doc.lineAt(pos);
  let start = pos - from, end = pos - from;
  const isWord = ch => /[\w$@.]/.test(ch);
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  if (start === end) return null;
  const word = text.slice(start, end);
  const entry = ENCODING_GLOSSARY.find(([pattern]) => pattern.test(word));
  if (!entry) return null;
  return {
    pos: from + start,
    end: from + end,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-tooltip-diagnostic";
      dom.textContent = word + " — " + entry[1];
      return { dom };
    }
  };
}
const glossaryHover = hoverTooltip(glossaryTooltip, { hoverTime: 300 });

let boogieEditor = null;
let boogieDirty = false;

async function renderBoogie() {
  if (!boogieDirty) return;
  boogieDirty = false;
  try {
    const text = await getLastBoogie();
    if (!text) {
      boogieNote.textContent = "no Boogie program recorded — verify first";
      return;
    }
    window.__boogieText = text;
    boogieNote.textContent = text.split("\n").length + " lines, " +
      (text.length / 1024).toFixed(0) + " KB (prelude axioms omitted)";
    if (!boogieEditor) {
      boogieOutput.textContent = "";
      boogieEditor = new EditorView({
        parent: boogieOutput,
        state: EditorState.create({
          doc: "",
          extensions: [
            lineNumbers(),
            highlightSpecialChars(),
            drawSelection(),
            bracketMatching(),
            search({ top: true }),
            boogieLanguage,
            glossaryHover,
            syntaxHighlighting(dafnyHighlight),
            themedEditorExtension(() => boogieEditor),
            EditorState.readOnly.of(true),
            keymap.of([...defaultKeymap, ...searchKeymap])
          ]
        })
      });
    }
    boogieEditor.dispatch({ changes: { from: 0, to: boogieEditor.state.doc.length, insert: text } });
    // Open at the statement matching the editor cursor when possible (the
    // translation carries /input.dfy(line,col) breadcrumbs), else at the
    // first implementation rather than the module type/axiom plumbing.
    const cursorLine = editor.state.doc.lineAt(editor.state.selection.main.head).number;
    let target = -1;
    for (let line = cursorLine; line >= 1 && target < 0; line--) {
      target = text.indexOf("/input.dfy(" + line + ",");
    }
    if (target < 0) {
      target = text.indexOf("\nimplementation") + 1;
    }
    if (target > 0) {
      boogieEditor.dispatch({
        selection: { anchor: target },
        effects: EditorView.scrollIntoView(target, { y: "center" })
      });
    }
  } catch (error) {
    boogieNote.textContent = "could not load the Boogie program: " + (error?.message ?? error);
    boogieDirty = true;
  }
}

// ---------- SMT transcript tab ----------
// The actual SMT-LIB conversation between Boogie and Z3 for the last
// verification — fetched lazily on tab open (transcripts run to hundreds of
// KB; CodeMirror virtualizes the rendering). Entries: {kind: "problem",
// input: name} markers and {kind: "exchange", input: script, output:
// response} pairs; responses become comments so the text stays one valid
// SMT-LIB document for the scheme highlighter.
// A real SMT-LIB mode (the generic scheme mode only knows comments/strings/
// numbers, leaving the actual vocabulary monochrome). Head position matters:
// the first symbol after "(" is a command, binder, or builtin application.
const SMT_COMMANDS = new Set(["assert", "check-sat", "check-sat-assuming",
  "declare-const", "declare-datatype", "declare-datatypes", "declare-fun",
  "declare-sort", "define-const", "define-fun", "define-fun-rec",
  "define-sort", "echo", "exit", "get-assertions", "get-assignment",
  "get-info", "get-model", "get-option", "get-proof", "get-unsat-core",
  "get-value", "labels", "eval", "pop", "push", "reset", "reset-assertions",
  "set-info", "set-logic", "set-option"]);
const SMT_DECLARES = new Set(["declare-const", "declare-datatype",
  "declare-fun", "declare-sort", "define-const", "define-fun",
  "define-fun-rec", "define-sort"]);
const SMT_BINDERS = new Set(["forall", "exists", "let", "lambda", "match", "!", "as", "par"]);
const SMT_BUILTINS = new Set(["and", "or", "not", "=>", "=", "distinct",
  "ite", "xor", "implies", "+", "-", "*", "/", "div", "mod", "abs",
  "<=", "<", ">=", ">", "select", "store", "concat", "to_int", "to_real"]);
const SMT_SORTS = new Set(["Bool", "Int", "Real", "String", "Array",
  "BitVec", "RoundingMode", "Float32", "Float64", "Seq", "RegEx"]);

const smtLanguage = StreamLanguage.define({
  name: "smtlib",
  startState: () => ({ head: false, defNext: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match(";")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^"(?:[^"]|"")*"?/)) return "string";
    if (stream.match(/^#[xb][0-9a-fA-F]+/)) return "number";
    if (stream.match(/^-?\d+(?:\.\d+)?/)) return "number";
    if (stream.match(/^:[\w.$@%^&*_\-+=<>/?!~]+/)) return "meta";
    if (stream.match(/^\|[^|]*\|/)) {
      state.head = false;
      return "typeName";
    }
    const ch = stream.peek();
    if (ch === "(") {
      stream.next();
      state.head = true;
      return "punctuation";
    }
    if (ch === ")") {
      stream.next();
      state.head = false;
      return "punctuation";
    }
    if (stream.match(/^[\w.$@%^&*_\-+=<>/?!~']+/)) {
      const word = stream.current();
      const wasHead = state.head;
      state.head = false;
      if (wasHead) {
        if (SMT_COMMANDS.has(word)) {
          state.defNext = SMT_DECLARES.has(word);
          return "keyword";
        }
        if (SMT_BINDERS.has(word)) return "keyword";
        if (SMT_BUILTINS.has(word)) return "operator";
        return "variableName";
      }
      if (word === "true" || word === "false") return "bool";
      if (SMT_SORTS.has(word)) return "typeName";
      if (state.defNext) {
        state.defNext = false;
        return "def";
      }
      return "variableName";
    }
    stream.next();
    return null;
  }
});
const SMT_RENDER_LIMIT = 4 * 1024 * 1024;
let smtEditor = null;
let smtDirty = false;
let smtSections = null;
const smtObligationSelect = document.querySelector("#smt-obligation");
const smtReadable = document.querySelector("#smt-readable");
const smtHidePrelude = document.querySelector("#smt-hide-prelude");
smtHidePrelude.addEventListener("change", () => renderSmtSlice());

smtReadable.addEventListener("change", () => {
  if (running || runInFlight) {
    smtReadable.checked = !smtReadable.checked;
    return;
  }
  // Quiet re-verify (live-style: no panel switch); the fresh transcript and
  // Boogie program re-render through the usual dirty flags.
  runVerification({ live: true });
});

// Group the raw entry list into a session preamble (options + the Dafny
// prelude, sent before the first obligation) and one section per proof
// obligation, keeping absolute exchange numbers for cross-reference.
function buildSmtSections(entries) {
  const sections = { preamble: [], obligations: [] };
  let current = null;
  let exchange = 0;
  for (const entry of entries) {
    if (entry.kind === "problem") {
      // Boogie announces the problem AFTER transmitting its setup and
      // verification condition; the previous obligation's own exchanges end
      // at its (pop 1). Everything after that belongs to the new obligation.
      const previousParts = current ? current.parts : sections.preamble;
      let split = previousParts.length;
      for (let i = previousParts.length - 1; i >= 0; i--) {
        if (previousParts[i].includes("(pop 1)")) { split = i + 1; break; }
        if (i === 0) split = 0;
      }
      current = { name: entry.input, parts: previousParts.splice(split) };
      sections.obligations.push(current);
      continue;
    }
    exchange += 1;
    const text = `;; ---- exchange ${exchange}: Boogie sends ----\n` +
      entry.input.trim() + "\n;; ---- Z3 answers ----\n" +
      entry.output.trim().split("\n").map(line => ";;   " + line).join("\n") + "\n\n";
    (current ? current.parts : sections.preamble).push(text);
  }
  return { ...sections, totalExchanges: exchange };
}

// Obligation names look like Impl$$_module.__default.FastFib or
// CheckWellformed$$_module.__default.Fib; surface the method name and the
// obligation kind, and link both ways with the editor (method level).
function obligationParts(name) {
  const [kind, path] = name.split("$$");
  const method = (path ?? name).split(".").pop();
  const kindLabel = kind === "Impl" ? "correctness"
    : kind === "CheckWellformed" ? "well-formedness"
    : kind;
  return { method, kindLabel };
}

function obligationLabel(name) {
  const { method, kindLabel } = obligationParts(name);
  return method + " — " + kindLabel;
}

// The declaration enclosing the editor cursor, by scanning backwards.
function declarationAtCursor() {
  const doc = editor.state.doc.toString();
  const head = editor.state.selection.main.head;
  const declarations = [...doc.matchAll(/\b(?:method|function|lemma|predicate|constructor|iterator)\s+([A-Za-z_'][\w']*)/g)];
  let enclosing = null;
  for (const match of declarations) {
    if (match.index <= head) enclosing = match[1];
  }
  return enclosing ?? declarations[0]?.[1] ?? null;
}

function obligationIndexForCursor() {
  if (!smtSections) return null;
  const name = declarationAtCursor();
  if (!name) return null;
  const index = smtSections.obligations.findIndex(o => obligationParts(o.name).method === name);
  return index >= 0 ? index : null;
}

// Picker -> editor: selecting an obligation highlights its declaration.
function jumpEditorToObligation(obligationName) {
  const { method } = obligationParts(obligationName);
  const doc = editor.state.doc.toString();
  const match = new RegExp("\\b(?:method|function|lemma|predicate|constructor|iterator)\\s+" +
    method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").exec(doc);
  if (!match) return;
  editor.dispatch({
    selection: { anchor: match.index, head: match.index + match[0].length },
    effects: EditorView.scrollIntoView(match.index, { y: "center" })
  });
}

function renderSmtSlice() {
  if (!smtSections || !smtEditor) return;
  const choice = smtObligationSelect.value;
  let parts, label;
  if (choice === "preamble") {
    parts = smtSections.preamble;
    label = "session setup — options and the Dafny prelude, sent once per solver session";
  } else if (choice === "all") {
    parts = [...smtSections.preamble];
    for (const obligation of smtSections.obligations) {
      parts.push(`\n;; ============ proof obligation: ${obligation.name} ============\n\n`, ...obligation.parts);
    }
    label = smtSections.totalExchanges + " exchanges";
  } else {
    const obligation = smtSections.obligations[Number(choice)];
    parts = obligation ? obligation.parts : [];
    label = obligation ? obligation.parts.length + " exchange" + (obligation.parts.length === 1 ? "" : "s") : "";
  }
  let text = parts.join("");
  if (choice !== "preamble" && choice !== "all" && smtHidePrelude.checked) {
    // Each obligation re-sends options + the Dafny prelude before its query
    // (the transport resets per obligation); start the display at the VC.
    const vc = text.indexOf("(push 1)");
    if (vc > 0) {
      const hidden = text.slice(0, vc).split("\n").length;
      text = ";; (options + prelude resend hidden — " + hidden +
        " lines; uncheck 'hide prelude' to show)\n\n" + text.slice(vc);
    }
  }
  if (text.length > SMT_RENDER_LIMIT) {
    text = text.slice(0, SMT_RENDER_LIMIT) +
      "\n;; …truncated for display (" + ((text.length / 1048576).toFixed(1)) + " MB total)\n";
  }
  smtNote.textContent = label + ", " + (text.length / 1024).toFixed(0) + " KB of SMT-LIB";
  smtEditor.dispatch({ changes: { from: 0, to: smtEditor.state.doc.length, insert: text } });
  if (choice !== "preamble" && choice !== "all" && !smtHidePrelude.checked) {
    // Open at the verification condition — everything above (push 1) is the
    // per-obligation resend of options and the Dafny prelude.
    const vc = text.indexOf("(push 1)");
    if (vc >= 0) {
      smtEditor.dispatch({
        selection: { anchor: vc },
        effects: EditorView.scrollIntoView(vc, { y: "start", yMargin: 8 })
      });
    }
  }
}

smtObligationSelect.addEventListener("change", () => {
  renderSmtSlice();
  const choice = smtObligationSelect.value;
  if (choice !== "preamble" && choice !== "all" && smtSections?.obligations[Number(choice)]) {
    jumpEditorToObligation(smtSections.obligations[Number(choice)].name);
  }
});

async function renderSmtTranscript() {
  if (!smtDirty) return;
  smtDirty = false;
  try {
    const entries = await getLastSmtTranscript();
    if (!Array.isArray(entries) || entries.length === 0) {
      smtNote.textContent = "no transcript recorded for the last verification";
      return;
    }
    smtSections = buildSmtSections(entries);
    // Full text stays available for tooling (CodeMirror virtualizes the view).
    window.__smtText = [...smtSections.preamble,
      ...smtSections.obligations.flatMap(o => [`;; ==== proof obligation: ${o.name} ====\n`, ...o.parts])].join("");
    smtObligationSelect.replaceChildren();
    for (const [index, obligation] of smtSections.obligations.entries()) {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = obligationLabel(obligation.name);
      option.title = obligation.name;
      smtObligationSelect.append(option);
    }
    if (smtSections.preamble.length > 0) {
      const preambleOption = document.createElement("option");
      preambleOption.value = "preamble";
      preambleOption.textContent = "session setup (" + smtSections.preamble.length + " exchanges)";
      smtObligationSelect.append(preambleOption);
    }
    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = "everything (" + smtSections.totalExchanges + " exchanges)";
    smtObligationSelect.append(allOption);
    smtObligationSelect.hidden = false;
    const cursorIndex = obligationIndexForCursor();
    smtObligationSelect.value = cursorIndex != null ? String(cursorIndex)
      : smtSections.obligations.length > 0 ? "0" : "all";
    if (!smtEditor) {
      smtOutput.textContent = "";
      smtEditor = new EditorView({
        parent: smtOutput,
        state: EditorState.create({
          doc: "",
          extensions: [
            lineNumbers(),
            highlightSpecialChars(),
            drawSelection(),
            bracketMatching(),
            search({ top: true }),
            smtLanguage,
            glossaryHover,
            syntaxHighlighting(dafnyHighlight),
            themedEditorExtension(() => smtEditor),
            EditorState.readOnly.of(true),
            keymap.of([...defaultKeymap, ...searchKeymap])
          ]
        })
      });
    }
    renderSmtSlice();
  } catch (error) {
    smtNote.textContent = "could not load the transcript: " + (error?.message ?? error);
    smtDirty = true;
  }
}

const tutorialToggle = document.querySelector("#tutorial-toggle");
const tutorialPane = document.querySelector("#tutorial-pane");

tutorialToggle.addEventListener("click", () => {
  const on = !document.body.classList.contains("tutorial-on");
  document.body.classList.toggle("tutorial-on", on);
  tutorialPane.hidden = !on;
  tutorialToggle.setAttribute("aria-pressed", String(on));
  tutorialToggle.classList.toggle("is-active", on);
  if (on) {
    ensureTutorialLoaded();
  }
});

// ---------- Tutorial (the revitalized rise4fun Dafny tutorial) ----------

let tutorialData = null;
let tutorialLoading = false;

async function ensureTutorialLoaded() {
  if (tutorialData || tutorialLoading) return;
  tutorialLoading = true;
  try {
    // The single-file build inlines the tutorial (fetch fails on file://).
    const inlineData = document.querySelector("#tutorial-data");
    tutorialData = inlineData
      ? JSON.parse(inlineData.textContent)
      : await (await fetch("./tutorial.json")).json();
    const chapterSelect = document.querySelector("#tutorial-chapter");
    chapterSelect.replaceChildren(...tutorialData.chapters.map((chapter, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = (index + 1) + ". " + chapter.title;
      return option;
    }));
    chapterSelect.addEventListener("change", () => renderTutorialChapter(Number(chapterSelect.value)));
    renderTutorialChapter(0);
  } catch (error) {
    document.querySelector("#tutorial-content").textContent =
      "Could not load the tutorial: " + (error?.message ?? error);
  } finally {
    tutorialLoading = false;
  }
}

function loadIntoEditor(code) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: code },
    selection: { anchor: 0 },
    effects: EditorView.scrollIntoView(0, { y: "start" })
  });
}

function renderTutorialChapter(index) {
  const chapter = tutorialData.chapters[index];
  const container = document.querySelector("#tutorial-content");
  container.replaceChildren();

  for (const segment of chapter.segments) {
    if (segment.kind === "prose") {
      const prose = document.createElement("div");
      prose.className = "tutorial-prose";
      prose.innerHTML = segment.html;
      container.append(prose);
      continue;
    }

    const block = document.createElement("div");
    block.className = "tutorial-code";
    const pre = document.createElement("pre");
    pre.append(highlightConstraint(segment.code));
    block.append(pre);

    if (segment.runnable) {
      const bar = document.createElement("div");
      bar.className = "tutorial-code-bar";

      const runButton = document.createElement("button");
      runButton.type = "button";
      runButton.className = "tutorial-run";
      runButton.textContent = "▶ Verify";

      const loadButton = document.createElement("button");
      loadButton.type = "button";
      loadButton.className = "tutorial-load";
      loadButton.textContent = "Open in editor";
      loadButton.addEventListener("click", () => loadIntoEditor(segment.code));

      const resolveOnly = segment.directive === "%check-resolve";
      const expectErrors = segment.expected?.expectErrors === true;
      const hint = document.createElement("span");
      hint.className = "tutorial-hint";
      if (resolveOnly) {
        hint.textContent = expectErrors
          ? "deliberately broken — expected: resolution error"
          : "incomplete example — checks resolution only";
      } else {
        hint.textContent = expectErrors ? "expected: does not verify" : "expected: verifies";
        if (segment.expected?.note) {
          hint.textContent += " (" + segment.expected.note.split(":")[0] + ")";
          hint.title = segment.expected.note;
        }
      }

      const badge = document.createElement("span");
      badge.className = "tutorial-badge";

      runButton.addEventListener("click", async () => {
        runButton.disabled = true;
        badge.className = "tutorial-badge is-running";
        badge.textContent = "verifying…";
        try {
          const dafny = await verifierReady;
          const result = await dafny.verify(segment.code, {
            timeLimitSeconds: Number(document.querySelector("#time-limit").value) || 0
          });
          const failed = !result.verified;
          if (resolveOnly) {
            // The tutorial's claim for this block is about resolution only —
            // which may itself be expected to fail (deliberately broken
            // module examples) or succeed (incomplete sketches).
            const resolutionFailed = ["parse", "resolution"].includes(result.stage);
            const matches = resolutionFailed === expectErrors;
            badge.className = "tutorial-badge " + (matches ? "is-good" : "is-odd");
            badge.textContent = (resolutionFailed
              ? "✗ resolution error" + (matches ? " (as the tutorial intends)" : "")
              : "✓ resolves" + (failed ? " (verification incomplete, as the text explains)" : "")) +
              (matches ? "" : " — differs from tutorial expectation");
          } else {
            const matches = failed === expectErrors;
            badge.className = "tutorial-badge " + (matches ? "is-good" : "is-odd");
            badge.textContent = (failed ? "✗ does not verify" : "✓ verifies") +
              (matches ? "" : " — differs from tutorial expectation");
          }
        } catch (error) {
          badge.className = "tutorial-badge is-odd";
          badge.textContent = String(error?.message ?? error) === "cancelled"
            ? "cancelled" : "verifier error";
        } finally {
          runButton.disabled = false;
        }
      });

      bar.append(runButton, loadButton, hint, badge);
      block.append(bar);
    }
    container.append(block);
  }

  const attribution = document.createElement("p");
  attribution.className = "tutorial-attribution";
  attribution.innerHTML = 'From the <a href="https://github.com/dafny-lang/dafny/tree/master/docs/OnlineTutorial" target="_blank" rel="noopener">Dafny OnlineTutorial</a> (MIT) — the guide formerly hosted on rise4fun.';
  container.append(attribution);
  container.scrollTop = 0;
}

function jumpToDiagnostic(diagnostic) {
  if (!Number.isInteger(diagnostic.line) ||
      diagnostic.line < 1 ||
      diagnostic.line > editor.state.doc.lines) {
    return;
  }
  const line = editor.state.doc.line(diagnostic.line);
  const position = Math.min(
    line.to,
    line.from + Math.max(0, (diagnostic.column ?? 1) - 1)
  );
  editor.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: "center" })
  });
  editor.focus();
}

function renderProblems() {
  const filtered = activeSeverity === "all"
    ? currentDiagnostics
    : currentDiagnostics.filter(diagnostic => diagnostic.severity === activeSeverity);
  problemsList.replaceChildren();

  for (const diagnostic of filtered) {
    const item = document.createElement("li");
    item.className = "problem-item";
    const button = document.createElement("button");
    button.type = "button";
    const icon = document.createElement("span");
    icon.className = "problem-severity " + diagnostic.severity;
    icon.textContent = diagnostic.severity === "error" ? "×" : diagnostic.severity === "warning" ? "!" : "i";
    const copy = document.createElement("span");
    copy.className = "problem-copy";
    const message = document.createElement("span");
    message.className = "problem-message";
    message.textContent = diagnostic.message;
    const source = document.createElement("span");
    source.className = "problem-source";
    source.textContent = diagnostic.source ?? "dafny";
    copy.append(message, source);
    const location = document.createElement("span");
    location.className = "problem-location";
    location.textContent = Number.isInteger(diagnostic.line)
      ? diagnostic.line + ":" + (diagnostic.column ?? 1)
      : "";
    button.append(icon, copy, location);
    if (Number.isInteger(diagnostic.line)) {
      button.title = "Go to line " + diagnostic.line;
      button.addEventListener("click", () => jumpToDiagnostic(diagnostic));
    }
    item.append(button);
    if (Array.isArray(diagnostic.counterexample) && diagnostic.counterexample.length > 0) {
      item.append(renderCounterexample(diagnostic.counterexample));
    }
    problemsList.append(item);
  }

  problemCount.textContent = String(currentDiagnostics.length);
  problemFilters.hidden = currentDiagnostics.length === 0;
  // The success/running summary card already says there is nothing to show;
  // only display the placeholder when it adds information (e.g. a filter
  // matches nothing).
  emptyState.hidden = filtered.length !== 0 ||
    (suppressEmptyState && currentDiagnostics.length === 0);
}

problemFilters.addEventListener("click", event => {
  const filter = event.target.closest("[data-severity]");
  if (!filter) {
    return;
  }
  activeSeverity = filter.dataset.severity;
  for (const candidate of problemFilters.querySelectorAll("[data-severity]")) {
    candidate.classList.toggle("is-active", candidate === filter);
  }
  renderProblems();
});

function renderCounterexample(states) {
  const container = document.createElement("div");
  container.className = "cex";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "cex-toggle";
  toggle.setAttribute("aria-expanded", "true");
  toggle.innerHTML = '<span class="cex-chevron">▾</span> counterexample' +
    '<span class="cex-count">' + states.length + ' state' + (states.length === 1 ? "" : "s") + '</span>';

  const block = document.createElement("div");
  block.className = "cex-block";

  let previous = new Set();
  for (const state of states) {
    const constraints = counterexampleConstraints(state.assumption);
    const card = document.createElement("div");
    card.className = "cex-state";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "cex-state-header";
    header.textContent = counterexampleStateLabel(state);
    header.title = "Go to line " + state.line;
    header.addEventListener("click", () => jumpToDiagnostic({ line: state.line, column: state.column + 1 }));
    card.append(header);

    const list = document.createElement("div");
    list.className = "cex-constraints";
    for (const constraint of constraints) {
      const row = document.createElement("code");
      row.className = "cex-constraint" + (previous.has(constraint) ? " is-carried" : "");
      row.append(highlightConstraint(constraint));
      list.append(row);
    }
    previous = new Set(constraints);
    card.append(list);
    block.append(card);
  }

  const note = document.createElement("a");
  note.className = "cex-note";
  note.href = "https://dafny.org/latest/DafnyRef/DafnyRef#sec-counterexamples";
  note.target = "_blank";
  note.rel = "noopener";
  note.textContent = "heuristic — may be incomplete or inconsistent";
  block.append(note);

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.querySelector(".cex-chevron").textContent = expanded ? "▸" : "▾";
    block.hidden = expanded;
  });

  container.append(toggle, block);
  return container;
}

function setRunningState(isRunning) {
  running = isRunning;
  // While running, the button stays enabled and becomes Cancel.
  verifyButton.disabled = false;
  verifyButton.classList.toggle("is-running", isRunning);
  verifyLabel.textContent = isRunning ? "Cancel" : "Verify";
  runButton.disabled = isRunning;
}

function showVerificationResult(result) {
  const editorDiagnostics = (result.diagnostics ?? [])
    .map(diagnostic => ({ ...diagnostic, severity: normalizedSeverity(diagnostic.severity) }))
    .filter(diagnostic => diagnostic.severity === "error" || diagnostic.severity === "warning");
  currentDiagnostics = editorDiagnostics;
  suppressEmptyState = result.verified;
  const firstCounterexample = editorDiagnostics.find(diagnostic =>
    Array.isArray(diagnostic.counterexample) && diagnostic.counterexample.length > 0);
  editor.dispatch({ effects: [
    setDiagnosticsEffect.of(editorDiagnostics),
    setCounterexampleGhostsEffect.of(
      firstCounterexample ? ghostsForCounterexample(firstCounterexample.counterexample) : [])
  ] });
  renderProblems();
  output.textContent = JSON.stringify(result, null, 2);
  smtDirty = true;
  boogieDirty = true;
  if (!panels.smt[1].hidden) {
    renderSmtTranscript();
  }
  if (!panels.boogie[1].hidden) {
    renderBoogie();
  }
  modifiedDot.classList.remove("is-visible");
  verificationStage.textContent = result.stage + " • " + result.smtExchangeCount + " SMT exchanges";

  if (result.verified) {
    resultSummary.className = "result-summary is-success";
    setResultIcon("check");
    resultTitle.textContent = "Verification succeeded";
    resultDetail.textContent = result.verifiedCount + " verified • " +
      result.smtExchangeCount + " SMT exchanges";
  } else {
    resultSummary.className = "result-summary is-error";
    setResultIcon("cross");
    resultTitle.textContent = result.errorCount + (result.errorCount === 1 ? " problem" : " problems");
    resultDetail.textContent = result.verifiedCount + " verified • stage: " + result.stage;
  }
}

function showRuntimeError(error) {
  const message = error?.stack ?? String(error);
  const diagnostic = {
    severity: "error",
    source: "runtime",
    message,
    line: null,
    column: null
  };
  currentDiagnostics = [diagnostic];
  editor.dispatch({ effects: setDiagnosticsEffect.of([]) });
  renderProblems();
  output.textContent = message;
  resultSummary.className = "result-summary is-error";
  setResultIcon("cross");
  resultTitle.textContent = "Verifier error";
  resultDetail.textContent = "See Output for details.";
  verificationStage.textContent = "Runtime error";
}

async function runVerification(options = {}) {
  const live = options?.live === true;
  if (running) {
    if (!live) {
      dafnyInstance?.cancel();
    }
    return;
  }
  if (verifyButton.disabled) {
    return;
  }
  setRunningState(true);
  if (!live) {
    setPanel("problems");
  }
  currentDiagnostics = [];
  suppressEmptyState = true;
  editor.dispatch({ effects: setDiagnosticsEffect.of([]) });
  renderProblems();
  resultSummary.className = "result-summary is-running";
  setResultIcon("busy");
  resultTitle.textContent = "Verifying";
  resultDetail.textContent = "Dafny → Boogie → Z3 WASM";
  verificationStage.textContent = "Verification running";
  output.textContent = "Verifying with Dafny, Boogie, and Z3 WASM…";

  try {
    const timeLimitSeconds = Number(document.querySelector("#time-limit").value) || 0;
    showVerificationResult(await verify(editor.state.doc.toString(),
      { timeLimitSeconds, counterexamples: true, readableNames: smtReadable.checked }));
  } catch (error) {
    if (String(error?.message) === "cancelled") {
      resultSummary.className = "result-summary is-idle";
      setResultIcon("idle");
      resultTitle.textContent = "Cancelled";
      resultDetail.textContent = "Verification aborted; the verifier is restarting.";
      verificationStage.textContent = "Cancelled";
      output.textContent = "Verification cancelled.";
    } else {
      showRuntimeError(error);
    }
  } finally {
    setRunningState(false);
  }
}

verifyButton.addEventListener("click", () => runVerification());

// ---------- Live mode (verify-as-you-type) ----------
// Opt-in: after a short idle pause, re-verify automatically. In-flight work
// is never cancelled (a worker recycle costs seconds) — the doc-change
// listener simply schedules again, so the latest text verifies as soon as
// the verifier is free. Bounded to modest program sizes; heavy proofs and
// the Run flow keep the manual buttons.
const liveToggle = document.querySelector("#live-toggle");
const LIVE_DEBOUNCE_MS = 700;
const LIVE_MAX_CHARS = 20000;
let liveMode = false;
let liveTimer = null;

function scheduleLiveVerify() {
  if (!liveMode) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(maybeLiveVerify, LIVE_DEBOUNCE_MS);
}

async function maybeLiveVerify() {
  if (!liveMode) return;
  if (running || runInFlight || verifyButton.disabled) {
    // Busy or still booting: check back shortly instead of piling up.
    clearTimeout(liveTimer);
    liveTimer = setTimeout(maybeLiveVerify, LIVE_DEBOUNCE_MS);
    return;
  }
  const doc = editor.state.doc.toString();
  if (!doc.trim() || doc.length > LIVE_MAX_CHARS) return;
  await runVerification({ live: true });
}

liveToggle.addEventListener("click", () => {
  liveMode = !liveMode;
  liveToggle.setAttribute("aria-pressed", String(liveMode));
  liveToggle.classList.toggle("is-active", liveMode);
  document.querySelector("#live-state").textContent = liveMode ? "on" : "off";
  if (liveMode) {
    scheduleLiveVerify();
  } else {
    clearTimeout(liveTimer);
  }
});

// ---------- Run (`dafny run` in the browser: verify, compile to JS, execute) ----------

let bignumberSourcePromise = null;
function loadBignumberSource() {
  // The single-file build inlines bignumber.js (fetch fails on file://).
  bignumberSourcePromise ??= (async () => {
    const inline = document.querySelector("#bignumber-src");
    if (inline) {
      return inline.textContent;
    }
    const response = await fetch(new URL("vendor/bignumber.js", window.location.href));
    if (!response.ok) {
      throw new Error("could not load vendor/bignumber.js: HTTP " + response.status);
    }
    return response.text();
  })();
  return bignumberSourcePromise;
}

let runInFlight = null; // { phase: "verify" | "execute", cancelExecute?: () => void }

// The JS tab: what the verified program compiles to, in a read-only
// CodeMirror. The 30 KB runtime prelude is stripped (the generated program
// starts at the "// Dafny program" banner). CodeMirror virtualizes long
// documents, so gates read window.__compiledJs, not the rendered DOM.
const jsLanguage = StreamLanguage.define(javascript);
let jsEditor = null;
let lastCompiled = null;

function showCompiledJs(compiled) {
  const marker = compiled.js.indexOf("// Dafny program");
  const program = (marker >= 0 ? compiled.js.slice(marker) : compiled.js) +
    (compiled.callToMain ? "\n" + compiled.callToMain : "");
  window.__compiledJs = program;
  lastCompiled = compiled;
  jsCopyButton.disabled = false;
  if (!jsEditor) {
    jsOutput.textContent = "";
    jsEditor = new EditorView({
      parent: jsOutput,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          drawSelection(),
          bracketMatching(),
          search({ top: true }),
          jsLanguage,
          syntaxHighlighting(dafnyHighlight),
          themedEditorExtension(() => jsEditor),
          EditorState.readOnly.of(true),
          keymap.of([...defaultKeymap, ...searchKeymap])
        ]
      })
    });
  }
  jsEditor.dispatch({ changes: { from: 0, to: jsEditor.state.doc.length, insert: program } });
}

function setRunUiState(isRunning) {
  runLabel.textContent = isRunning ? "Stop" : "Run";
  runButton.classList.toggle("is-running", isRunning);
  if (isRunning) {
    verifyButton.disabled = true;
  } else {
    // If a Stop recycled the worker, wait for the respawn before re-enabling.
    dafnyInstance?.whenReady()
      .then(() => { verifyButton.disabled = false; })
      .catch(() => {});
  }
}

function appendRunOutput(text) {
  runOutput.textContent += text;
  runView.scrollTop = runView.scrollHeight;
}

function showRunOutcome(kind, title, detail, stage) {
  resultSummary.className = "result-summary " + kind;
  setResultIcon(kind === "is-success" ? "check" : kind === "is-error" ? "cross" : "idle");
  resultTitle.textContent = title;
  resultDetail.textContent = detail;
  verificationStage.textContent = stage;
}

async function runProgram() {
  if (runInFlight) {
    if (runInFlight.phase === "execute") {
      runInFlight.cancelExecute?.();
    } else {
      dafnyInstance?.cancel();
    }
    return;
  }
  if (runButton.disabled || running) {
    return;
  }
  runInFlight = { phase: "verify" };
  setRunUiState(true);
  setPanel("run");
  runOutput.textContent = "";
  showRunOutcome("is-running", "Verifying before running", "dafny run verifies first", "Run: verifying");
  setResultIcon("busy");
  appendRunOutput("» dafny run — verify, compile to JavaScript, execute (all in this browser)\n» verifying…\n");

  try {
    const source = editor.state.doc.toString();
    const limitValue = Number(document.querySelector("#time-limit").value) || 0;
    const verification = await verify(source,
      { timeLimitSeconds: limitValue, counterexamples: true, readableNames: smtReadable.checked });
    showVerificationResult(verification);
    if (!verification.verified) {
      appendRunOutput("» verification failed — not running (see the Problems tab)\n");
      setPanel("problems");
      return;
    }
    appendRunOutput("» verified (" + verification.verifiedCount + " obligations) — compiling to JavaScript…\n");
    verificationStage.textContent = "Run: compiling";
    const compiled = await verifierReady.then(dafny => dafny.compileToJs(source));
    if (!compiled.ok) {
      showVerificationResult({ ...compiled, verified: false, verifiedCount: 0, smtExchangeCount: 0 });
      appendRunOutput("» compilation failed (see the Problems tab)\n");
      setPanel("problems");
      return;
    }
    showCompiledJs(compiled);
    if (!compiled.hasMain) {
      appendRunOutput("» no Main method — nothing to execute.\n» The program verified; add `method Main() { ... }` to run it.\n");
      showRunOutcome("is-idle", "Nothing to run", "Verified, but there is no Main method.", "Run: no Main");
      return;
    }
    appendRunOutput("» compiled to " + Math.round(compiled.js.length / 1024) + " KB of JavaScript — running Main…\n\n");
    showRunOutcome("is-running", "Running", "Executing the compiled JavaScript", "Run: executing");
    setResultIcon("busy");
    const timeoutMs = limitValue > 0 ? limitValue * 1000 : limitValue < 0 ? 0 : 30000;
    const bignumberSource = await loadBignumberSource();
    const startedAt = performance.now();
    let printedAnything = false;
    const execution = runCompiled({
      program: compiled.js,
      callToMain: compiled.callToMain,
      bignumberSource,
      timeoutMs,
      onOutput: text => {
        printedAnything = true;
        appendRunOutput(text);
      }
    });
    runInFlight = { phase: "execute", cancelExecute: execution.cancel };
    const result = await execution.done;
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(2);
    if (result.ok) {
      if (!printedAnything) {
        appendRunOutput("» Main printed nothing — the compiled program is under internals\n");
      }
      appendRunOutput("\n» program finished in " + seconds + "s\n");
      showRunOutcome("is-success", "Program finished",
        "Verified, compiled, and executed in " + seconds + "s.", "Run: finished");
    } else if (result.timedOut) {
      appendRunOutput("\n» terminated: still running after " + (timeoutMs / 1000) + "s (the time-limit selector bounds execution too)\n");
      showRunOutcome("is-error", "Program terminated",
        "Still running after " + (timeoutMs / 1000) + "s — stopped.", "Run: terminated");
    } else if (result.cancelled) {
      appendRunOutput("\n» stopped\n");
      showRunOutcome("is-idle", "Stopped", "Program execution was stopped.", "Run: stopped");
    } else if (result.error === undefined) {
      // A Dafny halt (`expect` failure): [Program halted] is already in the output.
      appendRunOutput("\n» program halted (exit code " + result.exitCode + ") after " + seconds + "s\n");
      showRunOutcome("is-error", "Program halted", "Main hit a halt — see the Run tab.", "Run: halted");
    } else {
      appendRunOutput("\n» runtime error:\n" + result.error + "\n");
      showRunOutcome("is-error", "Runtime error", "The compiled program threw — see the Run tab.", "Run: error");
    }
  } catch (error) {
    if (String(error?.message) === "cancelled") {
      appendRunOutput("\n» stopped during verification\n");
      showRunOutcome("is-idle", "Stopped", "Run aborted; the verifier is restarting.", "Run: stopped");
    } else {
      showRuntimeError(error);
    }
  } finally {
    runInFlight = null;
    setRunUiState(false);
  }
}

runButton.addEventListener("click", runProgram);

// "Copy runnable script": the JS tab displays the program with the runtime
// stripped for reading, so a raw copy-paste hits `_dafny is not defined`.
// This assembles the complete artifact — bignumber.js, the full compiled
// text (runtime included), the two node shims with stdout going to
// console.log — wrapped in an IIFE so it runs when pasted into any browser
// console or node. The require shim must return globalThis.BigNumber: the
// runtime's own `const BigNumber = require(...)` shares the IIFE scope, and
// returning the bare name would read that const inside its own
// initialization (a temporal-dead-zone error).
const jsCopyButton = document.querySelector("#js-copy-runnable");

async function buildRunnableScript() {
  const bignumberSource = await loadBignumberSource();
  return "// Compiled Dafny program — paste into any browser console (or node) to run it.\n" +
    "(() => {\n" +
    bignumberSource + "\n" +
    "let __out = \"\";\n" +
    "const process = {\n" +
    "  stdout: {\n" +
    "    write: text => {\n" +
    "      __out += String(text);\n" +
    "      let nl;\n" +
    "      while ((nl = __out.indexOf(\"\\n\")) >= 0) { console.log(__out.slice(0, nl)); __out = __out.slice(nl + 1); }\n" +
    "    },\n" +
    "    setEncoding: () => {}\n" +
    "  },\n" +
    "  argv: [\"node\", \"main.dfy\"],\n" +
    "  exitCode: 0\n" +
    "};\n" +
    "const require = name => {\n" +
    "  if (name === \"bignumber.js\") return globalThis.BigNumber;\n" +
    "  if (name === \"process\") return process;\n" +
    "  throw new Error(\"module not available: \" + name);\n" +
    "};\n" +
    lastCompiled.js + "\n" +
    (lastCompiled.callToMain || "") + "\n" +
    "if (__out) console.log(__out);\n" +
    "})();";
}

jsCopyButton.addEventListener("click", async () => {
  if (!lastCompiled) return;
  const script = await buildRunnableScript();
  window.__runnableJs = script;
  const copied = await copyText(script);
  flashLabel(jsCopyButton, copied ? "Copied" : "Copy failed");
});

// ---------- Share (permalinks) and Embed ----------
// Codec in src/share-codec.js — shared with the embeddable widget.

const CANONICAL_DEMO_URL = "https://rupnikj.github.io/dafny-verify-browser/";
const shareButton = document.querySelector("#share");
const embedButton = document.querySelector("#embed");
shareButton.disabled = false; // sharing needs only the editor, not the verifier
embedButton.disabled = false;

// From file:// (the single-file build) a local path is useless to a
// recipient — point shares at the hosted demo, which runs the same app.
function shareBaseUrl() {
  return /^https?:$/.test(window.location.protocol)
    ? new URL("./", window.location.href).href
    : CANONICAL_DEMO_URL;
}

async function loadSharedCode() {
  const fragment = shareFragmentFrom(window.location.hash);
  if (!fragment) return;
  try {
    const source = await decodeShareFragment(fragment);
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: source },
      selection: { anchor: 0 }
    });
    clearResultForEdit();
    modifiedDot.classList.remove("is-visible");
  } catch (error) {
    console.warn("could not load the shared program from the URL:", error);
  }
}

function flashLabel(button, text) {
  const label = button.querySelector(".menu-label");
  const original = label.textContent;
  label.textContent = text;
  setTimeout(() => { label.textContent = original; }, 1600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const holder = document.createElement("textarea");
      holder.value = text;
      holder.style.position = "fixed";
      holder.style.opacity = "0";
      document.body.append(holder);
      holder.select();
      const copied = document.execCommand("copy");
      holder.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

// "How it works" carries the current program to the anatomy page (from
// file:// the canonical hosted page — a local path helps nobody).
document.querySelector("#anatomy-link").addEventListener("click", async event => {
  event.preventDefault();
  const link = shareBaseUrl() + "anatomy.html#code=" +
    await encodeShareFragment(editor.state.doc.toString());
  window.open(link, "_blank", "noopener");
});

shareButton.addEventListener("click", async () => {
  const fragment = await encodeShareFragment(editor.state.doc.toString());
  const url = shareBaseUrl() + "#code=" + fragment;
  window.__shareUrl = url;
  const copied = await copyText(url);
  flashLabel(shareButton, copied ? "Link copied" : "Copy failed");
});

embedButton.addEventListener("click", async () => {
  const fragment = await encodeShareFragment(editor.state.doc.toString());
  const snippet = `<iframe src="${shareBaseUrl()}embed.html#code=${fragment}"\n` +
    `  style="width: 100%; height: 420px; border: 1px solid #30363d; border-radius: 8px"\n` +
    `  loading="lazy" title="Dafny Verify"></iframe>`;
  window.__embedSnippet = snippet;
  const copied = await copyText(snippet);
  flashLabel(embedButton, copied ? "Snippet copied" : "Copy failed");
});

loadSharedCode();

verifierReady.then(() => {
  runtimeDot.className = "status-dot is-ready";
  runtimeLabel.textContent = "Verifier ready";
  runtimeNote.hidden = true;
  loadProgress.hidden = true;
  verifyButton.disabled = false;
  runButton.disabled = false;
  output.textContent = "Dafny, Boogie, and Z3 WASM are ready.";
}).catch(error => {
  runtimeDot.className = "status-dot is-error";
  runtimeLabel.textContent = "Startup failed";
  runtimeState.title = error?.message ?? String(error);
  runtimeNote.hidden = true;
  loadProgress.hidden = true;
  verifyButton.disabled = true;
  runButton.disabled = true;
  showRuntimeError(error);
});
