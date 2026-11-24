/// <reference types="bun-types" />
import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startExitGuard } from "./quit-guard";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("ends a process that is still running, and only then", async () => {
	const stalled = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
	const exited = new Promise<NodeJS.Signals | null>((resolve) =>
		stalled.once("exit", (_code, signal) => resolve(signal)),
	);
	startExitGuard(stalled.pid!, 1);
	assert.equal(alive(stalled.pid!), true);
	assert.equal(await exited, "SIGKILL");
});
