using System.Text.Json;
using Microsoft.Boogie;
using Microsoft.Dafny;

const string abs = """
method Abs(x: int) returns (y: int)
  ensures y >= 0
{
  if x < 0 {
    y := -x;
  } else {
    y := x;
  }
}
""";

const string bad = """
method Bad(x: int) returns (y: int)
  ensures y > x
{
  y := x;
}
""";

Directory.CreateDirectory("logs");
Console.WriteLine(JsonSerializer.Serialize(await Verify("abs", abs)));
Console.WriteLine(JsonSerializer.Serialize(await Verify("bad", bad)));

static async Task<object> Verify(string name, string source) {
  var output = new StringWriter();
  var options = DafnyOptions.CreateUsingOldParser(output, TextReader.Null);
  options.VcsCores = 1;
  options.DafnyPrelude = Path.GetFullPath("../../upstream-dafny/Source/DafnyCore/DafnyPrelude.bpl");
  options.ProverOptions.Add("PROVER_PATH=/opt/homebrew/bin/z3");
  options.ProverLogFilePath = Path.GetFullPath($"logs/{name}.smt2");
  var reporter = new BatchErrorReporter(options);
  options.ProcessSolverOptions(reporter, Microsoft.Dafny.Token.NoToken);
  var printer = new DafnyConsolePrinter(options);
  options.Printer = printer;

  Microsoft.Dafny.Type.ResetScopes();
  var parseResult = await ProgramParser.Parse(source, new Uri($"memory:///{name}.dfy"), reporter);
  await new ProgramResolver(parseResult.Program).Resolve(CancellationToken.None);

  var verifiedCount = 0;
  var errorCount = reporter.ErrorCount;
  var allVerified = !reporter.HasErrors;
  using var engine = new ExecutionEngine(options, new EmptyVerificationResultCache(), TaskScheduler.Default);
  foreach (var (moduleName, boogieProgram) in BoogieGenerator.Translate(parseResult.Program, reporter)) {
    var (outcome, statistics) = await DafnyMain.BoogieOnce(
      reporter, options, output, engine, $"{name}.dfy", moduleName, boogieProgram, null);
    verifiedCount += statistics.VerifiedCount;
    errorCount += statistics.ErrorCount;
    allVerified &= DafnyMain.IsBoogieVerified(outcome, statistics);
  }

  var diagnostics = printer.VerificationResults
    .SelectMany(entry => entry.Result.Counterexamples.Select(counterexample => {
      var information = counterexample.CreateErrorInformation(entry.Result.Outcome, false);
      var token = BoogieGenerator.ToDafnyToken(information.Tok ?? counterexample.FailingAssert.tok);
      return new { severity = "error", message = information.FullMsg, line = token.line, column = token.col };
    })).ToArray();

  return new { name, verified = allVerified, verifiedCount, errorCount, diagnostics };
}
