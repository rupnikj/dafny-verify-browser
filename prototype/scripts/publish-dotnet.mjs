import { spawn } from "node:child_process";

// The publish targets net8.0; if your default `dotnet` is a different SDK,
// point DAFNY_BROWSER_DOTNET at a .NET 8 SDK's dotnet binary.
const dotnet = process.env.DAFNY_BROWSER_DOTNET ?? "dotnet";

const child = spawn(dotnet, [
  "publish",
  "DafnyBrowser.csproj",
  "-c", "Release",
  "-p:SkipDafnyRuntimeJar=true",
  "-o", "dist"
], { stdio: "inherit" });

child.on("error", error => {
  console.error(`Unable to start ${dotnet}: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", code => {
  process.exitCode = code ?? 1;
});
