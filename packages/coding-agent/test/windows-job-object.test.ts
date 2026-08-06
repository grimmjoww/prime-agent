import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { signalProcessGroupOrProcess } from "../src/utils/child-process.js";
import { getDirectWindowsBashPath } from "../src/utils/shell.js";

const workerPath = resolve(__dirname, "fixtures/windows-job-worker.ts");
const tsxPreflightPath = resolve(__dirname, "../../../node_modules/tsx/dist/preflight.cjs");
const tsxLoaderUrl = pathToFileURL(resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs")).href;
const gitBashPath = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function waitForStartId(pid: number): Promise<string> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const startId = getProcessStartId(pid);
		if (startId) return startId;
		await delay(25);
	}
	throw new Error(`Could not read process identity for ${pid}`);
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForIdentityGone(pid: number, startId?: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (!isProcessRunning(pid)) return;
		const observedStartId = getProcessStartId(pid);
		if (startId && observedStartId && observedStartId !== startId) return;
		await delay(25);
	}
	throw new Error(`Process identity ${pid}/${startId} remained alive`);
}

async function waitForMarker(path: string, child: ChildProcess, diagnostics: () => string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path) && Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`Job worker exited before its blocker started: ${diagnostics()}`);
		}
		await delay(25);
	}
	if (!existsSync(path)) throw new Error(`Job worker blocker did not start: ${diagnostics()}`);
}

async function terminateTrackedIdentity(pid: number, startId?: string): Promise<Error | undefined> {
	if (!isProcessRunning(pid)) return undefined;
	if (!startId) {
		const signaled = signalProcessGroupOrProcess(pid, "SIGKILL");
		return new Error(
			`Process ${pid} was registered before its identity could be read; forced cleanup ${signaled ? "was sent" : "failed"}`,
		);
	}
	const deadline = Date.now() + 2000;
	while (isProcessRunning(pid) && Date.now() < deadline) {
		const observedStartId = getProcessStartId(pid);
		if (observedStartId && observedStartId !== startId) return undefined;
		if (observedStartId === startId) {
			return signalProcessGroupOrProcess(pid, "SIGKILL")
				? undefined
				: new Error(`Could not terminate process identity ${pid}/${startId}`);
		}
		await delay(25);
	}
	if (!isProcessRunning(pid)) return undefined;
	const signaled = signalProcessGroupOrProcess(pid, "SIGKILL");
	return new Error(
		`Could not verify process identity ${pid}/${startId} before forced cleanup; signal ${signaled ? "was sent" : "failed"}`,
	);
}

async function removeDirectory(path: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (true) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await delay(25);
		}
	}
}

describe.skipIf(process.platform !== "win32")("Windows daemon worker Job Object", () => {
	it("rejects a non-Git bash executable for daemon isolation", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-unsupported-bash-"));
		try {
			const shellPath = join(root, "usr", "bin", "bash.exe");
			mkdirSync(join(root, "usr", "bin"), { recursive: true });
			writeFileSync(shellPath, "not git bash");
			expect(() => getDirectWindowsBashPath(shellPath)).toThrow("requires Git for Windows");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("kills an assigned Bash leaf when its owner exits while the no-Job control survives", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-job-causality-"));
		const tracked = new Map<number, string | undefined>();
		const cleanupErrors: unknown[] = [];
		const bashEnvMarker = join(root, "bash-env-ran");
		const bashEnvPath = join(root, "bash-env.sh");
		writeFileSync(
			bashEnvPath,
			`printf startup > '${bashEnvMarker.replaceAll("\\", "/").replaceAll("'", `'"'"'`)}'\n`,
		);
		let testError: unknown;
		try {
			for (const mode of ["job", "control"] as const) {
				const markerPath = join(root, `${mode}.json`);
				let diagnostics = "";
				const child = spawn(
					process.execPath,
					[
						"--require",
						tsxPreflightPath,
						"--import",
						tsxLoaderUrl,
						workerPath,
						mode,
						root,
						markerPath,
						gitBashPath,
					],
					{
						cwd: root,
						env: { ...process.env, ...(mode === "job" ? { BASH_ENV: bashEnvPath } : {}) },
						stdio: ["ignore", "pipe", "pipe"],
						windowsHide: true,
					},
				);
				child.stdout?.on("data", (chunk) => {
					diagnostics += chunk.toString();
				});
				child.stderr?.on("data", (chunk) => {
					diagnostics += chunk.toString();
				});
				if (!child.pid) throw new Error("Could not obtain Job worker pid");
				tracked.set(child.pid, undefined);
				const workerStartId = await waitForStartId(child.pid);
				tracked.set(child.pid, workerStartId);
				await waitForMarker(markerPath, child, () => diagnostics);
				if (mode === "job") expect(existsSync(bashEnvMarker)).toBe(false);
				const blocker = JSON.parse(readFileSync(markerPath, "utf8")) as { pid: number; parentPid: number };
				tracked.set(blocker.pid, undefined);
				tracked.set(blocker.parentPid, undefined);
				const leafStartId = await waitForStartId(blocker.pid);
				tracked.set(blocker.pid, leafStartId);
				const parentStartId = await waitForStartId(blocker.parentPid);
				tracked.set(blocker.parentPid, parentStartId);

				process.kill(child.pid, "SIGKILL");
				await waitForIdentityGone(child.pid, workerStartId);
				tracked.delete(child.pid);
				if (mode === "job") {
					await waitForIdentityGone(blocker.pid, leafStartId);
					tracked.delete(blocker.pid);
					await waitForIdentityGone(blocker.parentPid, parentStartId);
					tracked.delete(blocker.parentPid);
				} else {
					await delay(500);
					expect(getProcessStartId(blocker.pid)).toBe(leafStartId);
				}
			}
		} catch (error) {
			testError = error;
		} finally {
			for (const [pid, startId] of tracked) {
				const error = await terminateTrackedIdentity(pid, startId);
				if (error) cleanupErrors.push(error);
			}
			for (const [pid, startId] of tracked) {
				try {
					await waitForIdentityGone(pid, startId);
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			try {
				await removeDirectory(root);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				testError ? [testError, ...cleanupErrors] : cleanupErrors,
				"Windows Job test cleanup failed",
			);
		}
		if (testError) throw testError;
	});
});
