import { afterEach, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cachedExecutorPreflight } from "./lane-executor-preflight";
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

it("names the exit status and elapsed time when the version probe fails", async () => {
	const command = fakeBinary("#!/bin/sh\nexit 3\n");
	const probe = await probeExecutorVersion(command);
	expect(probe.available).toBe(false);
	expect(probe.reason).toContain(`${command} --version exited 3 after`);
	expect(probe.reason).toContain("ms");
});

it("retries a timed-out probe once and reports a second timeout as transient", async () => {
	const command = fakeBinary("#!/bin/sh\nexec /bin/sleep 60\n");
	const started = Date.now();
	const probe = await probeExecutorVersion(command, 200, 400);
	expect(Date.now() - started).toBeLessThan(10_000);
	expect(probe).toEqual({
		available: false,
		transient: true,
		reason: `${command} --version timed out twice (limits 200 ms, then 400 ms); the machine is busy, trying again later`,
	});
}, 15_000);

it("accepts a version probe that fits only the retry budget", async () => {
	const command = fakeBinary("#!/bin/sh\n/bin/sleep 0.4\necho 1.2.3\n");
	const probe = await probeExecutorVersion(command, 100, 2_000);
	expect(probe.available).toBe(true);
	expect(probe.slow).toContain(
		`${command} --version timed out at 100 ms, then passed in`,
	);
});

it("does not retry a probe that fails without timing out", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-probe-test-"));
	dirs.push(dir);
	const command = fakeBinary(`#!/bin/sh\necho run >> ${dir}/runs\nexit 3\n`);
	const probe = await probeExecutorVersion(command);
	expect(probe.transient).toBeUndefined();
	expect(readFileSync(join(dir, "runs"), "utf8")).toBe("run\n");
});

it("reuses a twice-timed-out probe briefly, then probes again", async () => {
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
	expect((await probe("codex")).transient).toBe(true);
	expect((await probe("codex")).transient).toBe(true);
	expect(calls).toBe(1);
	now += 30_000;
	result = { available: true };
	expect(await probe("codex")).toEqual({ available: true });
	expect(calls).toBe(2);
});

it("names a missing binary instead of reporting a nonzero exit", async () => {
	const probe = await probeExecutorVersion("/definitely/missing/executor");
	expect(probe.available).toBe(false);
	expect(probe.reason).toContain("failed to start");
	expect(probe.reason).toContain("ENOENT");
});

it("reports available for a passing --version probe", async () => {
	const command = fakeBinary("#!/bin/sh\necho 1.2.3\n");
	expect(await probeExecutorVersion(command)).toEqual({ available: true });
});

it("reuses a passing probe for its cache window and never caches a failure", async () => {
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
	expect((await probe("codex")).available).toBe(true);
	expect((await probe("codex")).available).toBe(true);
	expect(calls).toBe(1);
	// Each executor's probe is cached on its own.
	expect((await probe("devin")).available).toBe(true);
	expect(calls).toBe(2);
	// Inside the window no new probe runs, so a transient failure cannot drop
	// the executor.
	result = { available: false, reason: "probe timed out" };
	expect((await probe("codex")).available).toBe(true);
	expect(calls).toBe(2);
	// Past the window the probe runs again; a failure is never cached, so the
	// next pass probes once more.
	now += 60_000;
	expect((await probe("codex")).available).toBe(false);
	expect((await probe("codex")).available).toBe(false);
	expect(calls).toBe(4);
	// Devin's window expired at the same instant.
	expect((await probe("devin")).available).toBe(false);
	expect(calls).toBe(5);
});

it("shares a pending version probe and leaves heartbeat timers free", async () => {
	const command = fakeBinary("#!/bin/sh\nexec /bin/sleep 0.2\n");
	let calls = 0;
	let heartbeats = 0;
	const timer = setInterval(() => heartbeats++, 10);
	const probe = cachedExecutorProbe(() => {
		calls++;
		return probeExecutorVersion(command);
	});
	try {
		expect(await Promise.all([probe("codex"), probe("codex")])).toEqual([
			{ available: true },
			{ available: true },
		]);
		expect(calls).toBe(1);
		expect(heartbeats).toBeGreaterThan(0);
	} finally {
		clearInterval(timer);
	}
});

it("uses the Codex network report even when Doctor exits successfully", async () => {
	const command = fakeBinary(`#!/bin/sh
[ "$*" = "doctor --network-only --json" ] || exit 1
echo '{"overallStatus":"fail","checks":{"network.websocket_reachability":{"id":"network.websocket_reachability","status":"fail","summary":"handshake failed"}}}'
`);
	const path = process.env.PATH;
	try {
		process.env.PATH = `${dirname(command)}:${path}`;
		const probe = cachedExecutorPreflight(dirname(command), () => {});
		expect(await probe("codex")).toBe(
			"network.websocket_reachability: handshake failed",
		);
	} finally {
		process.env.PATH = path;
	}
});

it.each([
	[
		{ plugin_errors: [{ plugin: "review", type: "load-failed" }] },
		"Claude reported a plugin error (review: load-failed)",
	],
	[
		{ mcp_server_errors: [{ name: "search", type: "invalid_config" }] },
		"Claude reported an MCP configuration error (search: invalid_config)",
	],
	[{ mcp_servers: [{ name: "search", status: "needs-auth" }] }, undefined],
	[
		{ signedIn: false },
		"Claude Code is not signed in; run `claude` and sign in",
	],
])(
	"uses Claude's sign-in and init event to report failures for %p",
	async ({ signedIn = true, ...fields }: Record<string, unknown>, reason) => {
		const init = JSON.stringify({
			type: "system",
			subtype: "init",
			mcp_servers: [],
			...fields,
		});
		const command = fakeBinary(
			`#!/bin/sh
if [ "$1" = auth ]; then echo '{"loggedIn":${signedIn}}'; exit 0; fi
echo '{"type":"system","subtype":"hook_response"}'
echo '${init}'
exec /bin/sleep 60
`,
			"claude",
		);
		const path = process.env.PATH;
		try {
			process.env.PATH = `${dirname(command)}:${path}`;
			const probe = cachedExecutorPreflight(dirname(command), () => {});
			expect(await probe("claude-code")).toBe(reason);
		} finally {
			process.env.PATH = path;
		}
	},
);
