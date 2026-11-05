import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	recordDispatcherNextCheck,
	writeDispatcherHealthSource,
} from "./dispatcher-health";
import { installLaneService } from "./lane-service";
import { parseServeOptions } from "./lane-serve";
import { readDutyStatuses } from "./supervise-duty-status";
import {
	adoptRunnerLaunchAgents,
	RUNNER_PASS_GRACE_MS,
	RUNNER_RESTART_BASE_MS,
	RUNNER_RESTART_MAX_MS,
	RUNNERS_FILE,
	type RunnerChild,
	RunnerDuties,
	type RunnerDuty,
	runnerKey,
	readRunnerDuties,
	removeRunnerDuty,
	writeRunnerDuty,
} from "./supervise-runners";

const PROJECT = "66666666-6666-4666-8666-666666666666";
const runner = (extra: Partial<RunnerDuty> = {}): RunnerDuty => ({
	workspace: "fixture",
	organization: "org_fixture",
	executor: "codex",
	max: 4,
	rules: "runner-rules",
	repo: "/repo/fixture",
	coordinated: false,
	acceptProposed: false,
	enabled: true,
	...extra,
});

let config: string;
beforeEach(() => {
	config = mkdtempSync(join(tmpdir(), "tedix-runners-"));
});
afterEach(() => rmSync(config, { recursive: true, force: true }));

describe("the runners file", () => {
	test("upserts by organization and executor and removes by key", () => {
		const env = { TEDIX_CONFIG_DIR: config };
		expect(readRunnerDuties(env)).toEqual([]);
		expect(writeRunnerDuty(env, runner())).toEqual({ replaced: false });
		expect(writeRunnerDuty(env, runner({ max: 2 }))).toEqual({
			replaced: true,
		});
		expect(writeRunnerDuty(env, runner({ executor: "devin" }))).toEqual({
			replaced: false,
		});
		expect(readRunnerDuties(env).map((l) => [l.executor, l.max])).toEqual([
			["codex", 2],
			["devin", 4],
		]);
		expect(removeRunnerDuty(env, runnerKey(runner()))).toBe(true);
		expect(removeRunnerDuty(env, runnerKey(runner()))).toBe(false);
		expect(readRunnerDuties(env).map((l) => l.executor)).toEqual(["devin"]);
	});

	test("rejects a relative repo and an unknown executor instead of guessing", () => {
		const env = { TEDIX_CONFIG_DIR: config };
		writeFileSync(
			join(config, RUNNERS_FILE),
			JSON.stringify({ version: 1, runners: [runner({ repo: "relative" })] }),
		);
		expect(() => readRunnerDuties(env)).toThrow("absolute");
	});

	test("lane serve --install writes a duty and says what the supervisor will do", () => {
		const env = { TEDIX_CONFIG_DIR: config };
		const lines: string[] = [];
		const log = console.log;
		console.log = (line: string) => void lines.push(line);
		try {
			expect(
				installLaneService(
					parseServeOptions(
						[
							"--executor",
							"opencode",
							"--max",
							"3",
							"--rules",
							PROJECT,
							"--repo",
							"/repo/x",
							"--project",
							PROJECT,
							"--accept-proposed",
						],
						{ TEDIX_WORKSPACE: "fixture", TEDIX_ORGANIZATION: "org_fixture" },
					),
					env,
					false,
				),
			).toBe(0);
		} finally {
			console.log = log;
		}
		const printed = JSON.parse(lines[0]!);
		expect(printed.installed).toBe(true);
		expect(printed.supervisor).toContain("tedix supervise install");
		expect(readRunnerDuties(env)).toEqual([
			runner({
				executor: "opencode",
				max: 3,
				rules: PROJECT,
				repo: "/repo/x",
				project: PROJECT,
				acceptProposed: true,
			}),
		]);
	});
});

describe("adopting the old per-dispatcher LaunchAgents", () => {
	test("moves each lane serve agent into the file, unloads it and removes the plist", () => {
		const home = join(config, "home");
		const agents = join(home, "Library", "LaunchAgents");
		mkdirSync(agents, { recursive: true });
		const plist = (args: string[]) =>
			`<plist><dict><key>ProgramArguments</key><array>${args
				.map((a) => `<string>${a}</string>`)
				.join("")}</array></dict></plist>`;
		writeFileSync(
			join(agents, "dev.tedix.lane-serve.aaaa.plist"),
			plist([
				"/bin/tedix",
				"--organization",
				"org_fixture",
				"--workspace",
				"fixture",
				"lane",
				"serve",
				"--executor",
				"codex",
				"--max",
				"4",
				"--rules",
				"runner-rules",
				"--repo",
				"/repo/fixture",
			]),
		);
		writeFileSync(
			join(agents, "dev.tedix.lane-serve.bbbb.plist"),
			plist(["/bin/tedix", "supervise"]),
		);
		writeFileSync(
			join(agents, "dev.tedix.lane-serve.aaaa.plist.before-e74f9f0"),
			"backup",
		);
		writeFileSync(join(agents, "dev.tedix.supervisor.plist"), plist([]));
		const calls: string[][] = [];
		const result = adoptRunnerLaunchAgents(
			{ TEDIX_CONFIG_DIR: config },
			(args) => {
				calls.push(args);
				return { status: 0 };
			},
			(args) => parseServeOptions(args, {}),
			{ home, domain: "gui/501" },
		);
		expect(result.adopted).toEqual([runner()]);
		expect(result.skipped).toEqual([
			"dev.tedix.lane-serve.bbbb.plist: not a lane serve agent",
		]);
		expect(calls).toEqual([["bootout", "gui/501/dev.tedix.lane-serve.aaaa"]]);
		expect(existsSync(join(agents, "dev.tedix.lane-serve.aaaa.plist"))).toBe(
			false,
		);
		expect(existsSync(join(agents, "dev.tedix.lane-serve.bbbb.plist"))).toBe(
			true,
		);
		expect(existsSync(join(agents, "dev.tedix.supervisor.plist"))).toBe(true);
		expect(readRunnerDuties({ TEDIX_CONFIG_DIR: config })).toEqual([runner()]);
	});
});

describe("running the dispatchers", () => {
	type Fake = RunnerChild & {
		args: string[];
		exit: (code: number) => void;
		signal?: string;
	};
	function setup(identity = (_pid: number) => "fixture-process-identity") {
		const env = { TEDIX_CONFIG_DIR: config };
		let now = 1_000_000;
		let nextPid = 100;
		const spawned: Fake[] = [];
		const lines: string[] = [];
		const duties = new RunnerDuties({
			env,
			identity,
			now: () => now,
			log: (line) => lines.push(line),
			program: () => ["/bin/tedix", []],
			spawn: (_command, args) => {
				let listener: ((code: number | null) => void) | undefined;
				const child: Fake = {
					pid: nextPid++,
					args,
					onExit: (l) => {
						listener = l;
					},
					stop: (signal) => {
						child.signal = signal;
						child.exit(143);
					},
					exit: (code) => listener?.(code),
				};
				spawned.push(child);
				return child;
			},
		});
		const write = (runners: RunnerDuty[]) =>
			writeFileSync(
				join(config, RUNNERS_FILE),
				JSON.stringify({ version: 1, runners }),
			);
		return {
			env,
			duties,
			spawned,
			lines,
			write,
			advance: (ms: number) => {
				now += ms;
			},
			now: () => now,
			childFile: (l: RunnerDuty) =>
				join(config, "supervisor", "runners", `${runnerKey(l)}.json`),
		};
	}

	test("starts each enabled runner once with the lane serve arguments and records its pid", () => {
		const f = setup();
		f.write([runner(), runner({ executor: "devin", max: 2, enabled: false })]);
		f.duties.tick();
		f.duties.tick();
		expect(f.spawned).toHaveLength(1);
		expect(f.spawned[0]!.args).toEqual([
			"--organization",
			"org_fixture",
			"--workspace",
			"fixture",
			"lane",
			"serve",
			"--executor",
			"codex",
			"--max",
			"4",
			"--rules",
			"runner-rules",
			"--repo",
			"/repo/fixture",
		]);
		expect(JSON.parse(readFileSync(f.childFile(runner()), "utf8")).pid).toBe(
			100,
		);
		expect(f.duties.status()).toEqual([
			{ key: runnerKey(runner()), executor: "codex", pid: 100 },
		]);
		expect(f.lines[0]).toContain("codex started (pid 100, 4 slots)");
	});

	test("kills and immediately restarts a runner that misses its lane pass", () => {
		const f = setup();
		f.write([runner({ executor: "claude-code" })]);
		f.duties.tick();
		const directory = join(
			config,
			"dispatchers",
			runnerKey(runner({ executor: "claude-code" })),
		);
		mkdirSync(directory, { recursive: true });
		writeDispatcherHealthSource(
			directory,
			{
				scope: ["--organization", "org_fixture", "--workspace", "fixture"],
				executor: "claude-code",
				max: 4,
			},
			100,
		);
		const pass = () =>
			recordDispatcherNextCheck(
				directory,
				new Date(f.now() + 30_000).toISOString(),
				100,
			);
		// Healthy passes every 30 seconds keep it running for a long time.
		for (let i = 0; i < 20; i++) {
			pass();
			f.advance(30_000);
			f.duties.tick();
		}
		expect(f.spawned).toHaveLength(1);
		// The lane stops passing: restarted once the pass is late by the grace.
		const hungAt = f.now();
		pass();
		while (f.spawned.length === 1 && f.now() - hungAt < 10 * 60_000) {
			f.advance(30_000);
			f.duties.tick();
		}
		expect(f.spawned).toHaveLength(2);
		expect(f.now() - hungAt).toBeLessThanOrEqual(
			30_000 + RUNNER_PASS_GRACE_MS + 30_000,
		);
		expect(f.spawned[0]!.signal).toBe("SIGKILL");
		expect(f.lines.join("\n")).toContain(
			"claude-code missed its lane pass due",
		);
		expect(f.lines.join("\n")).toContain("killing pid 100 and restarting");
		expect(f.duties.status()).toEqual([
			{
				key: runnerKey(runner({ executor: "claude-code" })),
				executor: "claude-code",
				pid: 101,
			},
		]);
	});

	test("a runner that never passes since starting, e.g. waiting on a draining lock holder, is restarted", () => {
		const f = setup();
		f.write([runner()]);
		f.duties.tick();
		for (let t = 0; t < RUNNER_PASS_GRACE_MS; t += 30_000) {
			f.advance(30_000);
			f.duties.tick();
		}
		expect(f.spawned).toHaveLength(1);
		f.advance(30_000);
		f.duties.tick();
		expect(f.spawned).toHaveLength(2);
		expect(f.spawned[0]!.signal).toBe("SIGKILL");
	});

	test("a sleeping machine does not count as a missed pass", () => {
		const f = setup();
		f.write([runner()]);
		f.duties.tick();
		f.advance(60 * 60_000);
		f.duties.tick();
		f.advance(30_000);
		f.duties.tick();
		expect(f.spawned).toHaveLength(1);
	});

	test("restarts an exited runner after a doubling backoff that is capped", () => {
		const f = setup();
		f.write([runner()]);
		f.duties.tick();
		f.spawned[0]!.exit(1);
		expect(f.lines.at(-1)).toContain("codex exited (code 1); restart in 60s");
		expect(existsSync(f.childFile(runner()))).toBe(false);
		f.duties.tick();
		expect(f.spawned).toHaveLength(1);
		f.advance(RUNNER_RESTART_BASE_MS);
		f.duties.tick();
		expect(f.spawned).toHaveLength(2);
		f.spawned[1]!.exit(1);
		expect(f.lines.at(-1)).toContain("restart in 120s");
		for (let i = 0; i < 3; i++) {
			f.advance(RUNNER_RESTART_MAX_MS);
			f.duties.tick();
			f.spawned.at(-1)!.exit(1);
		}
		expect(f.lines.at(-1)).toContain(
			`restart in ${RUNNER_RESTART_MAX_MS / 1000}s`,
		);
	});

	test("stops a runner removed from the file and stops all of them with the supervisor", () => {
		const f = setup();
		f.write([runner(), runner({ executor: "devin" })]);
		f.duties.tick();
		expect(f.spawned).toHaveLength(2);
		f.write([runner({ executor: "devin" })]);
		f.duties.tick();
		expect(f.lines.at(-1)).toContain("codex removed from");
		expect(f.duties.status().map((s) => s.executor)).toEqual(["devin"]);
		f.duties.stop();
		expect(f.duties.status()).toEqual([]);
		expect(f.lines.at(-1)).toContain("devin stopping with the supervisor");
	});

	test("adopts a child that outlived the previous supervisor instead of starting a second one", () => {
		const f = setup();
		f.write([runner()]);
		mkdirSync(join(config, "supervisor", "runners"), { recursive: true });
		writeFileSync(
			f.childFile(runner()),
			JSON.stringify({
				pid: process.pid,
				startedAt: 1,
				identity: "fixture-process-identity",
			}),
		);
		f.duties.tick();
		expect(f.spawned).toHaveLength(0);
		expect(f.lines[0]).toContain(`codex adopted (pid ${process.pid})`);
		expect(f.duties.status()[0]!.pid).toBe(process.pid);
	});

	test("a live legacy or reused PID is held as unknown, never adopted or stopped", () => {
		for (const identity of [undefined, "old-process-identity"]) {
			const f = setup();
			f.write([runner()]);
			mkdirSync(join(config, "supervisor", "runners"), { recursive: true });
			writeFileSync(
				f.childFile(runner()),
				JSON.stringify({ pid: process.pid, startedAt: 1, identity }),
			);
			f.duties.tick();
			expect(f.spawned).toHaveLength(0);
			expect(f.duties.status()).toEqual([]);
			expect(readDutyStatuses(f.env)[0]?.state).toBe("unknown");
			f.duties.stop();
			expect(existsSync(f.childFile(runner()))).toBe(true);
		}
	});

	test("exit, retry and last start persist across a supervisor restart", () => {
		const f = setup();
		f.write([runner()]);
		f.duties.tick();
		f.spawned[0]!.exit(7);
		const exited = readDutyStatuses(f.env)[0]!;
		expect(exited).toMatchObject({
			state: "waiting",
			lastExitCode: 7,
			lastExecutor: "codex",
			exits: [1_000_000],
			restarts: [],
		});
		expect(exited.lastExitAt).not.toBeNull();
		expect(exited.lastRunAt).not.toBeNull();
		let starts = 0;
		const restarted = new RunnerDuties({
			env: f.env,
			now: () => 1_000_001,
			log: () => {},
			spawn: () => {
				starts++;
				throw new Error("unexpected start");
			},
		});
		restarted.tick();
		expect(starts).toBe(0);
		expect(readDutyStatuses(f.env)[0]?.retryAt).toBe(exited.retryAt);
	});

	test("an unreadable runners file is logged once and leaves running runners alone", () => {
		const f = setup();
		f.write([runner()]);
		f.duties.tick();
		writeFileSync(join(config, RUNNERS_FILE), "{not json");
		f.duties.tick();
		f.duties.tick();
		expect(f.lines.filter((l) => l.includes("not read"))).toHaveLength(1);
		expect(f.duties.status()).toHaveLength(1);
	});
});
