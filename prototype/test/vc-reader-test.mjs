// Golden tests for the VC reader against a captured Abs verification
// condition (readable names). A display-layer bug here teaches wrong
// things, so the assertions are semantic, not cosmetic.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { readVc, formatVcReading, prettyName, simplify, parse, tokenize, print, breakFormula } from "../src/vc-reader.js";

// name prettification
assert.equal(prettyName("|y#0@1|"), "y₁");
assert.equal(prettyName("|x#0|"), "x");
assert.equal(prettyName("$_ModifiesFrame@0"), "$_ModifiesFrame₀");
assert.equal(prettyName("q#2@3"), "q#2₃");
assert.equal(prettyName("ControlFlow"), "ControlFlow");
assert.equal(prettyName("|year#0@@1|"), "year₁", "Boogie's @@ uniquifier folds");
assert.equal(prettyName("$generated@@94"), "$generated₉₄");
assert.equal(prettyName("_module.__default.Fibonacci#canCall"), "Fibonacci#canCall");
assert.equal(prettyName("T@U"), "T@U", "type names untouched");

// infix + precedence
assert.equal(print(parse(tokenize("(>= |y#0@1| (LitInt 0))"))[0]), "y₁ ≥ 0");
assert.equal(print(parse(tokenize("(- 0 |x#0|)"))[0]), "-x");
assert.equal(print(parse(tokenize("(=> (and a b) c)"))[0]), "a ∧ b ⟹ c");
assert.equal(print(parse(tokenize("(and (or a b) c)"))[0]), "(a ∨ b) ∧ c");

// prelude arithmetic wrappers are the infix operators they wrap
assert.equal(print(parse(tokenize("(Mod year 4)"))[0]), "year mod 4");
assert.equal(print(parse(tokenize("(Mul n (Mul n n))"))[0]), "n · (n · n)");

// polymorphic map select/store render as indexing, type arguments dropped
assert.equal(print(parse(tokenize("(MapType0Select A B (MapType0Select C D $Heap o) alloc)"))[0]),
  "$Heap[o][alloc]");
assert.equal(print(parse(tokenize("(MapType1Select A B C frame o f)"))[0]), "frame[o, f]");
assert.equal(print(parse(tokenize("(MapType0Store A B m k v)"))[0]), "m[k := v]");
assert.equal(print(parse(tokenize("($Unbox intType x)"))[0]), "$Unbox(x)");

// Lit markers and round-trip box coercions are display-collapsed
assert.equal(print(simplify(parse(tokenize("(U_2_bool (Lit boolType (bool_2_U (< 10 2))))"))[0])),
  "10 < 2");
assert.equal(print(simplify(parse(tokenize("(int_2_U (U_2_int x))"))[0])), "x");
assert.equal(print(simplify(parse(tokenize("(U_2_int y)"))[0])), "U_2_int(y)",
  "one-sided coercions stay");

// long formulas break at top-level connectives; short ones stay inline
assert.equal(breakFormula("a ∧ b", "", 100), "a ∧ b");
const broken = breakFormula(
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ⟹ (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ∧ cccccccccccccccccccccccccccccccccc)",
  "", 60);
assert.ok(broken.includes("\n⟹ "), "breaks at the implication: " + JSON.stringify(broken));
assert.ok(broken.split("\n").every(line => line.length <= 60 || !line.includes(" ⟹ ")),
  "no over-wide line still holds a joint");
const quantified = breakFormula(
  "∀ o: T@U · aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ∧ bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "", 60);
assert.ok(quantified.startsWith("∀ o: T@U ·\n  "), "quantifier head on its own line: " + JSON.stringify(quantified));

// ControlFlow elimination
const simplified = simplify(parse(tokenize("(=> (= (ControlFlow 0 0) 5) (and p (= (ControlFlow 0 2) 1)))"))[0]);
assert.equal(print(simplified), "p");

// the captured Abs VC end-to-end
const vc = readFileSync(new URL("./fixtures/abs-vc-readable.smt2", import.meta.url), "utf8");
const reading = readVc(vc);
assert.ok(reading, "reader produced a result");
const names = reading.definitions.map(d => d.name);
assert.ok(names.some(n => n.includes("anon0")), "entry block present: " + names);
assert.ok(names.some(n => n.includes("Then")), "then-branch present");
assert.ok(names.some(n => n.includes("Else")), "else-branch present");
const text = formatVcReading(reading);
assert.ok(!reading.final.includes("ControlFlow") &&
  reading.definitions.every(d => !d.text.includes("ControlFlow")) &&
  !(reading.inlined ?? "").includes("ControlFlow"),
  "ControlFlow eliminated from the formula content");
assert.ok(reading.eliminatedControlFlow > 0, "elimination counted");
assert.ok(text.includes("y₁ ≥ 0"), "postcondition readable: " + text.slice(0, 400));
assert.ok(text.includes("⟹"), "implications infix");
assert.ok(reading.inlined && reading.inlined.includes("x < 0"), "then-guard survives inlining");

console.log("vc-reader: ok");
console.log("---- Abs, rendered ----");
console.log(text);
