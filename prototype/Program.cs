using System.Runtime.InteropServices.JavaScript;
using System.Reflection;
using System.Text.Json;
using Microsoft.Boogie;
using Microsoft.Dafny;

namespace DafnyBrowser;

public static partial class BrowserApi {
  // Dafny's frontend contains static mutable state. A single worker may receive
  // overlapping messages, so serialize all calls into the pipeline.
  private static readonly SemaphoreSlim PipelineLock = new(1, 1);
  private static IReadOnlyList<SmtTranscriptEntry> lastSmtTranscript = [];

  [JSExport]
  public static async Task<string> Parse(string source) {
    await PipelineLock.WaitAsync();
    try {
      var (options, reporter, _) = CreatePipeline();
      var (_, stage) = await ParseAndResolve(source, options, reporter);
      return JsonSerializer.Serialize(new ParseResult(
        !reporter.HasErrors,
        stage,
        reporter.ErrorCount,
        ReporterDiagnostics(reporter).ToArray()
      ), JsonOptions);
    } catch (Exception exception) {
      return JsonSerializer.Serialize(ParseException(exception), JsonOptions);
    } finally {
      PipelineLock.Release();
    }
  }

  [JSExport]
  public static async Task<string> Verify(string source) {
    await PipelineLock.WaitAsync();
    var transcript = new SmtTranscriptRecorder();
    try {
      var (options, reporter, printer) = CreatePipeline();
      options.CreateSolver = (_, _) => new BrowserSmtSolver(transcript);

      var (dafnyProgram, stage) = await ParseAndResolve(source, options, reporter);
      if (dafnyProgram == null || reporter.HasErrors) {
        return VerificationJson(false, 0, reporter.ErrorCount,
          ReporterDiagnostics(reporter), stage, transcript);
      }

      var translatedPrograms = BoogieGenerator.Translate(dafnyProgram, reporter).ToList();
      if (reporter.HasErrors) {
        return VerificationJson(false, 0, reporter.ErrorCount,
          ReporterDiagnostics(reporter), "translation", transcript);
      }

      var diagnostics = ReporterDiagnostics(reporter).ToList();
      var verifiedCount = 0;
      var verificationErrorCount = 0;
      var allVerified = true;

      using var engine = new ExecutionEngine(options, new EmptyVerificationResultCache(), TaskScheduler.Default);
      foreach (var (moduleName, boogieProgram) in translatedPrograms) {
        var (outcome, statistics) = await DafnyMain.BoogieOnce(
          reporter, options, TextWriter.Null, engine, "input.dfy", moduleName,
          boogieProgram, null);
        verifiedCount += statistics.VerifiedCount;
        verificationErrorCount += statistics.ErrorCount + statistics.InconclusiveCount +
                                  statistics.TimeoutCount + statistics.OutOfResourceCount +
                                  statistics.OutOfMemoryCount + statistics.SolverExceptionCount;
        allVerified &= DafnyMain.IsBoogieVerified(outcome, statistics);
      }

      diagnostics.AddRange(VerificationDiagnostics(printer));
      if (!allVerified && diagnostics.All(diagnostic => diagnostic.Severity != "error")) {
        diagnostics.Add(new BrowserDiagnostic(
          "error", "verifier", "Verification did not complete successfully.", null, null));
      }

      return VerificationJson(
        allVerified && !reporter.HasErrors,
        verifiedCount,
        Math.Max(verificationErrorCount, diagnostics.Count(d => d.Severity == "error")),
        diagnostics,
        "verification",
        transcript);
    } catch (Exception exception) {
      return VerificationJson(false, 0, 1,
        [new BrowserDiagnostic("error", "runtime", exception.ToString(), null, null)],
        "exception", transcript);
    } finally {
      PipelineLock.Release();
    }
  }

  [JSExport]
  public static string GetLastSmtTranscript() {
    return JsonSerializer.Serialize(lastSmtTranscript, JsonOptions);
  }

  // Diagnostic for the inline tier's assembly trimming: which assemblies are
  // actually loaded after exercising the pipeline.
  [JSExport]
  public static string GetLoadedAssemblies() {
    return JsonSerializer.Serialize(AppDomain.CurrentDomain.GetAssemblies()
      .Where(assembly => !assembly.IsDynamic)
      .Select(assembly => assembly.GetName().Name)
      .OrderBy(name => name)
      .ToArray());
  }

  private static (DafnyOptions Options, BatchErrorReporter Reporter, DafnyConsolePrinter Printer) CreatePipeline() {
    // Dafny's legacy option registry is populated by this static constructor.
    // It must run before Parse applies defaults, or the first request silently
    // uses different defaults (notably the legacy type-inference engine).
    CommonOptionBag.EnsureStaticConstructorHasRun();
    var options = new DafnyOptions(TextReader.Null, TextWriter.Null, TextWriter.Null) {
      // Seed this before command-line defaults are applied. Boogie's normal
      // default dynamically loads Boogie.Provers.SMTLib from an assembly path,
      // but WebCIL assemblies do not have a usable Assembly.Location.
      TheProverFactory = new Microsoft.Boogie.SMTLib.Factory()
    };
    if (!options.Parse([])) {
      throw new InvalidOperationException("Could not initialize Dafny browser options.");
    }
    // Match the defaults used by `dafny verify` and the VS Code language
    // server. The deprecated CLI parser above otherwise selects its older
    // type-system defaults.
    options.Set(CommonOptionBag.TypeSystemRefresh, false);
    options.Set(CommonOptionBag.GeneralNewtypes, false);
    options.Set(CommonOptionBag.GeneralTraits, CommonOptionBag.GeneralTraitsOptions.Legacy);
    options.UsingNewCli = true;
    options.VcsCores = 1;
    // Diagnostics are returned structurally below. Silent mode prevents the
    // console printer from touching unsupported browser console-color APIs.
    options.Verbosity = CoreOptions.VerbosityLevel.Silent;
    options.DafnyPrelude = EnsureDafnyPrelude();
    options.SetZ3Options(new Version(5, 0, 0));
    var printer = new DafnyConsolePrinter(options);
    options.Printer = printer;
    return (options, new BatchErrorReporter(options), printer);
  }

  private static string EnsureDafnyPrelude() {
    var path = Path.Combine(Path.GetTempPath(), "DafnyPrelude.bpl");
    if (File.Exists(path)) {
      return path;
    }

    using var input = Assembly.GetExecutingAssembly()
      .GetManifestResourceStream("DafnyBrowser.DafnyPrelude.bpl")
      ?? throw new InvalidOperationException("The embedded Dafny prelude is missing.");
    using var output = File.Create(path);
    input.CopyTo(output);
    return path;
  }

  private static async Task<(Microsoft.Dafny.Program? Program, string Stage)> ParseAndResolve(
    string source, DafnyOptions options, BatchErrorReporter reporter) {
    var uri = new Uri("memory:///input.dfy");
    Microsoft.Dafny.Type.ResetScopes();
    var parseResult = await ProgramParser.Parse(source, uri, reporter);
    if (reporter.HasErrors) {
      return (parseResult.Program, "parse");
    }

    await new ProgramResolver(parseResult.Program).Resolve(CancellationToken.None);
    return (parseResult.Program, reporter.HasErrors ? "resolution" : "resolved");
  }

  private static IEnumerable<BrowserDiagnostic> VerificationDiagnostics(DafnyConsolePrinter printer) {
    foreach (var logEntry in printer.VerificationResults) {
      foreach (var counterexample in logEntry.Result.Counterexamples) {
        var information = counterexample.CreateErrorInformation(logEntry.Result.Outcome, false);
        var token = information.Tok ?? counterexample.FailingAssert.tok;
        var dafnyToken = BoogieGenerator.ToDafnyToken(token);
        yield return new BrowserDiagnostic(
          "error",
          "verifier",
          information.FullMsg,
          dafnyToken.line,
          dafnyToken.col);
      }
    }
  }

  private static IEnumerable<BrowserDiagnostic> ReporterDiagnostics(BatchErrorReporter reporter) {
    return reporter.AllMessages.Select(diagnostic => new BrowserDiagnostic(
      diagnostic.Level.ToString().ToLowerInvariant(),
      diagnostic.Source.ToString().ToLowerInvariant(),
      diagnostic.Message,
      diagnostic.Range.StartToken.line,
      diagnostic.Range.StartToken.col
    ));
  }

  private static string VerificationJson(bool verified, int verifiedCount, int errorCount,
    IEnumerable<BrowserDiagnostic> diagnostics, string stage, SmtTranscriptRecorder transcript) {
    lastSmtTranscript = transcript.Snapshot();
    return JsonSerializer.Serialize(new VerificationResult(
      verified, verifiedCount, errorCount, diagnostics.ToArray(), stage, transcript.ExchangeCount
    ), JsonOptions);
  }

  private static ParseResult ParseException(Exception exception) {
    return new ParseResult(false, "exception", 1,
      [new BrowserDiagnostic("error", "runtime", exception.ToString(), null, null)]);
  }

  private static readonly JsonSerializerOptions JsonOptions = new() {
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
  };
}

public sealed record BrowserDiagnostic(
  string Severity,
  string Source,
  string Message,
  int? Line,
  int? Column
);

public sealed record ParseResult(
  bool Parsed,
  string Stage,
  int ErrorCount,
  IReadOnlyList<BrowserDiagnostic> Diagnostics
);

public sealed record VerificationResult(
  bool Verified,
  int VerifiedCount,
  int ErrorCount,
  IReadOnlyList<BrowserDiagnostic> Diagnostics,
  string Stage,
  int SmtExchangeCount
);

public static class Program {
  public static void Main() {
  }
}
