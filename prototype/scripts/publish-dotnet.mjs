import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const workspaceDotnet8 = "/opt/homebrew/Cellar/dotnet@8/8.0.129/libexec/dotnet";
const dotnet = process.env.DAFNY_BROWSER_DOTNET ??
  (existsSync(workspaceDotnet8) ? workspaceDotnet8 : "dotnet");

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
