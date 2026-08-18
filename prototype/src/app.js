import { EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
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
import { tags } from "@lezer/highlight";
import { createDafny } from "./dafny-browser.js";

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

const dafnyHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#d98cff", fontWeight: "600" },
  { tag: [tags.typeName, tags.className], color: "#55d6be" },
  { tag: tags.definition(tags.variableName), color: "#7fc4ff" },
  { tag: tags.variableName, color: "#cdd6e0" },
  { tag: [tags.bool, tags.null], color: "#f0a96b" },
  { tag: tags.number, color: "#b7dc8b" },
  { tag: tags.string, color: "#d5bd79" },
  { tag: tags.comment, color: "#687687", fontStyle: "italic" },
  { tag: tags.meta, color: "#e6a75a" },
  { tag: tags.operator, color: "#8dc9ff" },
  { tag: tags.punctuation, color: "#9ca8b7" }
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "#d8dee9",
    backgroundColor: "#151a21"
  },
  ".cm-content": {
    padding: "14px 0 60px",
    caretColor: "#72bdff",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "13px",
    lineHeight: "1.58"
  },
  ".cm-line": {
    padding: "0 12px 0 8px"
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "#72bdff"
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "#234b6f !important"
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(255, 255, 255, .027)"
  },
  ".cm-gutters": {
    color: "#5e6978",
    backgroundColor: "#151a21",
    border: "none",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "12px"
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "38px",
    padding: "0 8px 0 6px"
  },
  ".cm-activeLineGutter": {
    color: "#bbc5d0",
    backgroundColor: "rgba(255, 255, 255, .027)"
  },
  ".cm-panels": {
    color: "#d8dee9",
    backgroundColor: "#1d2430"
  },
  ".cm-search": {
    borderTop: "1px solid #303946 !important"
  },
  ".cm-search input, .cm-search button, .cm-search label": {
    color: "#d8dee9"
  },
  ".cm-search input": {
    backgroundColor: "#11151b",
    border: "1px solid #3b4655"
  },
  ".cm-tooltip": {
    color: "#d8dee9",
    backgroundColor: "#242c38",
    border: "1px solid #465263"
  }
}, { dark: true });

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
  const isLiteral = text => /^(-?[\d][\w.]*|true|false|null|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(text);
  const seen = new Set();
  const cleaned = [];
  for (const part of parts) {
    let text = part.trim();
    // Dafny synthesises ghost guards to describe loop iterations; the
    // assignments are bookkeeping, and implications just scope a fact to
    // "after some loop iterations" — show the fact itself.
    if (/^counterexampleLoopGuard\d+\s*:=/.test(text)) continue;
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
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][\w']*|-?\d[\w.]*|<==>|==>|<==|::|==|!=|<=|>=|&&|\|\||[-+*\/%<>=!&|^~?:.,()\[\]{}]|\s+/g) ?? [text];
  for (const token of tokens) {
    const span = document.createElement("span");
    span.textContent = token;
    if (/^["']/.test(token)) span.className = "cex-tok-string";
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
const exampleSelect = document.querySelector("#example");
const modifiedDot = document.querySelector("#modified-dot");
const problemsTab = document.querySelector("#problems-tab");
const outputTab = document.querySelector("#output-tab");
const problemsView = document.querySelector("#problems-view");
const outputView = document.querySelector("#output-view");
const output = document.querySelector("#output");
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
    dafnyInstance?.whenReady().then(() => {
      runtimeDot.className = "status-dot is-ready";
      runtimeLabel.textContent = "Verifier ready";
      verifyButton.disabled = false;
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
window.dafny = { parse, verify, getLastSmtTranscript };

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
  resultIcon.textContent = "◇";
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
      editorTheme,
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
        }
      })
    ]
  })
});
updateCursor(editor);

function setPanel(panel) {
  const showProblems = panel === "problems";
  problemsTab.classList.toggle("is-active", showProblems);
  problemsTab.setAttribute("aria-selected", String(showProblems));
  outputTab.classList.toggle("is-active", !showProblems);
  outputTab.setAttribute("aria-selected", String(!showProblems));
  problemsView.hidden = !showProblems;
  outputView.hidden = showProblems;
}

problemsTab.addEventListener("click", () => setPanel("problems"));
outputTab.addEventListener("click", () => setPanel("output"));

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
  modifiedDot.classList.remove("is-visible");
  verificationStage.textContent = result.stage + " • " + result.smtExchangeCount + " SMT exchanges";

  if (result.verified) {
    resultSummary.className = "result-summary is-success";
    resultIcon.textContent = "✓";
    resultTitle.textContent = "Verification succeeded";
    resultDetail.textContent = result.verifiedCount + " verified • " +
      result.smtExchangeCount + " SMT exchanges";
  } else {
    resultSummary.className = "result-summary is-error";
    resultIcon.textContent = "×";
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
  resultIcon.textContent = "×";
  resultTitle.textContent = "Verifier error";
  resultDetail.textContent = "See Output for details.";
  verificationStage.textContent = "Runtime error";
}

async function runVerification() {
  if (running) {
    dafnyInstance?.cancel();
    return;
  }
  if (verifyButton.disabled) {
    return;
  }
  setRunningState(true);
  setPanel("problems");
  currentDiagnostics = [];
  suppressEmptyState = true;
  editor.dispatch({ effects: setDiagnosticsEffect.of([]) });
  renderProblems();
  resultSummary.className = "result-summary is-running";
  resultIcon.textContent = "…";
  resultTitle.textContent = "Verifying";
  resultDetail.textContent = "Dafny → Boogie → Z3 WASM";
  verificationStage.textContent = "Verification running";
  output.textContent = "Verifying with Dafny, Boogie, and Z3 WASM…";

  try {
    const timeLimitSeconds = Number(document.querySelector("#time-limit").value) || 0;
    showVerificationResult(await verify(editor.state.doc.toString(),
      { timeLimitSeconds, counterexamples: true }));
  } catch (error) {
    if (String(error?.message) === "cancelled") {
      resultSummary.className = "result-summary is-idle";
      resultIcon.textContent = "◇";
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

verifyButton.addEventListener("click", runVerification);

exampleSelect.addEventListener("change", () => {
  const source = examples[exampleSelect.value] ?? examples.abs;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: source },
    selection: { anchor: 0 },
    effects: EditorView.scrollIntoView(0, { y: "start" })
  });
  editor.focus();
});

verifierReady.then(() => {
  runtimeDot.className = "status-dot is-ready";
  runtimeLabel.textContent = "Verifier ready";
  runtimeNote.hidden = true;
  loadProgress.hidden = true;
  verifyButton.disabled = false;
  output.textContent = "Dafny, Boogie, and Z3 WASM are ready.";
}).catch(error => {
  runtimeDot.className = "status-dot is-error";
  runtimeLabel.textContent = "Startup failed";
  runtimeState.title = error?.message ?? String(error);
  runtimeNote.hidden = true;
  loadProgress.hidden = true;
  verifyButton.disabled = true;
  showRuntimeError(error);
});
