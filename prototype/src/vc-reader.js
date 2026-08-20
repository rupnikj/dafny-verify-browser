// Renders a Boogie/Dafny verification condition into readable form:
// prefix -> infix, Dafny name conventions prettified (x#0@1 -> x₁),
// ControlFlow path labels eliminated (content-free scaffolding: they number
// the control-flow graph so a counterexample model can report its path),
// and the let-bound basic blocks presented as a definitions table plus a
// guarded full inlining. Everything else — including heap hypotheses — is
// kept: the output is a faithful view of the formula modulo notation.

// ---------- s-expression parsing ----------

export function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "(" || ch === ")") { tokens.push(ch); i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === ";") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "|") {
      let j = text.indexOf("|", i + 1);
      if (j < 0) j = text.length;
      tokens.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j++;
      tokens.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s()|;"]/.test(text[j])) j++;
    tokens.push(text.slice(i, j));
    i = j;
  }
  return tokens;
}

export function parse(tokens) {
  let position = 0;
  function node() {
    const token = tokens[position++];
    if (token !== "(") return token;
    const children = [];
    while (position < tokens.length && tokens[position] !== ")") children.push(node());
    position++; // ")"
    return children;
  }
  const roots = [];
  while (position < tokens.length) roots.push(node());
  return roots;
}

// ---------- pretty names ----------

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
const subscript = digits => [...digits].map(d => SUBSCRIPTS[Number(d)] ?? d).join("");

export function prettyName(raw) {
  let name = raw.startsWith("|") && raw.endsWith("|") ? raw.slice(1, -1) : raw;
  // Boogie's uniquifier doubles the @; fold it into the same version idea.
  name = name.replace(/@@/g, "@");
  // The default module's qualifier carries no information.
  if (name.startsWith("_module.__default.")) name = name.slice("_module.__default.".length);
  // Dafny convention: name#k is the k-th distinct variable of that name
  // (#0 is the common case and drops), @v is the SSA version.
  const match = name.match(/^(.*?)(#(\d+))?(@(\d+))?$/);
  if (match && (match[2] || match[4])) {
    const base = match[1];
    const hash = match[3];
    const version = match[5];
    if (base.length > 0) {
      name = base + (hash && hash !== "0" ? "#" + hash : "") +
        (version !== undefined ? subscript(version) : "");
    }
  }
  return name;
}

// ---------- ControlFlow elimination + boolean simplification ----------

const isControlFlowLabel = node =>
  Array.isArray(node) && node[0] === "=" &&
  node.slice(1).some(argument => Array.isArray(argument) && argument[0] === "ControlFlow");

export function simplify(node, counter = { eliminated: 0 }) {
  if (!Array.isArray(node)) return node;
  if (isControlFlowLabel(node)) {
    counter.eliminated++;
    return "true";
  }
  node = node.map(child => simplify(child, counter));
  const [head, ...rest] = node;
  if (head === "and") {
    const kept = rest.filter(argument => argument !== "true");
    if (kept.length === 0) return "true";
    if (kept.includes("false")) return "false";
    if (kept.length === 1) return kept[0];
    return ["and", ...kept];
  }
  if (head === "or") {
    const kept = rest.filter(argument => argument !== "false");
    if (kept.length === 0) return "false";
    if (kept.includes("true")) return "true";
    if (kept.length === 1) return kept[0];
    return ["or", ...kept];
  }
  if (head === "=>") {
    // (=> a b c) is a => (b => c); drop true hypotheses, collapse true bodies.
    const body = rest[rest.length - 1];
    const hypotheses = rest.slice(0, -1).filter(h => h !== "true");
    if (body === "true") return "true";
    if (hypotheses.length === 0) return body;
    return ["=>", ...hypotheses, body];
  }
  if (head === "not") {
    if (rest[0] === "true") return "false";
    if (rest[0] === "false") return "true";
  }
  if (head === "!" ) {
    // annotation node: if the body simplified to a constant, drop the wrapper
    if (!Array.isArray(rest[0])) return rest[0];
  }
  // Literal markers (Lit exists only to steer triggering) and round-trip
  // box coercions are notation, not content.
  if ((head === "LitInt" || head === "LitReal") && rest.length === 1) return rest[0];
  if (head === "Lit" && rest.length >= 1) return rest[rest.length - 1];
  const inverse = COERCION_INVERSE[head];
  if (inverse && Array.isArray(rest[0]) && rest[0][0] === inverse) return rest[0][1];
  return node;
}

const COERCION_INVERSE = {
  U_2_bool: "bool_2_U", bool_2_U: "U_2_bool",
  U_2_int: "int_2_U", int_2_U: "U_2_int",
  U_2_real: "real_2_U", real_2_U: "U_2_real"
};

// ---------- infix printing ----------

const OPERATORS = {
  "<==>": { symbol: "⟺", precedence: 1 },
  "=>": { symbol: "⟹", precedence: 1, rightAssociative: true },
  "or": { symbol: "∨", precedence: 2 },
  "and": { symbol: "∧", precedence: 3 },
  "=": { symbol: "=", precedence: 4 },
  "distinct": { symbol: "≠", precedence: 4 },
  "<": { symbol: "<", precedence: 4 },
  "<=": { symbol: "≤", precedence: 4 },
  ">": { symbol: ">", precedence: 4 },
  ">=": { symbol: "≥", precedence: 4 },
  "+": { symbol: "+", precedence: 5 },
  "-": { symbol: "-", precedence: 5 },
  "*": { symbol: "·", precedence: 6 },
  "div": { symbol: "div", precedence: 6 },
  "mod": { symbol: "mod", precedence: 6 },
  // Dafny's prelude wraps nonlinear arithmetic in named functions; users
  // can't collide with the bare names (their functions are module-qualified).
  "Mul": { symbol: "·", precedence: 6 },
  "Div": { symbol: "div", precedence: 6 },
  "Mod": { symbol: "mod", precedence: 6 }
};

export function print(node, contextPrecedence = 0) {
  if (!Array.isArray(node)) return prettyName(node);
  const [head, ...rest] = node;

  if ((head === "LitInt" || head === "LitReal") && rest.length === 1) {
    return print(rest[0], contextPrecedence);
  }
  if (head === "-" && rest.length === 2 && rest[0] === "0") {
    return "-" + print(rest[1], 7);
  }
  if (head === "-" && rest.length === 1) {
    return "-" + print(rest[0], 7);
  }
  if (head === "not") {
    return "¬" + print(rest[0], 7);
  }
  if (head === "ite") {
    return "(if " + print(rest[0], 0) + " then " + print(rest[1], 0) +
      " else " + print(rest[2], 0) + ")";
  }
  if (head === "forall" || head === "exists" || head === "lambda") {
    const quantifier = head === "forall" ? "∀" : head === "exists" ? "∃" : "λ";
    const variables = (rest[0] ?? [])
      .map(pair => Array.isArray(pair) ? prettyName(pair[0]) + ": " + print(pair[1], 0) : print(pair, 0))
      .join(", ");
    const body = print(rest[rest.length - 1], 0);
    const text = quantifier + " " + variables + " · " + body;
    return contextPrecedence > 0 ? "(" + text + ")" : text;
  }
  if (head === "!") {
    // annotation: render the body; surface :pattern compactly, drop :weight etc.
    const body = print(rest[0], contextPrecedence);
    const patterns = [];
    for (let i = 1; i < rest.length - 1; i++) {
      if (rest[i] === ":pattern") patterns.push(print(rest[i + 1], 0));
    }
    return patterns.length > 0 ? body + " ⟨pattern " + patterns.join(", ") + "⟩" : body;
  }
  if (head === "let") {
    const bindings = (rest[0] ?? [])
      .map(pair => prettyName(pair[0]) + " = " + print(pair[1], 0)).join(", ");
    return "(let " + bindings + " in " + print(rest[1], 0) + ")";
  }
  // Boogie's polymorphic maps (the heap is one): MapTypeNSelect takes N+2
  // type arguments, the map, and N+1 keys — render as indexing. Same for
  // Store, and drop $Unbox's type argument.
  if (typeof head === "string") {
    const select = head.match(/^MapType(\d+)Select$/);
    if (select && rest.length === 2 * Number(select[1]) + 4) {
      const arity = Number(select[1]) + 1;
      const map = rest[rest.length - arity - 1];
      const keys = rest.slice(rest.length - arity);
      return print(map, 7) + "[" + keys.map(key => print(key, 0)).join(", ") + "]";
    }
    const store = head.match(/^MapType(\d+)Store$/);
    if (store && rest.length === 2 * Number(store[1]) + 5) {
      const arity = Number(store[1]) + 1;
      const map = rest[rest.length - arity - 2];
      const keys = rest.slice(rest.length - arity - 1, -1);
      return print(map, 7) + "[" + keys.map(key => print(key, 0)).join(", ") +
        " := " + print(rest[rest.length - 1], 0) + "]";
    }
    if (head === "$Unbox" && rest.length === 2) {
      return "$Unbox(" + print(rest[1], 0) + ")";
    }
  }
  const operator = OPERATORS[head];
  if (operator && rest.length >= 2) {
    const parts = rest.map((argument, index) => {
      const bump = operator.rightAssociative ? (index === rest.length - 1 ? 0 : 1) : (index === 0 ? 0 : 1);
      return print(argument, operator.precedence + bump);
    });
    const text = parts.join(" " + operator.symbol + " ");
    return contextPrecedence > operator.precedence ? "(" + text + ")" : text;
  }
  // plain application
  if (typeof head === "string") {
    return prettyName(head) + "(" + rest.map(argument => print(argument, 0)).join(", ") + ")";
  }
  return "(" + node.map(child => print(child, 0)).join(" ") + ")";
}

// ---------- the verification-condition reader ----------

function collectLets(node, bindings) {
  while (Array.isArray(node) && node[0] === "let") {
    for (const [name, value] of node[1]) bindings.push({ name, value });
    node = node[2];
  }
  return node;
}

function substitute(node, replacements) {
  if (!Array.isArray(node)) return replacements.get(node) ?? node;
  return node.map(child => substitute(child, replacements));
}

function countUses(node, name, limit = 3) {
  if (!Array.isArray(node)) return node === name ? 1 : 0;
  let count = 0;
  for (const child of node) {
    count += countUses(child, name, limit);
    if (count >= limit) return count;
  }
  return count;
}

const INLINE_LIMIT = 24000;

/** @param vcExchangeText the raw SMT text of the obligation's VC transmission */
export function readVc(vcExchangeText) {
  const goalStart = vcExchangeText.lastIndexOf("(assert (not");
  if (goalStart < 0) return null;
  const roots = parse(tokenize(vcExchangeText.slice(goalStart)));
  const assertNode = roots[0];
  if (!Array.isArray(assertNode) || assertNode[0] !== "assert") return null;

  const counter = { eliminated: 0 };
  const body = simplify(assertNode[1][1], counter); // inside (assert (not …))

  const bindings = [];
  const finalNode = collectLets(body, bindings);

  const definitions = bindings.map(({ name, value }) => ({
    name: prettyName(name),
    text: print(value, 0)
  }));

  // Guarded inlining: substitute bindings (in order — later ones may use
  // earlier ones), skipping any binding that is both large and used more
  // than once; give up entirely past the size cap.
  const replacements = new Map();
  let fullyInlined = true;
  for (const { name, value } of bindings) {
    const resolved = substitute(value, replacements);
    const size = print(resolved, 0).length;
    const uses = countUses(finalNode, name) +
      bindings.reduce((total, other) => total + (other.name === name ? 0 : countUses(other.value, name)), 0);
    if (size > 120 && uses > 1) {
      fullyInlined = false;
      continue;
    }
    replacements.set(name, resolved);
  }
  let inlined = null;
  const inlinedNode = simplify(substitute(finalNode, replacements));
  const inlinedText = print(inlinedNode, 0);
  if (inlinedText.length <= INLINE_LIMIT) {
    inlined = inlinedText;
  } else {
    fullyInlined = false;
  }

  return {
    definitions,
    final: print(finalNode, 0),
    inlined,
    fullyInlined,
    eliminatedControlFlow: counter.eliminated
  };
}

// ---------- layout: break wide formulas at their logical joints ----------

const BREAK_SEPARATORS = [" ⟺ ", " ⟹ ", " ∨ ", " ∧ "];

function topLevelSplit(text, separator) {
  const pieces = [];
  let depth = 0, start = 0, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === separator[0] && text.startsWith(separator, i)) {
      pieces.push(text.slice(start, i));
      i += separator.length;
      start = i;
      continue;
    }
    i++;
  }
  pieces.push(text.slice(start));
  return pieces;
}

/** One printed formula, broken at top-level connectives while it exceeds
 * the width; operands that offer no joint stand as long lines. */
export function breakFormula(text, indent = "", width = 100) {
  if (indent.length + text.length <= width) return indent + text;
  // A fully enclosing paren group: break the inside, keep the parens glued.
  if (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0, enclosing = true;
    for (let i = 0; i < text.length - 1 && enclosing; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") { depth--; if (depth === 0) enclosing = false; }
    }
    if (enclosing) {
      const inner = breakFormula(text.slice(1, -1), indent + " ", width);
      return indent + "(" + inner.slice(indent.length + 1) + ")";
    }
  }
  // A quantifier: variables on the first line, body indented below the dot.
  if (/^[∀∃λ] /.test(text)) {
    const dot = topLevelSplit(text, " · ");
    if (dot.length > 1) {
      return indent + dot[0] + " ·\n" +
        breakFormula(dot.slice(1).join(" · "), indent + "  ", width);
    }
  }
  for (const separator of BREAK_SEPARATORS) {
    const pieces = topLevelSplit(text, separator);
    if (pieces.length < 2) continue;
    const symbol = separator.trim() + " ";
    return pieces.map((piece, index) => {
      if (index === 0) return breakFormula(piece, indent, width);
      const branch = breakFormula(piece, indent + " ".repeat(symbol.length), width);
      return indent + symbol + branch.slice(indent.length + symbol.length);
    }).join("\n");
  }
  return indent + text;
}

/** The display text for a code pane: notes, definitions table, inlined form. */
export function formatVcReading(reading, { normalized = false } = {}) {
  if (!reading) return ";; no goal found in this exchange";
  const lines = [];
  lines.push(";; the query asserts ¬F and asks for a model; unsat means F holds on every execution");
  lines.push(";; notation only: prefix → infix, x#0@1 → x₁, map reads as m[k], Lit/box wrappers collapsed;");
  lines.push(";; " + reading.eliminatedControlFlow + " ControlFlow path labels elided " +
    "(they number the control-flow graph so a counterexample can report its path)");
  if (normalized) {
    lines.push(";; tip: enable 'readable names' to see source-level identifiers here");
  }
  lines.push("");
  if (reading.definitions.length > 0) {
    lines.push(";; F, by named blocks (each let names one basic block; read bottom-up):");
    const width = Math.min(28, Math.max(...reading.definitions.map(d => d.name.length)));
    for (const definition of reading.definitions) {
      const row = definition.name.padEnd(width) + " := " + definition.text;
      if (row.length <= 110) {
        lines.push(row);
      } else {
        lines.push(definition.name + " :=");
        lines.push(breakFormula(definition.text, "  "));
      }
    }
    lines.push("");
    lines.push(";; F = " + reading.final);
  }
  if (reading.inlined && reading.definitions.length > 0) {
    lines.push("");
    lines.push(reading.fullyInlined
      ? ";; F with every name substituted:"
      : ";; F partially substituted (large shared blocks kept by name):");
    lines.push(breakFormula(reading.inlined));
  } else if (reading.definitions.length === 0) {
    lines.push(";; F = " + reading.final);
  }
  return lines.join("\n");
}
