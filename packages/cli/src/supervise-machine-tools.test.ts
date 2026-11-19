import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineToolsDuty } from "./supervise-machine-tools";
import {
	RUNNER_RESTART_BASE_MS,
	RUNNER_UPDATE_EXIT_CODE,
	RUNNERS_FILE,
	type RunnerChild,
} from "./supervise-runners";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("the supervisor keeps one machine tools process, started as the codex runner signs in, and restarts it", () => {
	const config = mkdtempSync(join(tmpdir(), "tedix-machine-tools-duty-"));
	roots.push(config);
	const runner = (executor: string, enabled = true) => ({
		workspace: "acme",
		organization: "org-1",
		executor,
		rules: "lane-rules",
		repo: "/repo",
		enabled,
	});
	const write = (runners: unknown[]) =>
		writeFileSync(
			join(config, RUNNERS_FILE),
			JSON.stringify({ version: 1, runners }),
		);
	write([runner("claude-code"), runner("codex")]);
	let now = 1_000_000;
	const spawned: {
		args: string[];
		exit: (code: number) => void;
		signal?: string;
	}[] = [];
	const duty = new MachineToolsDuty({
		env: { TEDIX_CONFIG_DIR: config },
		now: () => now,
		log: () => {},
		program: () => ["/bin/tedix", []],
		spawn: (_command, args) => {
			let listener: ((code: number | null) => void) | undefined;
			const child: RunnerChild & (typeof spawned)[number] = {
				pid: 100 + spawned.length,
				args,
				onExit: (l) => {
					listener = l;
				},
				stop: (signal) => {
					child.signal = signal;
				},
				exit: (code) => listener?.(code),
			};
			spawned.push(child);
			return child;
		},
	});

	duty.tick();
	duty.tick();
	expect(spawned).toHaveLength(1);
	expect(spawned[0]!.args).toEqual([
		"--organization",
		"org-1",
		"--workspace",
		"acme",
		"lane",
		"serve",
		"--executor",
		"codex",
		"--rules",
		"lane-rules",
		"--repo",
		"/repo",
		"--machine-tools-only",
	]);

	// A crash waits out the backoff; leaving for an update does not.
	spawned[0]!.exit(1);
	duty.tick();
	expect(spawned).toHaveLength(1);
	now += RUNNER_RESTART_BASE_MS;
	duty.tick();
	expect(spawned).toHaveLength(2);
	now += RUNNER_RESTART_BASE_MS;
	spawned[1]!.exit(RUNNER_UPDATE_EXIT_CODE);
	duty.tick();
	expect(spawned).toHaveLength(3);

	// No enabled runner: nothing on this machine answers, so it is stopped.
	write([runner("claude-code", false), runner("codex", false)]);
	duty.tick();
	expect(spawned[2]!.signal).toBe("SIGTERM");
	expect(spawned).toHaveLength(3);
});
