import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "darwin") {
  console.log("Native recording checks require macOS.");
  process.exit(0);
}
const directory = mkdtempSync(join(tmpdir(), "mochi-native-tests-"));
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
};
try {
  for (const name of ["native_capture_lifecycle", "overlay_window"]) {
    const executable = join(directory, name);
    const frameworks = name === "overlay_window"
      ? ["AppKit", "Foundation"]
      : ["AVFoundation", "AudioToolbox", "CoreGraphics", "CoreMedia", "Foundation", "ScreenCaptureKit"];
    run("xcrun", ["clang", "-fobjc-arc", "-fblocks", "-Wno-nonnull", "-Wno-nullability-completeness", "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx15.0`,
      `src-tauri/tests/${name}.m`, ...frameworks.flatMap(framework => ["-framework", framework]), "-o", executable]);
    run(executable, []);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
