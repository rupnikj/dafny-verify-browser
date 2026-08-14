using System.Runtime.InteropServices.JavaScript;
using System.Text;
using Microsoft.Boogie;
using Microsoft.Boogie.SMTLib;

namespace DafnyBrowser;

/// <summary>
/// The browser implementation of Boogie's existing SMTLibSolver abstraction.
/// Boogie still owns all SMT-LIB encoding and protocol decisions; this class
/// only replaces the stdin/stdout process transport.
/// </summary>
public sealed class BrowserSmtSolver : SMTLibSolver {
  private static int nextSolverId;

  private readonly int solverId = Interlocked.Increment(ref nextSolverId);
  private readonly SemaphoreSlim requestLock = new(1, 1);
  private readonly List<string> pendingCommands = [];
  private readonly SmtTranscriptRecorder transcript;
  private bool closed;

  public BrowserSmtSolver(SmtTranscriptRecorder transcript) {
    this.transcript = transcript;
  }

  public override event Action<string>? ErrorHandler;

  public override void Send(string cmd) {
    ObjectDisposedException.ThrowIf(closed, this);
    pendingCommands.Add(cmd);
  }

  public override async Task<SExpr> SendRequest(string request,
    CancellationToken cancellationToken = default) {
    await requestLock.WaitAsync(cancellationToken);
    try {
      cancellationToken.ThrowIfCancellationRequested();
      var script = DrainPendingCommands(request);
      var responseText = await BrowserZ3Interop.EvaluateAsync(solverId, script);
      transcript.Record(script, responseText);
      cancellationToken.ThrowIfCancellationRequested();

      SExpr? lastResponse = null;
      foreach (var response in ParseResponses(responseText)) {
        var usableResponse = HandleResponse(response);
        if (usableResponse != null) {
          lastResponse = usableResponse;
        }
      }

      return lastResponse ?? throw new ProverException(
        $"Z3 returned no SMT response for request: {request}");
    } finally {
      requestLock.Release();
    }
  }

  public override async Task<IReadOnlyList<SExpr>> SendRequestsAndCloseInput(
    IReadOnlyList<string> requests, CancellationToken cancellationToken = default) {
    var responses = new List<SExpr>(requests.Count);
    foreach (var request in requests) {
      responses.Add(await SendRequest(request, cancellationToken));
    }
    return responses;
  }

  public override void NewProblem(string descriptiveName) {
    transcript.NewProblem(descriptiveName);
  }

  public override async Task PingPong() {
    var response = await SendRequest(PingRequest);
    if (!IsPong(response)) {
      throw new ProverException($"Invalid PING response from Z3 WASM: {response}");
    }
  }

  public override void AddErrorHandler(Action<string> handler) {
    ErrorHandler += handler;
  }

  public override void Close() {
    if (closed) {
      return;
    }
    closed = true;
    BrowserZ3Interop.Close(solverId);
    requestLock.Dispose();
  }

  private string DrainPendingCommands(string request) {
    var builder = new StringBuilder();
    foreach (var command in pendingCommands) {
      builder.AppendLine(command);
    }
    pendingCommands.Clear();
    builder.AppendLine(request);
    return builder.ToString();
  }

  private IReadOnlyList<SExpr> ParseResponses(string responseText) {
    using var stream = new MemoryStream(Encoding.UTF8.GetBytes(responseText));
    using var reader = new StreamReader(stream, Encoding.UTF8);
    return new ResponseParser(reader, HandleError).ParseSExprs(false).ToList();
  }

  private SExpr? HandleResponse(SExpr response) {
    if (response.Name == "unsupported") {
      return null;
    }

    if (response.Name != "error") {
      return response;
    }

    if (response.Arguments.Length != 1 || !response.Arguments[0].IsId) {
      HandleError(response.ToString());
      return null;
    }

    var message = response.Arguments[0].Name;
    if (message.Contains("max. resource limit exceeded") || message.Contains("push canceled")) {
      return response;
    }

    if (message.Contains("model is not available") ||
        message.Contains("unsat core is not available") ||
        message.Contains("context is unsatisfiable") ||
        message.Contains("Cannot get model") ||
        message.Contains("last result wasn't unknown")) {
      return null;
    }

    HandleError(message);
    return null;
  }

  private void HandleError(string message) {
    ErrorHandler?.Invoke(message);
  }

  private sealed class ResponseParser(StreamReader reader, Action<string> reportError) : SExpr.Parser(reader) {
    public override void ParseError(string message) {
      reportError(message);
    }
  }
}

internal static partial class BrowserZ3Interop {
  [JSImport("evaluate", "dafnyZ3")]
  internal static partial Task<string> EvaluateAsync(int solverId, string smtLib);

  [JSImport("close", "dafnyZ3")]
  internal static partial void Close(int solverId);
}

public sealed class SmtTranscriptRecorder {
  private readonly List<SmtTranscriptEntry> entries = [];

  public int ExchangeCount => entries.Count(entry => entry.Kind == "exchange");

  public void NewProblem(string name) {
    entries.Add(new SmtTranscriptEntry("problem", name, ""));
  }

  public void Record(string script, string response) {
    entries.Add(new SmtTranscriptEntry("exchange", script, response));
  }

  public IReadOnlyList<SmtTranscriptEntry> Snapshot() => entries.ToArray();
}

public sealed record SmtTranscriptEntry(string Kind, string Input, string Output);
