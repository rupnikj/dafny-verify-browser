// Reports which assemblies the runtime actually loads after exercising the
// verification pipeline with feature-diverse programs. Drives the inline
// artifact's assembly trimming (tools/make-dafny-artifact.mjs).
import { writeFile } from "node:fs/promises";
import { dotnet } from "../dist/wwwroot/_framework/dotnet.js";
import { init } from "z3-solver";

const programs = [
  "method Abs(x: int) returns (y: int)\n  ensures y >= 0\n{ if x < 0 { y := -x; } else { y := x; } }",
  "method Bad(x: int) returns (y: int)\n  ensures y > x\n{ y := x; }",
  // Feature sweep: datatypes, functions, lemmas, induction, seq/set/map/string,
  // reals, bitvectors, quantifiers, arrays, classes, loops.
  `
datatype Tree = Leaf | Node(left: Tree, value: int, right: Tree)

function Size(t: Tree): nat {
  match t case Leaf => 0 case Node(l, _, r) => Size(l) + Size(r) + 1
}

lemma {:induction false} SizeNonNegative(t: Tree)
  ensures Size(t) >= 0
{
  match t
  case Leaf =>
  case Node(l, _, r) => SizeNonNegative(l); SizeNonNegative(r);
}

function SumSeq(s: seq<int>): int {
  if |s| == 0 then 0 else s[0] + SumSeq(s[1..])
}

method Features(a: array<int>) returns (total: int)
  requires a.Length > 0
{
  var s: seq<int> := a[..];
  var st: set<int> := {1, 2, 3};
  var m: map<string, real> := map["pi" := 3.14];
  var bv: bv8 := 0xFF;
  var text := "hello" + " " + "world";
  total := |s| + |st| + |m| + |text| + (bv as int);
  var i := 0;
  while i < a.Length
    invariant 0 <= i <= a.Length
  {
    i := i + 1;
  }
}

class Counter {
  var count: int
  constructor() ensures count == 0 { count := 0; }
  method Increment() modifies this ensures count == old(count) + 1 { count := count + 1; }
}
`
];

const contexts = new Map();
const z3 = await init();
const runtime = await dotnet.create();
runtime.setModuleImports("dafnyZ3", {
  evaluate: async (solverId, smtLib) => {
    let context = contexts.get(solverId);
    if (!context) {
      const config = z3.Z3.mk_config();
      context = z3.Z3.mk_context_rc(config);
      z3.Z3.del_config(config);
      contexts.set(solverId, context);
    }
    return z3.Z3.eval_smtlib2_string(context, smtLib);
  },
  close: solverId => {
    const context = contexts.get(solverId);
    if (context) {
      z3.Z3.del_context(context);
      contexts.delete(solverId);
    }
  }
});
const config = runtime.getConfig();
await runtime.runMain(config.mainAssemblyName, []);
const exports = await runtime.getAssemblyExports(config.mainAssemblyName);

for (const source of programs) {
  const result = JSON.parse(await exports.DafnyBrowser.BrowserApi.Verify(source));
  console.log(`verified=${result.verified} errors=${result.errorCount} stage=${result.stage}`);
}

const loaded = JSON.parse(exports.DafnyBrowser.BrowserApi.GetLoadedAssemblies());
console.log(`loaded assemblies: ${loaded.length}`);
await writeFile(new URL("./loaded-assemblies.json", import.meta.url),
  JSON.stringify(loaded, null, 2) + "\n");
console.log("written to test/loaded-assemblies.json");
process.exit(0);
