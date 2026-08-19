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
  public static Task<string> Verify(string source) {
    return VerifyCore(source, 0);
  }

  // timeLimitSeconds > 0 overrides `--verification-time-limit`; 0 keeps the
  // CLI default (30 s per obligation at v4.11.0, set in CreatePipeline);
  // -1 removes the limit entirely.
  [JSExport]
  public static Task<string> VerifyWithLimit(string source, int timeLimitSeconds) {
    return VerifyCore(source, timeLimitSeconds);
  }

  // extractCounterexamples asks Z3 for a model on each failed assertion and
  // renders it through Dafny's own counterexample machinery (DafnyModel).
  // Opt-in because it changes the SMT exchange (get-model requests), which
  // the fidelity suite deliberately runs without.
  [JSExport]
  public static Task<string> VerifyFull(string source, int timeLimitSeconds, bool extractCounterexamples) {
    return VerifyCore(source, timeLimitSeconds, extractCounterexamples);
  }

  private static async Task<string> VerifyCore(string source, int timeLimitSeconds, bool extractCounterexamples = false) {
    await PipelineLock.WaitAsync();
    lastBoogieText = "";
    var transcript = new SmtTranscriptRecorder();
    try {
      var (options, reporter, printer) = CreatePipeline();
      options.CreateSolver = (_, _) => new BrowserSmtSolver(transcript);
      if (extractCounterexamples) {
        // What `dafny verify --extract-counterexample` sets: EnhancedErrorMessages
        // makes Boogie request models (ExpectingModel) for failing assertions.
        options.ExtractCounterexample = true;
        options.EnhancedErrorMessages = 1;
      }
      if (timeLimitSeconds > 0) {
        options.TimeLimit = (uint)timeLimitSeconds;
      } else if (timeLimitSeconds < 0) {
        options.TimeLimit = 0;
      }

      var (dafnyProgram, stage) = await ParseAndResolve(source, options, reporter);
      if (dafnyProgram == null || reporter.HasErrors) {
        return VerificationJson(false, 0, reporter.ErrorCount,
          ReporterDiagnostics(reporter), stage, transcript);
      }

      var translatedPrograms = BoogieGenerator.Translate(dafnyProgram, reporter).ToList();
      lastBoogieText = RenderBoogie(translatedPrograms, options);
      if (reporter.HasErrors) {
        return VerificationJson(false, 0, reporter.ErrorCount,
          ReporterDiagnostics(reporter), "translation", transcript);
      }

      var diagnostics = ReporterDiagnostics(reporter).ToList();
      var verifiedCount = 0;
      var verificationErrorCount = 0;
      var allVerified = true;
      var timeoutCount = 0;
      var outOfResourceCount = 0;

      using var engine = new ExecutionEngine(options, new EmptyVerificationResultCache(), TaskScheduler.Default);
      foreach (var (moduleName, boogieProgram) in translatedPrograms) {
        var (outcome, statistics) = await DafnyMain.BoogieOnce(
          reporter, options, TextWriter.Null, engine, "input.dfy", moduleName,
          boogieProgram, null);
        verifiedCount += statistics.VerifiedCount;
        verificationErrorCount += statistics.ErrorCount + statistics.InconclusiveCount +
                                  statistics.TimeoutCount + statistics.OutOfResourceCount +
                                  statistics.OutOfMemoryCount + statistics.SolverExceptionCount;
        timeoutCount += statistics.TimeoutCount;
        outOfResourceCount += statistics.OutOfResourceCount;
        allVerified &= DafnyMain.IsBoogieVerified(outcome, statistics);
      }

      diagnostics.AddRange(VerificationDiagnostics(printer, extractCounterexamples ? options : null));
      if (timeoutCount > 0) {
        diagnostics.Add(new BrowserDiagnostic("error", "verifier",
          $"{timeoutCount} proof obligation(s) timed out" +
          (timeLimitSeconds > 0 ? $" (limit {timeLimitSeconds}s per obligation)" : ""),
          null, null));
      }
      if (outOfResourceCount > 0) {
        diagnostics.Add(new BrowserDiagnostic("error", "verifier",
          $"{outOfResourceCount} proof obligation(s) ran out of solver resources", null, null));
      }
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

  // Translate the program to JavaScript the way `dafny translate js
  // --include-runtime` does (the string-building path of the CLI driver,
  // minus the file writing): the returned text plus callToMain is exactly
  // what `dafny run` pipes into node's stdin — here the caller feeds it to
  // the browser's own JS engine. Verification is the caller's business
  // (`dafny run` verifies first, too).
  [JSExport]
  public static async Task<string> CompileToJs(string source) {
    await PipelineLock.WaitAsync();
    try {
      var (options, reporter, _) = CreatePipeline();
      // IncludeRuntime defaults to TRUE (the internal --include-runtime
      // registered for execution); clear it — the code generator would fetch
      // the runtime from DafnyPipeline.dll, which is not shipped. The embedded
      // copy is prepended below instead: same text, same leading position.
      options.IncludeRuntime = false;
      options.Backend = new Microsoft.Dafny.Compilers.JavaScriptBackend(options);

      var (dafnyProgram, stage) = await ParseAndResolve(source, options, reporter);
      if (dafnyProgram == null || reporter.HasErrors) {
        return CompileJson(false, stage, false, null, null, reporter);
      }

      foreach (var rewriter in RewriterCollection.GetRewriters(reporter, dafnyProgram)) {
        rewriter.PostVerification(dafnyProgram);
      }

      var compiler = options.Backend;
      compiler.OnPreCompile(reporter, new System.Collections.ObjectModel.ReadOnlyCollection<string>([]));
      var hasMain = Microsoft.Dafny.Compilers.SinglePassCodeGenerator.HasMain(dafnyProgram, out var mainMethod);
      if (hasMain) {
        mainMethod.IsEntryPoint = true;
        dafnyProgram.MainMethod = mainMethod;
      }

      // The CLI wraps this call in LargeStackFactory (a big-stack thread);
      // browser-wasm calls it directly and accepts the same deep-recursion
      // ceiling the Mono interpreter already imposes elsewhere.
      var output = new ConcreteSyntaxTree();
      compiler.Compile(dafnyProgram, "main.dfy", output);
      var textWriter = new StringWriter();
      output.Render(textWriter, 0, new WriterState(), new Queue<FileSyntax>(), compiler.TargetIndentSize);

      string? callToMain = null;
      if (hasMain) {
        var callTree = new ConcreteSyntaxTree();
        compiler.EmitCallToMain(mainMethod, "main", callTree);
        callToMain = callTree.MakeString(compiler.TargetIndentSize);
      }

      if (reporter.HasErrors || reporter.FailCompilation) {
        return CompileJson(false, "compilation", hasMain, null, null, reporter);
      }
      using var runtimeStream = Assembly.GetExecutingAssembly()
        .GetManifestResourceStream("DafnyBrowser.DafnyRuntime.js")
        ?? throw new InvalidOperationException("The embedded Dafny JS runtime is missing.");
      var runtimeJs = new StreamReader(runtimeStream).ReadToEnd();
      return CompileJson(true, "compiled", hasMain,
        runtimeJs + "\n" + textWriter.ToString(), callToMain, reporter);
    } catch (UnsupportedFeatureException unsupported) {
      return JsonSerializer.Serialize(new CompileResult(false, "compilation", false, null, null, 1,
        [new BrowserDiagnostic("error", "compiler", unsupported.Message,
          unsupported.Token?.line, unsupported.Token?.col)]), JsonOptions);
    } catch (Exception exception) {
      return JsonSerializer.Serialize(new CompileResult(false, "exception", false, null, null, 1,
        [new BrowserDiagnostic("error", "runtime", exception.ToString(), null, null)]), JsonOptions);
    } finally {
      PipelineLock.Release();
    }
  }

  private static string CompileJson(bool ok, string stage, bool hasMain, string? js, string? callToMain,
    BatchErrorReporter reporter) {
    return JsonSerializer.Serialize(new CompileResult(ok, stage, hasMain, js, callToMain,
      reporter.ErrorCount, ReporterDiagnostics(reporter).ToArray()), JsonOptions);
  }

  [JSExport]
  public static string GetLastSmtTranscript() {
    return JsonSerializer.Serialize(lastSmtTranscript, JsonOptions);
  }

  // The Boogie program the last verification translated to — the readable
  // middle layer between Dafny and the SMT queries. Prelude declarations
  // (DafnyPrelude.bpl axiomatization, constant for every program) are
  // filtered out by source token; what remains is the program-specific
  // translation.
  [JSExport]
  public static string GetLastBoogie() {
    return JsonSerializer.Serialize(lastBoogieText, JsonOptions);
  }

  private static string lastBoogieText = "";

  private static string RenderBoogie(
    IEnumerable<Tuple<string, Microsoft.Boogie.Program>> programs, DafnyOptions options) {
    try {
      var writer = new StringWriter();
      foreach (var (moduleName, boogieProgram) in programs) {
        writer.WriteLine($"// ============ Boogie translation: module {moduleName} ============");
        var tokenWriter = new Microsoft.Boogie.TokenTextWriter("<buffer>", writer, false, false, options);
        foreach (var declaration in boogieProgram.TopLevelDeclarations) {
          var file = declaration.tok?.filename;
          if (file != null && file.EndsWith("DafnyPrelude.bpl")) {
            continue;
          }
          declaration.Emit(tokenWriter, 0);
          writer.WriteLine();
        }
      }
      return writer.ToString();
    } catch (Exception exception) {
      // Printing is diagnostics-only; it must never break verification.
      return "// could not print the Boogie program: " + exception.Message;
    }
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
    // Match the `dafny verify` CLI defaults OF THE PINNED VERSION — these
    // are per-version facts, not constants: at v4.11.0 the CLI still
    // defaults to the legacy type system (TypeSystemRefresh/GeneralNewtypes
    // false, GeneralTraits Legacy); post-4.11 master flips all three. Any
    // re-pin must re-read CommonOptionBag and re-run the differential suite
    // (prototype/test/differential/) against a native build of the same
    // commit — that suite is the arbiter, not this comment.
    options.Set(CommonOptionBag.TypeSystemRefresh, false);
    options.Set(CommonOptionBag.GeneralNewtypes, false);
    options.Set(CommonOptionBag.GeneralTraits, CommonOptionBag.GeneralTraitsOptions.Legacy);
    // The CLI's --relax-definite-assignment defaults to false at all pins
    // considered, and its binding maps that to level 4; the legacy property
    // default is the relaxed level 1. Found differentially: the browser
    // silently accepted 37 official-suite programs that `dafny verify`
    // rejects with definite-assignment errors.
    options.DefiniteAssignmentLevel = 4;
    // BoogieOptionBag.VerificationTimeLimit defaults to 30 (seconds, per
    // obligation) in the modern CLI; the legacy property default is 0 (no
    // limit). Found differentially: native reports "timed out after 30
    // seconds" where the browser hung indefinitely.
    options.TimeLimit = 30;
    options.UsingNewCli = true;
    options.VcsCores = 1;
    // Diagnostics are returned structurally below. Silent mode prevents the
    // console printer from touching unsupported browser console-color APIs.
    options.Verbosity = CoreOptions.VerbosityLevel.Silent;
    options.DafnyPrelude = EnsureDafnyPrelude();
    // Both solver tiers ship Z3 4.16.0 (the version Dafny 4.11 packages and
    // Homebrew links), so Boogie's SMT encoding is tuned for it. Keep this in
    // lockstep with the z3-solver npm pin and the z3-inline release tag.
    options.SetZ3Options(new Version(4, 16, 0));
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

  private static IEnumerable<BrowserDiagnostic> VerificationDiagnostics(
    DafnyConsolePrinter printer, DafnyOptions? counterexampleOptions) {
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
          dafnyToken.col,
          counterexampleOptions == null ? null : ExtractCounterexample(counterexample, counterexampleOptions));
      }
    }
  }

  /// <summary>
  /// Render a Boogie counterexample through Dafny's model interpretation
  /// (the same path as `dafny verify --extract-counterexample`): a sequence
  /// of execution states, each holding a Dafny assumption expression that
  /// constrains the variables in scope at that point. Model interpretation
  /// is heuristic and known-fragile upstream, so every step is fault-isolated.
  /// </summary>
  private static IReadOnlyList<CounterexampleState>? ExtractCounterexample(
    Microsoft.Boogie.Counterexample counterexample, DafnyOptions options) {
    if (counterexample.Model == null) {
      return null;
    }
    try {
      var model = new DafnyModel(counterexample.Model, options);
      model.AssignConcretePrimitiveValues();
      var states = new List<CounterexampleState>();
      foreach (var state in model.States) {
        if (!state.StateContainsPosition()) {
          continue;
        }
        try {
          var assumption = state.AsAssumption().ToString().Trim();
          states.Add(new CounterexampleState(
            state.FullStateName,
            state.GetLineId(),
            state.GetCharId(),
            state.IsInitialState,
            assumption));
        } catch {
          // Skip states the model interpreter cannot render.
        }
      }
      return states.Count > 0 ? states : null;
    } catch {
      return null;
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
  int? Column,
  [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
  IReadOnlyList<CounterexampleState>? Counterexample = null
);

public sealed record CounterexampleState(
  string Name,
  int Line,
  int Column,
  bool IsInitial,
  string Assumption
);

public sealed record CompileResult(
  bool Ok,
  string Stage,
  bool HasMain,
  string? Js,
  string? CallToMain,
  int ErrorCount,
  IReadOnlyList<BrowserDiagnostic> Diagnostics
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
