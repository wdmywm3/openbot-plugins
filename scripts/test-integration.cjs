"use strict";
// Test-only host checkout; never imported by a shipped package.
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."), host = path.resolve(process.env.OPENBOT_HOST_ROOT || path.join(root, "../openbot"));
if (!fs.existsSync(path.join(host, "electron/lib/plugins/plugin-package.cjs"))) throw Error("请用 OPENBOT_HOST_ROOT 指定 OpenBot 源码目录");
const pythonIn = name => path.join(root, name, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const watchPython = process.env.WATCH_TEST_PYTHON || (fs.existsSync(pythonIn(".venv-watch-full")) ? pythonIn(".venv-watch-full") : "python");
const wikiPython = process.env.MEMEWIKI_TEST_PYTHON || (fs.existsSync(pythonIn(".venv-verify")) ? pythonIn(".venv-verify") : watchPython);
const env = { ...process.env, OPENBOT_HOST_ROOT: host, OPENBOT_SOURCE: host, OPENBOT_TEST_MEMORY_UI: "1", OPENBOT_TEST_MEME_UI: "1", WATCH_TEST_PYTHON: watchPython, MEMEWIKI_TEST_PYTHON: wikiPython };
const runs = [
  [watchPython, ["-c", "import PIL, filelock"]], [wikiPython, ["-c", "import PIL"]],
  ...["memory-retention-behavior.cjs", "memory-dedup.cjs", "memory-maintenance.cjs", "memory-organizer-policy.cjs", "memory-organizer.cjs", "memory-management.cjs", "memory-catalog-cache.cjs", "memory-usage-sync.cjs", "memory-unified.cjs", "memory-plus.cjs", "memory-index.cjs", "memory-multimodal.cjs", "memory-host.cjs", "memory-lifecycle.cjs", "memory-context.cjs", "memory-dream-host.cjs",
    "meme-host.cjs", "memewiki-host.cjs", "search-host.cjs", "image-studio-host.cjs", "image-studio-selfie-host.cjs", "tool-workshop.cjs", "watch-host.cjs"].map(name => [process.execPath, [path.join(root, "tests", name), host]]),
  [watchPython, ["-B", "-m", "unittest", "discover", "-s", "tests", "-p", "watch*_test.py", "-v"]],
  [wikiPython, ["-B", "-m", "unittest", "discover", "-s", "tests", "-p", "memewiki_test.py", "-v"]],
];
let failures = 0;
for (const [file, args] of runs) {
  console.log(`Integration: ${args.join(" ")}`);
  const result = spawnSync(file, args, { cwd: root, env, stdio: "inherit", timeout: 240000, windowsHide: true });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) failures++;
}
if (failures) console.error(`${failures} integration steps failed. Check the explicit Python environments and package lock dependencies; no cases were silently skipped.`);
process.exitCode = failures ? 1 : 0;
