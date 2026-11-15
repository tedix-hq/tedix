import { afterEach, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

it("retries a timed-out probe once and reports a second timeout as transient", () => {
	const command = fakeBinary("#!/bin/sh\nexec /bin/sleep 60\n");
	const started = Date.now();
	const probe = probeExecutorVersion(command, 200, 400);
	expect(Date.now() - started).toBeLessThan(10_000);
	expect(probe).toEqual({
		available: false,
		transient: true,
		reason: `${command} --version timed out twice (limits 200 ms, then 400 ms); the machine is busy, trying again later`,
	});
}, 15_000);

it("passes a 6-second version check on the longer second try", () => {
	const command = fakeBinary("#!/bin/sh\n/bin/sleep 6\necho 1.2.3\n");
	const probe = probeExecutorVersion(command);
	expect(probe.available).toBe(true);
	expect(probe.transient).toBeUndefined();
	expect(probe.slow).toContain(
		`${command} --version timed out at 5000 ms, then passed in`,
	);
}, 40_000);

it("does not retry a probe that fails without timing out", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-probe-test-"));
	dirs.push(dir);
	const command = fakeBinary(`#!/bin/sh\necho run >> ${dir}/runs\nexit 3\n`);
	const probe = probeExecutorVersion(command);
	expect(probe.transient).toBeUndefined();
	expect(readFileSync(join(dir, "runs"), "utf8")).toBe("run\n");
});

it("reuses a twice-timed-out probe briefly, then probes again", () => {
	let now = 1_000_000;
	let calls = 0;
	let result: ExecutorAvailability = {
		available: false,
		transient: true,
		reason: "codex --version timed out twice",
	};
	const probe = cachedExecutorProbe(
		() => {
			calls++;
			return result;
		},
		60_000,
		() => now,
		30_000,
	);
	expect(probe("codex").transient).toBe(true);
	expect(probe("codex").transient).toBe(true);
	expect(calls).toBe(1);
	now += 30_000;
	result = { available: true };
	expect(probe("codex")).toEqual({ available: true });
	expect(calls).toBe(2);
});

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
