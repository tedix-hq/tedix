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
import { installLaneService } from "./lane-service";
import { parseServeOptions } from "./lane-serve";
import {
	adoptLaneLaunchAgents,
	LANE_RESTART_BASE_MS,
	LANE_RESTART_MAX_MS,
	LANES_FILE,
	type LaneChild,
	LaneDuties,
	type LaneDuty,
	laneKey,
	readLaneDuties,
	removeLaneDuty,
	writeLaneDuty,
} from "./supervise-lanes";

const PROJECT = "66666666-6666-4666-8666-666666666666";
const lane = (extra: Partial<LaneDuty> = {}): LaneDuty => ({
	workspace: "fixture",
	organization: "org_fixture",
	executor: "codex",
	max: 4,
	rules: "lane-rules",
	repo: "/repo/fixture",
	coordinated: false,
	acceptProposed: false,
	enabled: true,
	...extra,
});

let config: string;
beforeEach(() => {
	config = mkdtempSync(join(tmpdir(), "tedix-lanes-"));
});
afterEach(() => rmSync(config, { recursive: true, force: true }));

describe("the lanes file", () => {
	test("upserts by organization and executor and removes by key", () => {
		const env = { TEDIX_CONFIG_DIR: config };
		expect(readLaneDuties(env)).toEqual([]);
		expect(writeLaneDuty(env, lane())).toEqual({ replaced: false });
		expect(writeLaneDuty(env, lane({ max: 2 }))).toEqual({ replaced: true });
		expect(writeLaneDuty(env, lane({ executor: "devin" }))).toEqual({
			replaced: false,
		});
		expect(readLaneDuties(env).map((l) => [l.executor, l.max])).toEqual([
			["codex", 2],
			["devin", 4],
		]);
		expect(removeLaneDuty(env, laneKey(lane()))).toBe(true);
		expect(removeLaneDuty(env, laneKey(lane()))).toBe(false);
		expect(readLaneDuties(env).map((l) => l.executor)).toEqual(["devin"]);
	});

	test("rejects a relative repo and an unknown executor instead of guessing", () => {
		const env = { TEDIX_CONFIG_DIR: config };
		writeFileSync(
			join(config, LANES_FILE),
			JSON.stringify({ version: 1, lanes: [lane({ repo: "relative" })] }),
		);
		expect(() => readLaneDuties(env)).toThrow("absolute");
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
		expect(readLaneDuties(env)).toEqual([
			lane({
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
				"lane-rules",
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
		const result = adoptLaneLaunchAgents(
			{ TEDIX_CONFIG_DIR: config },
			(args) => {
				calls.push(args);
				return { status: 0 };
			},
			(args) => parseServeOptions(args, {}),
			{ home, domain: "gui/501" },
		);
		expect(result.adopted).toEqual([lane()]);
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
		expect(readLaneDuties({ TEDIX_CONFIG_DIR: config })).toEqual([lane()]);
	});
});

describe("running the dispatchers", () => {
	type Fake = LaneChild & { args: string[]; exit: (code: number) => void };
	function setup() {
		const env = { TEDIX_CONFIG_DIR: config };
		let now = 1_000_000;
		let nextPid = 100;
		const spawned: Fake[] = [];
		const lines: string[] = [];
		const duties = new LaneDuties({
			env,
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
					stop: () => void child.exit(143),
					exit: (code) => listener?.(code),
				};
				spawned.push(child);
				return child;
			},
		});
		const write = (lanes: LaneDuty[]) =>
			writeFileSync(
				join(config, LANES_FILE),
				JSON.stringify({ version: 1, lanes }),
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
			childFile: (l: LaneDuty) =>
				join(config, "dispatchers", laneKey(l), "supervisor-child.json"),
		};
	}

	test("starts each enabled lane once with the lane serve arguments and records its pid", () => {
		const f = setup();
		f.write([lane(), lane({ executor: "devin", max: 2, enabled: false })]);
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
			"lane-rules",
			"--repo",
			"/repo/fixture",
		]);
		expect(JSON.parse(readFileSync(f.childFile(lane()), "utf8")).pid).toBe(100);
		expect(f.duties.status()).toEqual([
			{ key: laneKey(lane()), executor: "codex", pid: 100 },
		]);
		expect(f.lines[0]).toContain("codex started (pid 100, 4 slots)");
	});

	test("restarts an exited lane after a doubling backoff that is capped", () => {
		const f = setup();
		f.write([lane()]);
		f.duties.tick();
		f.spawned[0]!.exit(1);
		expect(f.lines.at(-1)).toContain("codex exited (code 1); restart in 60s");
		expect(existsSync(f.childFile(lane()))).toBe(false);
		f.duties.tick();
		expect(f.spawned).toHaveLength(1);
		f.advance(LANE_RESTART_BASE_MS);
		f.duties.tick();
		expect(f.spawned).toHaveLength(2);
		f.spawned[1]!.exit(1);
		expect(f.lines.at(-1)).toContain("restart in 120s");
		for (let i = 0; i < 3; i++) {
			f.advance(LANE_RESTART_MAX_MS);
			f.duties.tick();
			f.spawned.at(-1)!.exit(1);
		}
		expect(f.lines.at(-1)).toContain(
			`restart in ${LANE_RESTART_MAX_MS / 1000}s`,
		);
	});

	test("stops a lane removed from the file and stops all of them with the supervisor", () => {
		const f = setup();
		f.write([lane(), lane({ executor: "devin" })]);
		f.duties.tick();
		expect(f.spawned).toHaveLength(2);
		f.write([lane({ executor: "devin" })]);
		f.duties.tick();
		expect(f.lines.at(-1)).toContain("codex removed from");
		expect(f.duties.status().map((s) => s.executor)).toEqual(["devin"]);
		f.duties.stop();
		expect(f.duties.status()).toEqual([]);
		expect(f.lines.at(-1)).toContain("devin stopping with the supervisor");
	});

	test("adopts a child that outlived the previous supervisor instead of starting a second one", () => {
		const f = setup();
		f.write([lane()]);
		mkdirSync(join(config, "dispatchers", laneKey(lane())), {
			recursive: true,
		});
		writeFileSync(
			f.childFile(lane()),
			JSON.stringify({ pid: process.pid, startedAt: 1 }),
		);
		f.duties.tick();
		expect(f.spawned).toHaveLength(0);
		expect(f.lines[0]).toContain(`codex adopted (pid ${process.pid})`);
		expect(f.duties.status()[0]!.pid).toBe(process.pid);
	});

	test("an unreadable lanes file is logged once and leaves running lanes alone", () => {
		const f = setup();
		f.write([lane()]);
		f.duties.tick();
		writeFileSync(join(config, LANES_FILE), "{not json");
		f.duties.tick();
		f.duties.tick();
		expect(f.lines.filter((l) => l.includes("not read"))).toHaveLength(1);
		expect(f.duties.status()).toHaveLength(1);
	});
});
