import type { SpawnSyncReturns } from "node:child_process";
import { expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawnSync }));

it("hides Git metadata subprocess windows", async () => {
	spawnSync.mockReturnValue({ status: 1, stdout: "" } as unknown as SpawnSyncReturns<string>);
	const { captureGitContext } = await import("../src/utils/git.js");

	expect(captureGitContext("C:\\repo")).toBeNull();
	expect(spawnSync).toHaveBeenCalledTimes(3);
	for (const call of spawnSync.mock.calls) {
		expect(call[2]).toEqual(expect.objectContaining({ windowsHide: true }));
	}
});
