// Golden tests for the VC reader against a captured Abs verification
// condition (readable names). A display-layer bug here teaches wrong
// things, so the assertions are semantic, not cosmetic.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { readVc, formatVcReading, prettyName, simplify, parse, tokenize, print, breakFormula, vcSkeleton, pathSimplified } from "../src/vc-reader.js";

// name prettification
assert.equal(prettyName("|y#0@1|"), "y₁");
assert.equal(prettyName("|x#0|"), "x");
assert.equal(prettyName("$_ModifiesFrame@0"), "$_ModifiesFrame₀");
assert.equal(prettyName("q#2@3"), "q#2₃");
assert.equal(prettyName("ControlFlow"), "ControlFlow");
assert.equal(prettyName("|year#0@@1|"), "year″", "@@ freshening gets primes, not versions");
assert.equal(prettyName("i#3@@0"), "i#3′");
assert.equal(prettyName("$o@@2"), "$o‴");
assert.equal(prettyName("$generated@@94"), "$generated₉₄", "normalized symbol indices stay subscripts");
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

// polymorphic map select/store render as indexing, type arguments dropped,
// IndexField wrappers reduce in index position
assert.equal(print(parse(tokenize("(MapType0Select A B (MapType0Select C D $Heap o) alloc)"))[0]),
  "$Heap[o][alloc]");
assert.equal(print(parse(tokenize("(MapType0Select A B (MapType0Select C D $Heap a) (IndexField i))"))[0]),
  "$Heap[a][i]");
assert.equal(print(parse(tokenize("(MapType1Select A B C frame o f)"))[0]), "frame[o, f]");
assert.equal(print(parse(tokenize("(MapType0Store A B m k v)"))[0]), "m[k := v]");

// Lit markers and ALL boxing collapse (type-correct by construction)
assert.equal(print(simplify(parse(tokenize("(U_2_bool (Lit boolType (bool_2_U (< 10 2))))"))[0])),
  "10 < 2");
assert.equal(print(simplify(parse(tokenize("(int_2_U (U_2_int x))"))[0])), "x");
assert.equal(print(simplify(parse(tokenize("(U_2_int y)"))[0])), "y");
assert.equal(print(simplify(parse(tokenize("($Unbox intType x)"))[0])), "x");
assert.equal(print(simplify(parse(tokenize("(U_2_int ($Unbox intType (MapType0Select A B (MapType0Select C D $Heap a) (IndexField i))))"))[0])),
  "$Heap[a][i]", "the full array-read chain collapses to heap indexing");

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

// the skeleton: story first — given/assume in chain order, then the goal
const skeleton = vcSkeleton(reading);
assert.ok(skeleton.includes("given:"), "skeleton has given rows: " + skeleton);
assert.ok(skeleton.includes("assume:"), "skeleton has assume rows");
assert.ok(skeleton.includes("prove:"), "skeleton has the goal");
assert.ok(skeleton.indexOf("given:") < skeleton.indexOf("prove:"), "hypotheses precede the goal");

// pass 2 is labeled, and on Abs (no loop, no discharged guards) stays close
// to the faithful form
const simplifiedText = pathSimplified(reading);
assert.ok(simplifiedText.includes("NOT the raw verification condition"), "pass 2 is labeled");
assert.ok(simplifiedText.includes("y₁ ≥ 0"), "the goal survives pass 2: " + simplifiedText);

console.log("vc-reader: ok");
console.log("---- Abs, rendered ----");
console.log(text);
console.log("---- Abs, skeleton ----");
console.log(skeleton);
console.log("---- Abs, path-simplified ----");
console.log(simplifiedText);
