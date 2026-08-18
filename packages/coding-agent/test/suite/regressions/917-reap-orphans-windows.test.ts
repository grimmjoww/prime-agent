import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { getProcessStartId } from "../../../src/core/session-lease.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import type { DaemonWorkerDescriptor } from "../../../src/modes/daemon/daemon-worker-protocol.js";

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const tsxPreflightPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/preflight.cjs");
const tsxLoaderUrl = pathToFileURL(resolve(__dirname, "../../../../../node_modules/tsx/dist/loader.mjs")).href;
const blockingProcessTreePath = resolve(__dirname, "../../fixtures/blocking-process-tree.mjs");

const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const workerPids = new Set<number>();
const daemonSockets = new Set<string>();
const childDiagnostics = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

afterEach(async () => {
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.request({ type: "shutdown" }, 2000);
		} catch {
			// Already gone.
		} finally {
			client.close();
		}
	}
	daemonSockets.clear();
	const trackedChildren = [...children];
	for (const child of trackedChildren) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
	}
	await Promise.all(
		trackedChildren.map(
			(child) =>
				new Promise<void>((resolveExit) => {
					if (child.exitCode !== null || child.signalCode !== null) {
						resolveExit();
						return;
					}
					const timer = setTimeout(resolveExit, 5000);
					child.once("exit", () => {
						clearTimeout(timer);
						resolveExit();
					});
				}),
		),
	);
	children.clear();
	const trackedWorkerPids = [...workerPids];
	for (const pid of trackedWorkerPids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}
	await Promise.all(trackedWorkerPids.map((pid) => waitForProcessGone(pid)));
	workerPids.clear();
	for (const directory of tempDirs.splice(0)) {
		const deadline = Date.now() + 5000;
		while (true) {
			try {
				rmSync(directory, { recursive: true, force: true });
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (process.platform !== "win32" || (code !== "EPERM" && code !== "ENOTEMPTY") || Date.now() >= deadline) {
					throw error;
				}
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
			}
		}
	}
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-917-orphans-test-"));
	tempDirs.push(directory);
	return directory;
}

function testSocketPath(prefix: string): string {
	const name = `${prefix}-${process.pid}-${randomUUID().slice(0, 8)}`;
	return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

function spawnSupervisor(agentDir: string, socketPath: string, cwd: string): ChildProcess {
	daemonSockets.add(socketPath);
	const child = spawn(
		process.execPath,
		[
			"--require",
			tsxPreflightPath,
			"--import",
			tsxLoaderUrl,
			cliPath,
			"--mode",
			"daemon",
			"--daemon-socket",
			socketPath,
			"--offline",
		],
		{
			cwd,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.add(child);
	const diagnostics = { stdout: "", stderr: "" };
	childDiagnostics.set(child, diagnostics);
	child.stdout?.on("data", (chunk: Buffer) => {
		diagnostics.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		diagnostics.stderr += chunk.toString("utf8");
	});
	return child;
}

async function connectEventually(socketPath: string, child?: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 15_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (child && (child.exitCode !== null || child.signalCode !== null)) {
			const diagnostics = childDiagnostics.get(child);
			throw new Error(
				`Supervisor exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})\n` +
					`stdout:\n${diagnostics?.stdout ?? ""}\nstderr:\n${diagnostics?.stderr ?? ""}`,
			);
		}
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			if (child && client.hello?.supervisorPid !== child.pid) {
				throw new Error(`Supervisor hello pid ${client.hello?.supervisorPid} did not match child pid ${child.pid}`);
			}
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
	}
	throw new Error(`Timed out waiting for supervisor: ${String(lastError)}`);
}

function readWorkerDescriptor(agentDir: string): DaemonWorkerDescriptor {
	const workersRoot = join(agentDir, "daemon-workers");
	for (const directory of readdirSync(workersRoot)) {
		const descriptorDirectory = join(workersRoot, directory);
		for (const name of readdirSync(descriptorDirectory)) {
			if (name.endsWith(".json")) {
				return JSON.parse(readFileSync(join(descriptorDirectory, name), "utf8")) as DaemonWorkerDescriptor;
			}
		}
	}
	throw new Error("Worker descriptor was not persisted");
}

function readDaemonLogs(agentDir: string): string {
	const logsDir = join(agentDir, "logs");
	try {
		return readdirSync(logsDir)
			.map((name) => `${name}:\n${readFileSync(join(logsDir, name), "utf8")}`)
			.join("\n");
	} catch {
		return "no daemon logs";
	}
}

function requireSummary(responseData: unknown): SessionSummary {
	if (!responseData || typeof responseData !== "object") {
		throw new Error("Missing daemon session summary");
	}
	return responseData as SessionSummary;
}

function requireSessionList(responseData: unknown): SessionSummary[] {
	if (!responseData || typeof responseData !== "object" || !("sessions" in responseData)) {
		throw new Error("Missing daemon session list");
	}
	const sessions = (responseData as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Invalid daemon session list");
	}
	return sessions as SessionSummary[];
}

async function waitForCondition(predicate: () => boolean, failureMessage: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(failureMessage);
}

function isProcessIdentityAlive(pid: number, processStartId: string): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	return getProcessStartId(pid) === processStartId;
}

async function waitForProcessGone(pid: number, processStartId?: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
			const observedProcessStartId = processStartId ? getProcessStartId(pid) : undefined;
			if (observedProcessStartId && observedProcessStartId !== processStartId) {
				return;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				return;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Process ${pid} remained alive after daemon shutdown`);
}

describe.skipIf(process.platform !== "win32")(
	"regression #917: Windows daemon recovery reaps orphaned process trees",
	() => {
		it("terminates a journaled orphan tree that was never assigned to the worker's Job Object", {
			timeout: 90_000,
		}, async () => {
			const root = tempDir();
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			const sessionDir = join(agentDir, "sessions");
			const socketPath = testSocketPath("prime-917-orphans");
			mkdirSync(projectDir, { recursive: true });

			const sessionManager = SessionManager.create(projectDir, sessionDir);
			sessionManager.appendMessage({ role: "user", content: "917 fixture", timestamp: 1 });
			sessionManager.flushNow();
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Fixture session did not persist");
			}

			const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
			const client = await connectEventually(socketPath, supervisor);
			try {
				const created = await client.request({
					type: "create",
					sessionPath: sessionFile,
					config: {
						cwd: projectDir,
						agentDir,
						sessionDir,
						noTools: true,
						noExtensions: true,
					},
				});
				if (!created.success) {
					throw new Error(`${created.error}\n${readDaemonLogs(agentDir)}`);
				}
				const createdSummary = requireSummary(created.data);
				expect(createdSummary.workerState).toBe("ready");
				const workerPid = createdSummary.workerPid;
				if (!workerPid) {
					throw new Error("Resident worker did not expose its pid");
				}
				workerPids.add(workerPid);

				const descriptor = readWorkerDescriptor(agentDir);
				if (!descriptor.orphanProcessJournalPath) {
					throw new Error("Resident worker did not persist its orphan-process journal path");
				}

				// Plant the #917 orphan class: a live process that is journaled as the
				// worker's orphan but was never assigned to the worker's Job Object.
				// Autonomous-spawned children take exactly this path, so killing the
				// worker cannot take this process down with it.
				const markerPath = join(root, "orphan-917.json");
				const orphan = spawn(process.execPath, [blockingProcessTreePath, markerPath], { stdio: "ignore" });
				children.add(orphan);
				if (!orphan.pid) {
					throw new Error("Orphan fixture did not expose a pid");
				}
				const orphanPid = orphan.pid;
				await waitForCondition(() => existsSync(markerPath), "Orphan fixture did not become ready");
				const orphanStartId = getProcessStartId(orphanPid);
				if (!orphanStartId) {
					throw new Error("Orphan fixture did not expose a process start id");
				}
				appendFileSync(
					descriptor.orphanProcessJournalPath,
					`${JSON.stringify({
						version: 1,
						pid: orphanPid,
						ownerPid: workerPid,
						processStartId: orphanStartId,
						active: true,
						recordedAt: new Date().toISOString(),
					})}\n`,
				);

				process.kill(workerPid, "SIGKILL");
				await waitForProcessGone(workerPid);
				workerPids.delete(workerPid);
				if (!isProcessIdentityAlive(orphanPid, orphanStartId)) {
					throw new Error("Orphan fixture died with the worker; the #917 precondition requires it to survive");
				}

				const activeSessionId = createdSummary.activeSessionId ?? createdSummary.id;
				let recovered: SessionSummary | undefined;
				const recoveryDeadline = Date.now() + 30_000;
				while (Date.now() < recoveryDeadline) {
					const response = await client.request({ type: "list" });
					if (response.success) {
						recovered = requireSessionList(response.data).find(
							(summary) => (summary.activeSessionId ?? summary.id) === activeSessionId,
						);
						if (recovered?.workerState === "ready" && recovered.workerPid !== workerPid) {
							break;
						}
					}
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
				}

				try {
					await waitForCondition(
						() => !isProcessIdentityAlive(orphanPid, orphanStartId),
						`Orphaned process tree ${orphanPid} survived worker recovery`,
						10_000,
					);
				} catch (error) {
					throw new Error(`${String(error)}\n${readDaemonLogs(agentDir)}`);
				}
				expect(recovered?.workerState).toBe("ready");
				if (recovered?.workerPid) {
					workerPids.add(recovered.workerPid);
				}
			} finally {
				client.close();
			}
		});
	},
);
