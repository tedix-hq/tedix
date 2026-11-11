import { afterEach, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cachedExecutorProbe,
	executorBinary,
	probeExecutorVersion,
} from "./lane-executor-probe";
import type { ExecutorAvailability } from "./lane-routing";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fakeBinary(body: string, name = "codex") {
	const dir = mkdtempSync(join(tmpdir(), "lane-probe-test-"));
	dirs.push(dir);
	const path = join(dir, name);
	writeFileSync(path, body);
	chmodSync(path, 0o700);
	return path;
}

it("maps each executor to the binary the lane probes", () => {
	expect(executorBinary("claude-code")).toBe("claude");
	expect(executorBinary("codex")).toBe("codex");
	expect(executorBinary("opencode")).toBe("opencode");
	expect(executorBinary("devin")).toBe("devin");
});

it("names the exit status and elapsed time when the version probe fails", () => {
	const command = fakeBinary("#!/bin/sh\nexit 3\n");
	const probe = probeExecutorVersion(command);
	expect(probe.available).toBe(false);
	expect(probe.reason).toContain(`${command} --version exited 3 after`);
	expect(probe.reason).toContain("ms");
});

it("counts a probe that outruns its timeout as timed out, not as a crash", () => {
	const command = fakeBinary("#!/bin/sh\nexec /bin/sleep 60\n");
	const started = Date.now();
	const probe = probeExecutorVersion(command, 200);
	expect(Date.now() - started).toBeLessThan(10_000);
	expect(probe.available).toBe(false);
	expect(probe.reason).toContain(`${command} --version timed out after`);
	expect(probe.reason).toContain("(limit 200 ms)");
}, 15_000);

it("names a missing binary instead of reporting a nonzero exit", () => {
	const probe = probeExecutorVersion("/definitely/missing/executor");
	expect(probe.available).toBe(false);
	expect(probe.reason).toContain("failed to start");
	expect(probe.reason).toContain("ENOENT");
});

it("reports available for a passing --version probe", () => {
	const command = fakeBinary("#!/bin/sh\necho 1.2.3\n");
	expect(probeExecutorVersion(command)).toEqual({ available: true });
});

it("reuses a passing probe for its cache window and never caches a failure", () => {
	let now = 1_000_000;
	let calls = 0;
	let result: ExecutorAvailability = { available: true };
	const probe = cachedExecutorProbe(
		() => {
			calls++;
			return result;
		},
		60_000,
		() => now,
	);
	expect(probe("codex").available).toBe(true);
	expect(probe("codex").available).toBe(true);
	expect(calls).toBe(1);
	// Each executor's probe is cached on its own.
	expect(probe("devin").available).toBe(true);
	expect(calls).toBe(2);
	// Inside the window no new probe runs, so a transient failure cannot drop
	// the executor.
	result = { available: false, reason: "probe timed out" };
	expect(probe("codex").available).toBe(true);
	expect(calls).toBe(2);
	// Past the window the probe runs again; a failure is never cached, so the
	// next pass probes once more.
	now += 60_000;
	expect(probe("codex").available).toBe(false);
	expect(probe("codex").available).toBe(false);
	expect(calls).toBe(4);
	// Devin's window expired at the same instant.
	expect(probe("devin").available).toBe(false);
	expect(calls).toBe(5);
});
