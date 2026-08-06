import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type * as Koffi from "koffi";
import { lockSync } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireSessionLease,
	canonicalSessionPath,
	getWindowsProcessStartId,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
	SessionAlreadyActiveError,
} from "../src/core/session-lease.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-session-lease-test-"));
	tempDirs.push(directory);
	return directory;
}

function retainWindowsProcessHandle(pid: number): () => void {
	const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
	const kernel32 = koffi.load("kernel32.dll");
	const openProcess = kernel32.func("void* __stdcall OpenProcess(uint32_t, bool, uint32_t)") as (
		access: number,
		inheritHandle: boolean,
		processId: number,
	) => unknown;
	const closeHandle = kernel32.func("bool __stdcall CloseHandle(void*)") as (handle: unknown) => boolean;
	const handle = openProcess(0x1000, false, pid);
	if (!handle) throw new Error(`Could not retain process ${pid} for test`);
	return () => {
		if (!closeHandle(handle)) throw new Error(`Could not close retained process ${pid}`);
	};
}

function enabledEnvironment(owner: string): NodeJS.ProcessEnv {
	return {
		[SESSION_LEASES_ENABLED_ENV]: "1",
		[SESSION_LEASE_OWNER_ID_ENV]: owner,
	};
}

describe("session leases", () => {
	it("reads a Windows process start identity without launching a shell", () => {
		const queriedPids: number[] = [];
		const processStartId = getWindowsProcessStartId(42, (pid) => {
			queriedPids.push(pid);
			return 638880485801234567n;
		});

		expect(processStartId).toBe("win:638880485801234567");
		expect(queriedPids).toEqual([42]);
	});

	it("rejects unavailable and invalid Windows process start identities", () => {
		let queryCount = 0;
		const query = () => {
			queryCount++;
			return undefined;
		};

		expect(getWindowsProcessStartId(42, query)).toBeUndefined();
		expect(getWindowsProcessStartId(0, query)).toBeUndefined();
		expect(queryCount).toBe(1);
	});

	it.skipIf(process.platform !== "win32")(
		"rejects an exited Windows process whose object is still retained",
		async () => {
			const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], {
				stdio: "ignore",
				windowsHide: true,
			});
			if (!child.pid) throw new Error("Could not obtain child pid");
			const release = retainWindowsProcessHandle(child.pid);
			try {
				await once(child, "exit");
				expect(getWindowsProcessStartId(child.pid)).toBeUndefined();
			} finally {
				release();
			}
		},
	);

	it("rejects a second live owner with a typed active-session error", () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		const first = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));

		expect(() => acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"))).toThrow(
			SessionAlreadyActiveError,
		);
		try {
			acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"));
		} catch (error) {
			expect(error).toMatchObject({
				code: "session_already_active",
				activeSessionId: "resident-a",
				sessionPath: canonicalSessionPath(sessionPath),
			});
		}

		first?.release();
		const second = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"));
		expect(second?.sessionPath).toBe(canonicalSessionPath(sessionPath));
		second?.release();
	});

	it("reclaims a lease whose owner process is gone", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "stale.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(
			join(lockDirectory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "stale",
				pid: 2_147_483_647,
				activeSessionId: "dead-owner",
				sessionPath,
				createdAt: new Date(0).toISOString(),
			}),
		);

		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("reports guard contention as a coordination failure", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(join(agentDir, "session.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const leaseRoot = join(agentDir, "session-leases");
		const lockDirectory = join(leaseRoot, `${key}.lock`);
		mkdirSync(leaseRoot, { recursive: true });
		const release = lockSync(lockDirectory, {
			realpath: false,
			lockfilePath: `${lockDirectory}.guard`,
			stale: 5000,
		});

		try {
			let thrown: unknown;
			try {
				acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect(thrown).not.toBeInstanceOf(SessionAlreadyActiveError);
			expect((thrown as Error).message).toContain("Could not coordinate session lease");
		} finally {
			release();
		}
	});

	it("treats symlink aliases as the same persisted session", () => {
		const agentDir = createTempDir();
		const sessionDir = join(agentDir, "sessions");
		const aliasDir = join(agentDir, "sessions-alias");
		const sessionPath = join(sessionDir, "session.jsonl");
		const aliasPath = join(aliasDir, "session.jsonl");
		mkdirSync(sessionDir);
		writeFileSync(sessionPath, "");
		symlinkSync(sessionDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
		const first = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));

		expect(() => acquireSessionLease(aliasPath, agentDir, enabledEnvironment("owned-b"))).toThrow(
			SessionAlreadyActiveError,
		);
		first?.release();
	});

	it("reclaims a lease after its pid has been reused", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "reused-pid.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(
			join(lockDirectory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "stale",
				pid: process.pid,
				processStartId: "different-process",
				activeSessionId: "old-owner",
				sessionPath,
				createdAt: new Date(0).toISOString(),
			}),
		);

		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("is inert for direct SDK runtimes unless worker isolation enables it", () => {
		const agentDir = createTempDir();
		expect(acquireSessionLease(join(agentDir, "session.jsonl"), agentDir, {})).toBeUndefined();
	});
});
