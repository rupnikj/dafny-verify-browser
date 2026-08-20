// Shared CodeMirror pieces for every page that displays pipeline text:
// the Dafny, Boogie, and SMT-LIB stream modes, the token-driven highlight
// style, and the token-driven editor chrome. Colors come from the --syn-*
// and --ed-* CSS custom properties, so views follow the page theme; only
// CodeMirror's dark flag is baked per instance.
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

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

export { dafnyLanguage, boogieLanguage, smtLanguage, dafnyHighlight, makeEditorTheme };

/** A read-only themed code view (used by the anatomy page). */
export function createReadOnlyView(parent, language, doc) {
  const dark = document.documentElement.dataset.theme !== "light";
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        drawSelection(),
        bracketMatching(),
        language,
        syntaxHighlighting(dafnyHighlight),
        makeEditorTheme(dark),
        EditorState.readOnly.of(true)
      ]
    })
  });
}
