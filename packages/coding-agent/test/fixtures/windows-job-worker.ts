import { resolve } from "node:path";
import { createLocalBashOperations } from "../../src/core/tools/bash.js";
import { initializeWindowsDaemonWorkerJob } from "../../src/utils/windows-job-object.js";

const [mode, cwd, markerPath, shellPath] = process.argv.slice(2);
if (!mode || !cwd || !markerPath || !shellPath) {
	throw new Error("Expected mode, cwd, marker path, and shell path");
}
if (mode === "job") {
	initializeWindowsDaemonWorkerJob();
} else if (mode !== "control") {
	throw new Error(`Unknown mode: ${mode}`);
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const blocker = resolve(import.meta.dirname, "blocking-process-tree.mjs");
const command = [process.execPath, blocker, markerPath].map(quote).join(" ");
await createLocalBashOperations({ shellPath }).exec(command, cwd, { onData: () => {} });
