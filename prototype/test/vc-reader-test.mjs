// Golden tests for the VC reader against a captured Abs verification
// condition (readable names). A display-layer bug here teaches wrong
// things, so the assertions are semantic, not cosmetic.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { readVc, formatVcReading, prettyName, simplify, parse, tokenize, print } from "../src/vc-reader.js";

// name prettification
assert.equal(prettyName("|y#0@1|"), "y₁");
assert.equal(prettyName("|x#0|"), "x");
assert.equal(prettyName("$_ModifiesFrame@0"), "$_ModifiesFrame₀");
assert.equal(prettyName("q#2@3"), "q#2₃");
assert.equal(prettyName("ControlFlow"), "ControlFlow");

// infix + precedence
assert.equal(print(parse(tokenize("(>= |y#0@1| (LitInt 0))"))[0]), "y₁ ≥ 0");
assert.equal(print(parse(tokenize("(- 0 |x#0|)"))[0]), "-x");
assert.equal(print(parse(tokenize("(=> (and a b) c)"))[0]), "a ∧ b ⟹ c");
assert.equal(print(parse(tokenize("(and (or a b) c)"))[0]), "(a ∨ b) ∧ c");

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
