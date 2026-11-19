import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { laneCommand } from "./lane-command";

it("reports exit failures, spawn failures and timeouts without blocking lease timers", async () => {
	expect(
		await laneCommand("/bin/sh", [
			"-c",
			"printf output; printf failure >&2; exit 3",
		]),
	).toMatchObject({ status: 3, stdout: "output", stderr: "failure" });
	expect((await laneCommand("/missing/tedix-command", [])).error?.code).toBe(
		"ENOENT",
	);
	let heartbeats = 0;
	const timer = setInterval(() => heartbeats++, 10);
	try {
		const result = await laneCommand("/bin/sleep", ["60"], {
			timeout: 100,
			killSignal: "SIGKILL",
		});
		expect(result.status).toBeNull();
		expect(result.error?.code).toBe("ETIMEDOUT");
		expect(heartbeats).toBeGreaterThan(0);
	} finally {
		clearInterval(timer);
	}
});

it.each([
	"lane-serve",
	"lane-run",
	"lane-command",
	"lane-executor-probe",
	"lane-budget",
	"lane-result",
	"lane-local-branch-proof",
	"devin-lane-thread",
	"devin-lane-security",
	"update",
])("keeps synchronous child-process APIs out of %s", (module) => {
	const source = readFileSync(
		new URL(`./${module}.ts`, import.meta.url),
		"utf8",
	);
	expect(source).not.toMatch(/\b(?:execFileSync|execSync|spawnSync)\b/);
});

it("keeps signal exits and buffer failures distinct from timeouts", async () => {
	const signal = await laneCommand("/bin/sh", ["-c", "kill -TERM $$"]);
	expect(signal.signal).toBe("SIGTERM");
	expect(signal.error).toBeUndefined();
	const overflow = await laneCommand(
		process.execPath,
		["-e", "console.log('x'.repeat(2000))"],
		{ maxBuffer: 100 },
	);
	expect(overflow.status).toBeNull();
	expect(overflow.error?.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
});

it("closes probe stdin so a command can finish on EOF", async () => {
	expect(await laneCommand("/bin/cat", [], { timeout: 1000 })).toMatchObject({
		status: 0,
		stdout: "",
	});
});
