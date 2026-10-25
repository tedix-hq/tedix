import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	LaneDispatcher,
	LaneCommitFetchError,
	laneFailureSignature,
	provisionLaneWorktree,
	landedLaneCommits,
	mergeDispatcherReceipts,
	retainedLaneWorktree,
	dispatchSkip,
	parseServeOptions,
	proposedAcceptance,
	serialCalls,
	cooldownGraceMs,
	type DispatchItem,
	type ServeOptions,
} from "./lane-serve";
import { laneServicePlist } from "./lane-service";
import { laneChildEnv } from "./lane-child-env";
import { CliReadError } from "./hooks/hook-io";

const projectId = "11111111-1111-4111-8111-111111111111";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const item = (n = 1): DispatchItem => ({
	id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
	title: "Summarize the guide",
	workKind: "research",
	description: "Write a paragraph as a Work comment.",
	disposition: "accepted",
	startAt: null,
	acceptanceContract: {
		version: 1,
		doneLooksLike: "A paragraph is recorded as a Work comment.",
	},
	projectId,
	version: 2,
	metadata: { executor: "codex" },
	accountableOwnerType: "user",
	accountableOwnerId: "fictional-owner",
});
const options: ServeOptions = {
	executor: "codex",
	coordinated: false,
	acceptProposed: false,
	max: 2,
	project: projectId,
	rules: projectId,
	repo: "/fictional/repo",
	scope: ["--workspace", "acme", "--organization", "org_acme"],
	once: true,
	install: false,
};
function fixture({
	refuse = false,
	dark = false,
	failSettle = false,
	devinReady = true,
	executor = "codex" as ServeOptions["executor"],
	coordinated = false,
	acceptProposed = false,
	proposed = [] as DispatchItem[],
} = {}) {
	const dir = mkdtempSync(join(tmpdir(), "lane-dispatch-test-"));
	dirs.push(dir);
	const items = [item(1), item(2), item(3)].map((row) => ({
		...row,
		metadata: {
			executor:
				executor === "any-local"
					? row.id === item(1).id
						? "claude-code"
						: "codex"
					: executor,
			...(coordinated && row.id === item(1).id
				? { laneDispatch: { state: "ready" } }
				: {}),
		},
	}));
	const events: Array<{
		verb: string;
		args: string[];
		env: NodeJS.ProcessEnv;
		input?: Record<string, unknown>;
	}> = [];
	const releases: Array<() => void> = [];
	const control = {
		spawnPid: undefined as number | undefined,
		telemetryOutcome: "succeeded" as "succeeded" | "stopped",
		provisionError: undefined as Error | undefined,
		commits: [] as string[],
		cleanups: 0,
		proofError: undefined as Error | undefined,
		startError: refuse
			? new CliReadError("Admission refused: resource capacity", "CONFLICT")
			: (undefined as Error | undefined),
		readiness: { ready: true, reasons: [] as Array<{ detail: string }> },
		cooldownUntil: 0,
		cooldownWorkspaces: [] as Array<string | undefined>,
		history: {
			data: [] as Record<string, unknown>[],
			nextCursor: null as string | null,
		},
	};
	let threadNumber = 0;
	const config = { ...options, executor, coordinated, acceptProposed };
	const deps: NonNullable<ConstructorParameters<typeof LaneDispatcher>[2]> = {
		darkWake: () => dark,
		gatewayCooldownUntil: (workspace) => {
			control.cooldownWorkspaces.push(workspace);
			return control.cooldownUntil;
		},
		available: () => true,
		budgets: () => ({}),
		devinAvailable: () => devinReady,
		provision: (_source, destination) => {
			if (control.provisionError) throw control.provisionError;
			return destination;
		},
		baseCommit: () => "a".repeat(40),
		landedCommits: async () => {
			if (control.proofError) throw control.proofError;
			return control.commits;
		},
		cleanup: () => {
			control.cleanups++;
			return true;
		},
		thread: async () => ({
			thread: {
				id: `33333333-3333-4333-8333-${String(++threadNumber).padStart(12, "0")}`,
				cliVersion: "1.2.3",
				path: "/fictional/transcript",
			},
			model: "test-model",
			modelProvider: "test-provider",
		}),
		cli: async <T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> => {
			const verb = args[5]!;
			const inputIndex = args.indexOf("--input");
			const input =
				inputIndex < 0 ? undefined : JSON.parse(args[inputIndex + 1]!);
			events.push({ verb, args, env, input });
			if (verb === "dispatch-list" && input.disposition !== "proposed")
				expect(input.dispatchReadyOnly).toBe(true);
			let response: unknown;
			if (verb === "dispatch-list" && input.disposition === "proposed")
				response = { data: proposed, pagination: { hasMore: false } };
			else if (verb === "dispatch-list")
				response = { data: items, pagination: { hasMore: false } };
			else if (verb === "dispatch-get")
				response = {
					workItem: items.find((row) => row.id === args[6]),
					comments: [],
				};
			else if (verb === "dispatch-attempts") response = control.history;
			else if (verb === "readiness") response = control.readiness;
			else if (verb === "show")
				response = {
					id: options.rules,
					revision: 7,
					content: "Keep all evidence in OS.",
					lifecycleState: "active",
				};
			else if (verb === "start" && args[4] === "agent")
				response = { principalKey: "local-acme" };
			else if (verb === "start") {
				if (control.startError) throw control.startError;
				response = {
					workItem: items.find((row) => row.id === args[6]),
					attempt: {
						id: "fictional-attempt",
						expiresAt: new Date(Date.now() + 300000).toISOString(),
					},
				};
			} else if (verb === "settle" && failSettle)
				throw new Error("Transient settlement failure");
			else response = {};
			return response as T;
		},
		launch: async (args, deps) => {
			const nativeExecutor =
				args[args.indexOf("--executor") + 1] === "devin"
					? "devin"
					: args[args.indexOf("--executor") + 1] === "claude-code"
						? "claude-code"
						: "codex";
			const brief = readFileSync(args[args.indexOf("--brief") + 1]!, "utf8");
			expect(deps?.cwd).toBe(
				join(dirname(args[args.indexOf("--brief") + 1]!), "repo"),
			);
			expect(args.slice(args.indexOf("--") + 1)).toEqual(
				nativeExecutor === "devin"
					? ["devin"]
					: nativeExecutor === "claude-code"
						? [
								"claude",
								"-p",
								"--session-id",
								expect.any(String),
								"--output-format",
								"stream-json",
								"--verbose",
							]
						: [
								"codex",
								"exec",
								"-C",
								join(dirname(args[args.indexOf("--brief") + 1]!), "repo"),
								"resume",
								expect.any(String),
								"-o",
								expect.any(String),
								"-",
							],
			);
			expect(brief).toContain("revision 7");
			expect(brief).toContain("Keep all evidence in OS.");
			expect(brief).toContain("already holds Attempt");
			// One trailer paragraph with this lane's exact ids, so the pre-push
			// secret scan accepts the lane's commits.
			expect(brief).toMatch(
				new RegExp(
					`\\nWork-Item: [0-9a-f-]{36}\\nAgent-Session: ${nativeExecutor}:\\S+\\n`,
				),
			);
			expect(brief).toContain("Do not pass one -m per trailer");
			if (control.spawnPid) deps?.onSpawn?.(control.spawnPid);
			await new Promise<void>((done) => releases.push(done));
			deps?.onTelemetry?.({
				executor: nativeExecutor,
				model: "test-model",
				provider: "test-provider",
				reasoningEffort: null,
				brief: "test",
				startedAt: "2026-10-01T00:00:00.000Z",
				heartbeatAt: "2026-10-01T00:00:01.000Z",
				finishedAt: "2026-10-01T00:00:01.000Z",
				outcome: control.telemetryOutcome,
				finalMessage: "Result recorded in OS.",
				tools: {},
				usage: { input: 100, cached: 40, output: 30, reasoning: 10 },
				shas: [],
				workItems: [],
				corrections: [],
				source: "wrapper",
			});
			return 0;
		},
	};
	const restart = () => new LaneDispatcher(config, dir, deps);
	const dispatcher = restart();
	return { dispatcher, restart, dir, events, releases, control, items };
}
async function until(test: () => boolean) {
	for (let n = 0; n < 100 && !test(); n++)
		await new Promise((done) => setTimeout(done, 2));
	expect(test()).toBe(true);
}

describe("dispatcher admission", () => {
	it.each(["late timer", "lease expiry", "stopped telemetry"])(
		"records the child outcome after %s",
		async (scenario) => {
			let now = 1_800_000_000_000;
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			let leaseCheck!: () => void;
			const timer = spyOn(globalThis, "setInterval").mockImplementation(((
				callback: () => void,
				ms: number,
			) => {
				if (ms === 1000) leaseCheck = callback;
				return setTimeout(() => {}, 60_000);
			}) as typeof setInterval);
			const kill = spyOn(process, "kill").mockReturnValue(true);
			const { dispatcher, items, control, releases, events, dir } = fixture();
			items.splice(1);
			control.spawnPid = 999999;
			if (scenario === "stopped telemetry")
				control.telemetryOutcome = "stopped";
			try {
				await dispatcher.tick();
				await until(() => releases.length === 1);
				if (scenario === "lease expiry") {
					for (let tick = 0; tick < 10; tick++) {
						now += 30_000;
						leaseCheck();
					}
				} else {
					now += scenario === "late timer" ? 31_001 : 1000;
					leaseCheck();
				}
				if (scenario === "lease expiry")
					expect(kill).toHaveBeenCalledWith(-control.spawnPid, "SIGTERM");
				else
					expect(kill).not.toHaveBeenCalledWith(-control.spawnPid, "SIGTERM");
				releases[0]!();
				await dispatcher.drain();
				const outcome = scenario === "late timer" ? "succeeded" : "expired";
				const receipt = JSON.parse(
					readFileSync(join(dir, `${item().id}-2.json`), "utf8"),
				);
				expect(receipt.outcome).toBe(outcome);
				if (scenario === "late timer") {
					expect(receipt.interrupted).not.toBe(true);
					expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
						'"event":"lease-check-delayed"',
					);
				} else expect(receipt.interrupted).toBe(true);
				const settlement = events.find(
					(event) => event.verb === "settle",
				)!.args;
				expect(settlement[settlement.indexOf("--outcome") + 1]).toBe(outcome);
			} finally {
				for (const release of releases) release();
				await dispatcher.drain();
				kill.mockRestore();
				timer.mockRestore();
				clock.mockRestore();
			}
		},
	);
	it("bounds failures with exponential backoff and opens a new retry window after its deadline", async () => {
		let now = 1_800_000_000_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const { dispatcher, items, control, dir, events } = fixture();
		items.splice(1);
		const path = join(dir, `${item().id}-2.json`);
		const deadline = now + 30 * 60_000;
		try {
			// Distinct failures exercise retries without triggering the identical-failure hold.
			for (const [index, reason] of [
				"capacity",
				"executor",
				"policy",
				"budget",
				"dependency",
			].entries()) {
				control.startError = new CliReadError(
					`Admission refused: ${reason}`,
					"CONFLICT",
				);
				await dispatcher.tick();
				await dispatcher.drain();
				const saved = JSON.parse(readFileSync(path, "utf8"));
				expect(saved.retries).toBe(index + 1);
				expect(saved.held).toBe(false);
				expect(saved.retryDeadlineAt).toBe(deadline);
				expect(saved.retryAt).toBe(
					index === 4 ? deadline : now + 60_000 * 2 ** index,
				);
				now = saved.retryAt - 1;
				await dispatcher.tick();
				await dispatcher.drain();
				expect(
					events.filter((e) => e.verb === "start" && e.input),
				).toHaveLength(index + 1);
				now++;
			}
			control.startError = new CliReadError(
				"Admission refused: offline",
				"CONFLICT",
			);
			await dispatcher.tick();
			await dispatcher.drain();
			expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
				6,
			);
			expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
				retries: 1,
				retryAt: deadline + 60_000,
				retryDeadlineAt: deadline + 30 * 60_000,
			});
		} finally {
			clock.mockRestore();
		}
	});
	it("admits and settles Devin through the same dispatcher", async () => {
		const { dispatcher, events, releases } = fixture({ executor: "devin" });
		await dispatcher.tick();
		await until(() => releases.length === 2);
		expect(
			events.find((event) => event.verb === "start")?.env.TEDIX_AGENT_SESSION,
		).toStartWith("devin:");
		for (const release of releases) release();
		await dispatcher.drain();
		expect(events.filter((event) => event.verb === "settle")).toHaveLength(2);
	});
	it("leaves logged-out Devin work unclaimed for a later tick", async () => {
		const { dispatcher, events, releases } = fixture({
			executor: "devin",
			devinReady: false,
		});
		await dispatcher.tick();
		await dispatcher.drain();
		expect(releases).toHaveLength(0);
		expect(events.some((event) => event.verb === "start")).toBe(false);
	});
	it("admits only explicit server selections when serving coordinated Work across projects", async () => {
		const { dispatcher, events, releases } = fixture({ coordinated: true });
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		expect(events.filter((e) => e.verb === "settle")).toHaveLength(1);
		expect(
			dispatchSkip(
				{
					...item(),
					metadata: { executor: "codex", laneDispatch: { state: "held" } },
				},
				[],
				"codex",
				true,
			),
		).toContain("no ready");
		expect(dispatchSkip(item(), [], "codex", false)).toBeUndefined();
	});
	it("accepts only shift-assigned proposals with a Done when section when asked to", async () => {
		const shift = {
			...item(7),
			disposition: "proposed" as const,
			description:
				"Full suite hourly is red.\n\n## Done when\nFull suite hourly is green again on main.\n",
		};
		const bare = { ...item(8), disposition: "proposed" as const };
		const other = {
			...shift,
			id: item(9).id,
			metadata: { executor: "devin" },
		};
		expect(proposedAcceptance(shift, "codex")).toBe(
			"Full suite hourly is green again on main.",
		);
		expect(proposedAcceptance(bare, "codex")).toBeUndefined();
		expect(proposedAcceptance(other, "codex")).toBeUndefined();
		expect(proposedAcceptance(other, "any-local")).toBe(
			"Full suite hourly is green again on main.",
		);
		expect(proposedAcceptance(item(), "codex")).toBeUndefined();
		const silent = fixture({ proposed: [shift, bare, other] });
		await silent.dispatcher.tick();
		await until(() => silent.releases.length === 2);
		for (const release of silent.releases) release();
		await silent.dispatcher.drain();
		expect(silent.events.some((e) => e.verb === "accept")).toBe(false);
		const { dispatcher, events, releases } = fixture({
			acceptProposed: true,
			proposed: [shift, bare, other],
		});
		await dispatcher.tick();
		await until(() => releases.length === 2);
		for (const release of releases) release();
		await dispatcher.drain();
		const accepts = events.filter((e) => e.verb === "accept");
		expect(accepts).toHaveLength(1);
		expect(accepts[0]!.args.slice(6)).toEqual([
			shift.id,
			"--done-when",
			"Full suite hourly is green again on main.",
		]);
		expect(accepts[0]!.env.TEDIX_AGENT_SESSION).toBeUndefined();
		expect(() =>
			parseServeOptions(["--executor", "codex", "--accept-proposed"], {
				TEDIX_WORKSPACE: "acme",
				TEDIX_ORGANIZATION: "org_acme",
			} as never),
		).toThrow("--accept-proposed requires --project");
	});
	it("admits the native Claude identity before launch and settles through the same dispatcher", async () => {
		const { dispatcher, events, releases } = fixture({
			executor: "claude-code",
		});
		await dispatcher.tick();
		await until(() => releases.length === 2);
		const bootstrap = events.filter((e) => e.verb === "start" && !e.input);
		expect(bootstrap[0]?.env.TEDIX_AGENT_SESSION).toMatch(
			/^claude-code:33333333/,
		);
		expect(
			events.find((e) => e.verb === "dispatch-list")?.input?.executor,
		).toBe("claude-code");
		for (const release of releases) release();
		await dispatcher.drain();
		expect(events.filter((e) => e.verb === "settle")).toHaveLength(2);
	});
	it("counts a retained live process group against capacity after restart", async () => {
		const child = spawn(
			process.execPath,
			["-e", "setTimeout(() => {}, 30000)"],
			{ detached: true, stdio: "ignore" },
		);
		await once(child, "spawn");
		const { dispatcher, dir, releases } = fixture();
		writeFileSync(
			join(dir, `${item(1).id}-2.json`),
			JSON.stringify({
				itemId: item(1).id,
				version: 2,
				phase: "running",
				pid: child.pid,
			}),
		);
		try {
			await dispatcher.tick();
			await until(() => releases.length === 1);
			await dispatcher.tick();
			expect(releases).toHaveLength(1);
			releases[0]!();
			await dispatcher.drain();
		} finally {
			const exited = once(child, "exit");
			process.kill(-child.pid!, "SIGTERM");
			await exited;
		}
	});
	it("runs at most N, claims the native child before launch and persists settlement", async () => {
		const { dispatcher, events, releases, dir } = fixture();
		await dispatcher.tick();
		await until(() => releases.length === 2);
		await dispatcher.tick();
		expect(releases).toHaveLength(2);
		const starts = events.filter(
			(event) => event.verb === "start" && event.input,
		);
		expect(starts).toHaveLength(2);
		expect(starts[0]!.env.TEDIX_AGENT_SESSION).toMatch(/^codex:33333333/);
		expect(starts[0]!.env.TEDIX_EXTERNAL_AGENT).toBe("local-acme");
		expect(starts[0]!.input).toMatchObject({
			metadata: { dispatchVersion: 2, rulesRevision: 7 },
		});
		for (const release of releases) release();
		await dispatcher.drain();
		expect(events.filter((event) => event.verb === "settle")).toHaveLength(2);
		expect(
			events.find((event) => event.verb === "settle")!.input,
		).toMatchObject({
			metadata: {
				usage: { input: 100, cached: 40, output: 30, reasoning: 10 },
			},
		});
		expect(
			JSON.parse(readFileSync(join(dir, `${item(1).id}-2.json`), "utf8")).phase,
		).toBe("settled");
		await dispatcher.tick();
		await until(() => releases.length === 3);
		releases[2]!();
		await dispatcher.drain();
	});
	it("preserves rejection diagnostics once and retries only after backoff and fresh admission", async () => {
		const { dispatcher, releases, events, dir, control, items } = fixture({
			refuse: true,
		});
		items.splice(1);
		await dispatcher.tick();
		await dispatcher.drain();
		const path = join(dir, `${item().id}-2.json`);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved).toMatchObject({
			phase: "deferred",
			retries: 1,
			admissionFailure: "Error: Admission refused: resource capacity",
			admissionState: "rejected",
			identicalFailures: 1,
		});
		expect(saved.retryAt).toBeGreaterThan(Date.now() + 55_000);
		expect(events.filter((e) => e.verb === "comment")).toHaveLength(0);
		await dispatcher.tick();
		await dispatcher.drain();
		expect(releases).toHaveLength(0);
		expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(1);
		saved.retryAt = 0;
		writeFileSync(path, JSON.stringify(saved));
		control.startError = undefined;
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(2);
		expect(events.filter((e) => e.verb === "comment")).toHaveLength(0);
		expect(events.filter((e) => e.verb === "dispatch-attempts")).toHaveLength(
			2,
		);
	});
	it("holds matching failures despite changing request diagnostics", async () => {
		const { dispatcher, dir, items, events, control } = fixture();
		items.splice(1);
		const path = join(dir, `${item().id}-2.json`);
		for (let n = 1; n <= 3; n++) {
			control.startError = new CliReadError(
				`Admission refused requestId=req-${n} traceId=${String(n).repeat(32)} at 2026-10-21T17:00:0${n}.123Z attempt ${n}`,
				"CONFLICT",
			);
			await dispatcher.tick();
			await dispatcher.drain();
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.identicalFailures).toBe(n);
			expect(saved.note).toContain(`requestId=req-${n}`);
			saved.retryAt = 0;
			saved.retryDeadlineAt = 0;
			writeFileSync(path, JSON.stringify(saved));
		}
		expect(JSON.parse(readFileSync(path, "utf8")).held).toBe(true);
		expect(events.filter((e) => e.verb === "comment")).toHaveLength(1);
	});
	it.each(["recovered", "offline", "expired", "foreign", "settled"])(
		"retains offline proof until %s without relaunching",
		async (state) => {
			const { dispatcher, restart, dir, items, events, releases, control } =
				fixture();
			items.splice(1);
			items[0]!.workKind = "coding";
			control.proofError = new LaneCommitFetchError("offline");
			await dispatcher.tick();
			await until(() => releases.length === 1);
			releases[0]!();
			await dispatcher.drain();
			const path = join(dir, `${item().id}-2.json`);
			let saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved).toMatchObject({
				phase: "settling",
				outcome: "succeeded",
				attemptId: "fictional-attempt",
				pendingCommitProof: "Result recorded in OS.",
			});
			expect(events.filter((e) => e.verb === "settle")).toHaveLength(0);
			expect(control.cleanups).toBe(0);
			control.history.data = [
				{
					id: saved.attemptId,
					externalSessionKey:
						state === "foreign" ? "codex:foreign" : saved.session,
					outcome: state === "settled" ? "succeeded" : null,
					expiresAt: new Date(
						Date.now() + (state === "expired" ? -300000 : 300000),
					).toISOString(),
				},
			];
			if (state === "recovered") {
				control.proofError = undefined;
				control.commits = ["b".repeat(40)];
			}
			for (let n = 0; n < (state === "offline" ? 6 : 1); n++) {
				saved.retryAt = 0;
				writeFileSync(path, JSON.stringify(saved));
				const recovering = restart();
				if (state === "foreign")
					await expect(recovering.tick()).rejects.toThrow("fence");
				else await recovering.tick();
				saved = JSON.parse(readFileSync(path, "utf8"));
			}
			expect(releases).toHaveLength(1);
			expect(events.filter((e) => e.verb === "settle")).toHaveLength(
				state === "recovered" ? 1 : 0,
			);
			expect(events.filter((e) => e.verb === "heartbeat")).toHaveLength(
				state === "offline" ? 7 : state === "recovered" ? 2 : 1,
			);
			if (state === "recovered") {
				expect(saved.phase).toBe("settled");
				expect(saved.commits).toEqual(control.commits);
				expect(saved.pendingCommitProof).toBeUndefined();
				expect(control.cleanups).toBe(1);
			}
			if (state === "offline") expect(saved.retries).toBe(0);
		},
	);
	it.each(["admission", "provision"])(
		"holds three identical %s failures across restarts until revision changes",
		async (stage) => {
			const { dispatcher, dir, items, events, control, releases } = fixture({
				refuse: stage === "admission",
			});
			items.splice(1);
			if (stage === "provision")
				control.provisionError = new Error("Destination already exists");
			const path = join(dir, `${item().id}-2.json`);
			for (let n = 1; n <= 3; n++) {
				await dispatcher.tick();
				await dispatcher.drain();
				const saved = JSON.parse(readFileSync(path, "utf8"));
				expect(saved.identicalFailures).toBe(n);
				expect(events.filter((e) => e.verb === "comment")).toHaveLength(
					n === 3 ? 1 : 0,
				);
				saved.retryAt = 0;
				saved.retryDeadlineAt = 0;
				writeFileSync(path, JSON.stringify(saved));
			}
			const count = events.length;
			await dispatcher.tick();
			await dispatcher.drain();
			expect(events.slice(count).map((e) => e.verb)).toEqual(["dispatch-list"]);
			// The held decision is durable, even without the original dispatcher object.
			const restarted = new LaneDispatcher(options, dir, {
				darkWake: () => false,
				available: () => true,
				budgets: () => ({}),
				cli: async <T>() =>
					({ data: items, pagination: { hasMore: false } }) as T,
			});
			await restarted.tick();
			await restarted.drain();
			expect(JSON.parse(readFileSync(path, "utf8")).held).toBe(true);
			items[0]!.version++;
			control.startError = undefined;
			control.provisionError = undefined;
			await dispatcher.tick();
			await until(() => releases.length === 1);
			releases[0]!();
			await dispatcher.drain();
			expect(events.filter((e) => e.verb === "comment")).toHaveLength(1);
		},
	);
	it("sends the full any-local executor set to server-side discovery", async () => {
		const { dispatcher, events, releases } = fixture({ executor: "any-local" });
		await dispatcher.tick();
		await until(() => releases.length === 2);
		expect(
			events.find((e) => e.verb === "dispatch-list")?.input?.executor,
		).toEqual(["codex", "claude-code", "opencode", "devin", "any-local"]);
		for (const release of releases) release();
		await dispatcher.drain();
	});
	it.each(["landed", "missing", "unavailable"])(
		"settles coding Work with %s commit proof",
		async (proof) => {
			const { dispatcher, items, control, events, releases, dir } = fixture();
			items.splice(1);
			items[0]!.workKind = "coding";
			if (proof === "landed")
				control.commits = ["b".repeat(40), "c".repeat(40)];
			if (proof === "unavailable")
				control.proofError = new Error("origin/main unavailable");
			await dispatcher.tick();
			await until(() => releases.length === 1);
			releases[0]!();
			await dispatcher.drain();
			const settlement = events.find((e) => e.verb === "settle")!.args;
			expect(settlement[settlement.indexOf("--outcome") + 1]).toBe(
				proof === "landed" ? "succeeded" : "failed",
			);
			expect(settlement.filter((arg) => arg === "--commit")).toHaveLength(
				control.commits.length,
			);
			for (const sha of control.commits) expect(settlement).toContain(sha);
			const receipt = JSON.parse(
				readFileSync(join(dir, `${item().id}-2.json`), "utf8"),
			);
			if (proof === "missing")
				expect(receipt.note).toContain("No landed commit SHA on origin/main");
		},
	);

	it.each(["failed", "expired"])(
		"holds lost admission responses until canonical history retires the Attempt as %s",
		async (outcome) => {
			const { dispatcher, dir, items, events, control, releases } = fixture({
				refuse: true,
			});
			items.splice(1);
			control.startError = new Error("Tedix CLI read deadline elapsed");
			const path = join(dir, `${item().id}-2.json`);
			const retry = async () => {
				const saved = JSON.parse(readFileSync(path, "utf8"));
				saved.retryAt = 0;
				writeFileSync(path, JSON.stringify(saved));
				await dispatcher.tick();
				await dispatcher.drain();
			};
			await dispatcher.tick();
			await dispatcher.drain();
			expect(JSON.parse(readFileSync(path, "utf8")).admissionState).toBe(
				"unknown",
			);
			control.startError = undefined;
			control.history.nextCursor = "older-page";
			await retry();
			control.history.nextCursor = null;
			control.history.data = [
				{
					id: "lost-attempt",
					outcome: null,
					expiresAt: "2020-01-01T00:00:00.000Z",
					metadata: { dispatchVersion: 2 },
				},
			];
			await retry();
			expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
				1,
			);
			expect(releases).toHaveLength(0);
			// Lease expiry alone is insufficient; the server must retire the Attempt.
			control.history.data[0]!.outcome = outcome;
			const saved = JSON.parse(readFileSync(path, "utf8"));
			saved.retryAt = 0;
			writeFileSync(path, JSON.stringify(saved));
			await dispatcher.tick();
			await until(() => releases.length === 1);
			releases[0]!();
			await dispatcher.drain();
			expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
				2,
			);
		},
	);
	it("recovers a legacy failed no-Attempt receipt after purpose repair and preserves completed receipts", async () => {
		const { dispatcher, dir, items, control, releases, events } = fixture();
		items.splice(1);
		const path = join(dir, `${item().id}-2.json`);
		writeFileSync(
			path,
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "failed",
				note: "Tedix CLI read failed (exit 2)",
			}),
		);
		control.readiness = {
			ready: false,
			reasons: [{ detail: "purpose_blocked: Missing objective" }],
		};
		await dispatcher.tick();
		await dispatcher.drain();
		expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(0);
		expect(readFileSync(path, "utf8")).toContain("purpose_blocked");
		control.readiness = { ready: true, reasons: [] };
		const saved = JSON.parse(readFileSync(path, "utf8"));
		saved.retryAt = 0;
		writeFileSync(path, JSON.stringify(saved));
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		await dispatcher.tick();
		await dispatcher.drain();
		expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(1);
	});
	it("allows a changed Work revision without waiting for the old revision's retry deadline", async () => {
		const { dispatcher, items, control, releases } = fixture({ refuse: true });
		items.splice(1);
		await dispatcher.tick();
		await dispatcher.drain();
		items[0]!.version++;
		control.startError = undefined;
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
	});
	it("does nothing during dark wake", async () => {
		const { dispatcher, events } = fixture({ dark: true });
		await dispatcher.tick();
		expect(events).toHaveLength(0);
	});
	it("waits out the login's shared gateway cooldown instead of queuing reads into it", async () => {
		let now = 1_800_000_000_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const { dispatcher, events, control, releases, dir } = fixture();
		try {
			control.cooldownUntil = now + 59_000;
			await dispatcher.tick();
			expect(events).toHaveLength(0);
			expect(control.cooldownWorkspaces).toContain("acme");
			expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
				"Gateway rate limit for this login until",
			);
			// The loop wakes when the cooldown ends, not on a blind 30 s timer.
			expect(dispatcher.nextTickDelayMs()).toBeGreaterThanOrEqual(59_000);
			expect(dispatcher.nextTickDelayMs()).toBeLessThanOrEqual(64_000);
			now += 59_001;
			expect(dispatcher.nextTickDelayMs()).toBe(30_000);
			await dispatcher.tick();
			expect(events.some((event) => event.verb === "dispatch-list")).toBe(true);
			await until(() => releases.length === 2);
		} finally {
			for (const release of releases) release();
			await dispatcher.drain();
			clock.mockRestore();
		}
	});
	it("gives a read queued behind the cooldown the rest of it plus a request budget", () => {
		expect(cooldownGraceMs(0, 1_000)).toBe(0);
		expect(cooldownGraceMs(1_000, 1_000)).toBe(0);
		expect(cooldownGraceMs(46_000, 1_000)).toBe(75_000);
	});
	it("sweeps proposals at most every five minutes", async () => {
		let now = 1_800_000_000_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const { dispatcher, events, releases, items } = fixture({
			acceptProposed: true,
		});
		items.splice(0);
		const sweeps = () =>
			events.filter(
				(event) =>
					event.verb === "dispatch-list" &&
					event.input?.disposition === "proposed",
			).length;
		try {
			await dispatcher.tick();
			now += 30_000;
			await dispatcher.tick();
			expect(sweeps()).toBe(1);
			now += 5 * 60_000;
			await dispatcher.tick();
			expect(sweeps()).toBe(2);
		} finally {
			for (const release of releases) release();
			await dispatcher.drain();
			clock.mockRestore();
		}
	});
	it("retains the exact fence, outcome and retry deadline when settlement fails", async () => {
		const { dispatcher, releases, dir } = fixture({ failSettle: true });
		await dispatcher.tick();
		await until(() => releases.length === 2);
		for (const release of releases) release();
		await dispatcher.drain();
		const saved = JSON.parse(
			readFileSync(join(dir, `${item(1).id}-2.json`), "utf8"),
		);
		expect(saved).toMatchObject({
			phase: "settling",
			attemptId: "fictional-attempt",
			outcome: "succeeded",
			retries: 1,
		});
		expect(saved.retryAt).toBeGreaterThan(Date.now());
	});
});

it("requires the owner's version-specific note for money or personal messaging", () => {
	const work = { ...item(), description: "Send an email as the owner" };
	expect(dispatchSkip(work)).toContain("owner comment");
	const note = {
		authorType: "user" as const,
		authorId: "fictional-owner",
		body: "Delegation: codex work-version=2 Send this approved draft to the named recipient.",
	};
	expect(dispatchSkip(work, [note])).toBeUndefined();
	for (const owner of [
		{ accountableOwnerType: null, accountableOwnerId: null },
		{ accountableOwnerType: "user" as const, accountableOwnerId: null },
		{
			accountableOwnerType: "tedi" as const,
			accountableOwnerId: "fictional-tedi",
		},
	]) {
		const reason = dispatchSkip({ ...work, ...owner }, [note]);
		expect(reason).toContain("no accountable user owner");
		expect(reason).toContain("Set an accountable user owner");
	}
	expect(
		dispatchSkip(work, [{ ...note, authorId: "another-owner" }]),
	).toContain("owner comment");
	expect(dispatchSkip({ ...work, version: 3 }, [note])).toContain(
		"owner comment",
	);
	expect(
		dispatchSkip({ ...work, description: "Complete MFA consent" }, [note]),
	).toContain("human-only");
	expect(dispatchSkip({ ...work, disposition: "proposed" }, [note])).toContain(
		"not accepted",
	);
});

it("admits Work that only mentions logins or credentials once the owner delegates it", () => {
	const note = {
		authorType: "user" as const,
		authorId: "fictional-owner",
		body: "Delegation: codex work-version=2 UI and dispatcher code only; no sign-in.",
	};
	for (const description of [
		"Redesign the connections pages: login status, credentials list and reconnect button.",
		"The dispatcher refuses Work whose text mentions an owner login.",
		"Interview through the already logged-in desktop app. Never run tedix login or complete OAuth consent yourself.",
	]) {
		const work = { ...item(), description };
		const reason = dispatchSkip(work);
		expect(reason).toContain("consent or credentials");
		expect(reason).toContain(
			"Delegation: codex work-version=2 <bounded delegation note>",
		);
		expect(dispatchSkip(work, [note])).toBeUndefined();
		expect(
			dispatchSkip(work, [{ ...note, authorId: "another-owner" }]),
		).toContain("owner comment");
		expect(dispatchSkip({ ...work, version: 3 }, [note])).toContain(
			"owner comment",
		);
		expect(
			dispatchSkip({ ...work, accountableOwnerId: null }, [note]),
		).toContain("no accountable user owner");
	}
	for (const description of [
		"Complete the OAuth consent for the new connector.",
		"Enter the password and approve MFA on the owner's phone.",
	])
		expect(dispatchSkip({ ...item(), description }, [note])).toBe(
			"Consent, MFA and user presence remain human-only",
		);
});
it("validates concurrency and pins selectors without persisting inherited identity or credentials", () => {
	const args = ["--executor", "codex", "--rules", projectId];
	const env = { TEDIX_WORKSPACE: "acme", TEDIX_ORGANIZATION: "org_acme" };
	expect(parseServeOptions(args, env).max).toBe(5);
	expect(parseServeOptions([...args, "--coordinated"], env).coordinated).toBe(
		true,
	);
	expect(parseServeOptions(["--executor", "codex"], env).rules).toBe(
		"lane-rules",
	);
	expect(() =>
		parseServeOptions(
			[...args, "--organization", "org_acme", "--organization", "org_other"],
			env,
		),
	).toThrow("Conflicting");
	for (const n of ["0", "-1", "NaN", "1.5", "101"])
		expect(() => parseServeOptions([...args, "--max", n], env)).toThrow(
			"integer",
		);
	const plist = laneServicePlist(
		["/bin/tedix", ...args, "--repo", "/repo/a&b"],
		"dev.tedix.test",
		{
			...env,
			PATH: "/bin",
			TEDIX_MCP_BEARER_TOKEN: "secret",
			TEDIX_AGENT_SESSION: "parent",
		},
		"/fictional/home",
	);
	expect(plist).toContain("a&amp;b");
	expect(plist).toContain("KeepAlive");
	expect(plist).toContain("WorkingDirectory");
	expect(plist).not.toContain("secret");
	expect(plist).not.toContain("parent");
	expect(
		laneChildEnv({
			...env,
			CODEX_THREAD_ID: "parent",
			TEDIX_EXTERNAL_AGENT: "parent",
		}),
	).toEqual(env);
});
it("serializes calls and releases the queue after an error", async () => {
	const queue = serialCalls();
	const events: string[] = [];
	const a = queue(async () => {
		events.push("a");
		throw new Error("failure");
	});
	const b = queue(async () => {
		events.push("b");
		return 1;
	});
	await expect(a).rejects.toThrow("failure");
	expect(await b).toBe(1);
	expect(events).toEqual(["a", "b"]);
});

it("defers a future planned start and reuses only a canonically failed Work's retained tree", () => {
	expect(
		dispatchSkip({
			...item(),
			startAt: new Date(Date.now() + 60000).toISOString(),
		}),
	).toContain("scheduled");
	const dir = mkdtempSync(join(tmpdir(), "lane-resume-test-"));
	dirs.push(dir);
	const repo = join(dir, "runs", "old", "repo");
	mkdirSync(repo, { recursive: true });
	writeFileSync(join(repo, "unfinished.txt"), "Preserve this work");
	writeFileSync(
		join(dir, "old.json"),
		JSON.stringify({
			itemId: item().id,
			version: 1,
			phase: "settled",
			attemptId: "failed-attempt",
			repo,
		}),
	);
	expect(
		retainedLaneWorktree(dir, item().id, [
			{ id: "failed-attempt", outcome: "failed" },
		])?.repo,
	).toBe(repo);
	expect(
		retainedLaneWorktree(dir, item().id, [
			{ id: "failed-attempt", outcome: "succeeded" },
		]),
	).toBeUndefined();
	expect(
		retainedLaneWorktree(dir, item(2).id, [
			{ id: "failed-attempt", outcome: "failed" },
		]),
	).toBeUndefined();
	expect(readFileSync(join(repo, "unfinished.txt"), "utf8")).toBe(
		"Preserve this work",
	);
});

it("any-local accepts either native executor but never human or tedi Work", () => {
	const parsed = parseServeOptions([
		"--executor",
		"any-local",
		"--max",
		"2",
		"--workspace",
		"acme",
		"--organization",
		"org-acme",
	]);
	expect(parsed.executor).toBe("any-local");
	for (const executor of ["codex", "claude-code"])
		expect(
			dispatchSkip({ ...item(), metadata: { executor } }, [], "any-local"),
		).toBeUndefined();
	for (const executor of ["human", "tedi"])
		expect(
			dispatchSkip({ ...item(), metadata: { executor } }, [], "any-local"),
		).toContain("not assigned");
});

it("any-local retains sibling process, settlement and worktree receipts on migration", () => {
	const root = mkdtempSync(join(tmpdir(), "lane-migration-"));
	dirs.push(root);
	const target = join(root, "any"),
		source = join(root, "claude");
	mkdirSync(target);
	mkdirSync(source);
	const name = `${item().id}-2.json`;
	const receipt = {
		itemId: item().id,
		version: 2,
		pid: process.pid,
		phase: "settling",
		repo: "/retained/repo",
		session: "claude-code:fictional",
		pendingObservation: { source: "wrapper" },
	};
	writeFileSync(join(source, name), JSON.stringify(receipt));
	mergeDispatcherReceipts(target, [source]);
	expect(JSON.parse(readFileSync(join(target, name), "utf8"))).toEqual(receipt);
	mergeDispatcherReceipts(target, [source]);
	writeFileSync(join(source, name), JSON.stringify({ ...receipt, version: 3 }));
	expect(() => mergeDispatcherReceipts(target, [source])).toThrow(
		"Conflicting",
	);
});

it("any-local shares two slots across native Claude and Codex Attempts", async () => {
	const { dispatcher, events, releases } = fixture({ executor: "any-local" });
	await dispatcher.tick();
	await until(() => releases.length === 2);
	const starts = events.filter((e) => e.verb === "start" && !e.input);
	expect(
		starts.map((e) => e.env.TEDIX_AGENT_SESSION?.split(":")[0]).sort(),
	).toEqual(["claude-code", "codex"]);
	await dispatcher.tick();
	expect(releases).toHaveLength(2);
	for (const done of releases) done();
	await dispatcher.drain();
	expect(events.filter((e) => e.verb === "settle")).toHaveLength(2);
});

it("any-local requests delegation for the assigned native executor", () => {
	expect(
		dispatchSkip(
			{ ...item(), title: "Summarize email fixtures" },
			[],
			"any-local",
		),
	).toBeUndefined();
	const reserved = { ...item(), title: "Send an email to a customer" };
	expect(dispatchSkip(reserved, [], "any-local")).toContain(
		"Delegation: codex work-version=2",
	);
	const comment = {
		authorType: "user" as const,
		authorId: "fictional-owner",
		body: "Delegation: codex work-version=2 Summarize fictional fixtures only.",
	};
	expect(dispatchSkip(reserved, [comment], "any-local")).toBeUndefined();
	expect(
		dispatchSkip(
			reserved,
			[{ ...comment, body: comment.body.replace("codex", "any-local") }],
			"any-local",
		),
	).toContain("needs an owner comment");
});

function gitFixture() {
	const root = mkdtempSync(join(tmpdir(), "lane-git-test-"));
	dirs.push(root);
	const repo = join(root, "source");
	mkdirSync(repo);
	const git = (args: string[], cwd = repo) => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	git(["init", "-b", "main"]);
	git(["config", "user.name", "Test"]);
	git(["config", "user.email", "test@example.com"]);
	git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"]);
	return { root, repo, git };
}

it("preserves an orphan destination and provisions the retry path", () => {
	const { root, repo, git } = gitFixture();
	const destination = join(root, "repo");
	mkdirSync(destination);
	writeFileSync(join(destination, "retained.txt"), "unfinished work");
	provisionLaneWorktree(repo, destination);
	expect(git(["rev-parse", "HEAD"], destination)).toBe(
		git(["rev-parse", "HEAD"]),
	);
	const orphan = readdirSync(root).find((name) =>
		name.startsWith("repo.orphan-"),
	)!;
	expect(readFileSync(join(root, orphan, "repo", "retained.txt"), "utf8")).toBe(
		"unfinished work",
	);
});

it("keeps a dirty registered worktree for inspection and provisions the retry beside it", () => {
	const { root, repo, git } = gitFixture();
	const destination = join(root, "repo");
	git(["worktree", "add", "--detach", destination]);
	writeFileSync(join(destination, "retained.txt"), "unfinished work");
	const retry = provisionLaneWorktree(repo, destination);
	expect(retry).toBe(`${destination}-2`);
	expect(git(["rev-parse", "HEAD"], retry)).toBe(git(["rev-parse", "HEAD"]));
	expect(readFileSync(join(destination, "retained.txt"), "utf8")).toBe(
		"unfinished work",
	);
	// Every later retry gets its own path; no checkout is reused while dirty.
	writeFileSync(join(retry, "second.txt"), "second attempt");
	expect(provisionLaneWorktree(repo, destination)).toBe(`${destination}-3`);
	expect(readFileSync(join(retry, "second.txt"), "utf8")).toBe(
		"second attempt",
	);
});

it("keeps a registered worktree holding unlanded commits and provisions beside it", () => {
	const { root, repo, git } = gitFixture();
	const destination = join(root, "repo");
	git(["worktree", "add", "--detach", destination]);
	git(
		["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "local"],
		destination,
	);
	const local = git(["rev-parse", "HEAD"], destination);
	expect(provisionLaneWorktree(repo, destination)).toBe(`${destination}-2`);
	expect(git(["rev-parse", "HEAD"], destination)).toBe(local);
});

it("reuses a clean registered worktree left by a failed admission at the current HEAD", () => {
	const { root, repo, git } = gitFixture();
	const destination = join(root, "repo");
	git(["worktree", "add", "--detach", destination]);
	git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "next"]);
	expect(provisionLaneWorktree(repo, destination)).toBe(destination);
	expect(git(["rev-parse", "HEAD"], destination)).toBe(
		git(["rev-parse", "HEAD"]),
	);
	expect(existsSync(`${destination}-2`)).toBe(false);
});

it("extracts and deduplicates final-message and local commits, accepting only origin/main ancestors", async () => {
	const { root, repo, git } = gitFixture();
	const base = git(["rev-parse", "HEAD"]);
	const remote = join(root, "origin.git");
	git(["init", "--bare", remote]);
	git(["remote", "add", "origin", remote]);
	git([
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-m",
		"landed",
	]);
	const landed = git(["rev-parse", "HEAD"]);
	git(["push", "origin", "main"]);
	git([
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-m",
		"unpublished",
	]);
	const unpublished = git(["rev-parse", "HEAD"]);
	expect(await landedLaneCommits(repo, base, "")).toEqual([landed]);
	expect(
		await landedLaneCommits(
			repo,
			base,
			`Result ${landed} ${unpublished} ${"f".repeat(40)}`,
		),
	).toEqual([landed]);
	// Guarded push can rebase/reset the lane, so its final message is also evidence input.
	git(["reset", "--hard", base]);
	expect(await landedLaneCommits(repo, base, `Result ${landed}`)).toEqual([
		landed,
	]);
	// A main commit that predates the lane's base is not this lane's result.
	expect(
		await landedLaneCommits(repo, landed, `Rebased onto ${landed}`),
	).toEqual([]);
	await expect(landedLaneCommits(repo, "f".repeat(40), "")).rejects.toThrow();
});

it("normalizes only volatile diagnostics while preserving error identity", () => {
	const first = new CliReadError(
		"Denied 11111111-1111-4111-8111-111111111111 request_id=abc-123 traceparent=00-0123456789abcdef0123456789abcdef-0123456789abcdef-01 timestamp=1792601000 retry after 12 ms",
		"FORBIDDEN",
		403,
	);
	const second = new CliReadError(
		"Denied 22222222-2222-4222-8222-222222222222 request_id=xyz-456 traceparent=00-abcdef0123456789abcdef0123456789-abcdef0123456789-01 timestamp=1792602000 retry after 43 ms",
		"FORBIDDEN",
		403,
	);
	expect(laneFailureSignature(first)).toBe(laneFailureSignature(second));
	for (const different of [
		new CliReadError(first.message, "CONFLICT", 403),
		new CliReadError(first.message, "FORBIDDEN", 401),
		new TypeError(first.message),
		new CliReadError("Denied resource capacity", "FORBIDDEN", 403),
	])
		expect(laneFailureSignature(first)).not.toBe(
			laneFailureSignature(different),
		);
	expect(laneFailureSignature(new Error("HTTP 403 limit 100"))).not.toBe(
		laneFailureSignature(new Error("HTTP 429 limit 200")),
	);
});
it.each([false, true])(
	"retries commit fetch with backoff, exhausted=%s",
	async (exhausted) => {
		const { repo, git } = gitFixture();
		const base = git(["rev-parse", "HEAD"]);
		const delays: number[] = [];
		let calls = 0;
		const proof = landedLaneCommits(repo, base, "b".repeat(40), {
			fetch: () => {
				if (++calls < 3 || exhausted) throw new Error("offline");
			},
			sleep: async (ms) => {
				delays.push(ms);
			},
		});
		if (exhausted)
			await expect(proof).rejects.toBeInstanceOf(LaneCommitFetchError);
		else expect(await proof).toEqual([]);
		expect(calls).toBe(3);
		expect(delays).toEqual([1000, 2000]);
	},
);
