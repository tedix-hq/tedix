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
	cleanupLaneWorktree,
	installLaneDependencies,
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
import { parseOptions } from "./options";
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
	const items: DispatchItem[] = [item(1), item(2), item(3)].map((row) => ({
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
	const recalls: Array<{
		brief: string;
		scope: string[];
		harness: string;
		cwd?: string;
	}> = [];
	const briefs: string[] = [];
	const releases: Array<() => void> = [];
	const control = {
		spawnPid: undefined as number | undefined,
		deliverNote: undefined as string | undefined,
		telemetryOutcome: "succeeded" as "succeeded" | "stopped" | "failed",
		exitCode: 0,
		finalMessage: "Result recorded in OS.",
		provisionError: undefined as Error | undefined,
		threadError: undefined as Error | undefined,
		installError: undefined as Error | undefined,
		installed: [] as string[],
		commits: [] as string[],
		cleanups: 0,
		cleanupResult: true,
		cleanupRemoves: false,
		cleanupWait: undefined as Promise<boolean> | undefined,
		cleanupAfterPickup: [] as boolean[],
		proofError: undefined as Error | undefined,
		evidenceError: undefined as Error | undefined,
		evidence: {
			data: [] as Record<string, unknown>[],
			nextCursor: null as unknown,
		},
		skillRun: {} as Record<string, unknown>,
		skillRunError: undefined as Error | undefined,
		skill: {} as Record<string, unknown>,
		startError: refuse
			? new CliReadError("Admission refused: resource capacity", "CONFLICT")
			: (undefined as Error | undefined),
		readiness: { ready: true, reasons: [] as Array<{ detail: string }> },
		completeError: undefined as Error | undefined,
		cooldownUntil: 0,
		cooldownWorkspaces: [] as Array<string | undefined>,
		recall: "",
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
		installDependencies: async (repo) => {
			if (control.installError) throw control.installError;
			control.installed.push(repo);
		},
		landedCommits: async () => {
			if (control.proofError) throw control.proofError;
			return control.commits;
		},
		recall: async (brief, scope, harness, _organization, cwd) => {
			recalls.push({ brief, scope, harness, cwd });
			return {
				brief: control.recall ? `${control.recall}\n\n${brief}` : brief,
				recall: control.recall,
				recallStatus: control.recall ? "matched" : "none",
			};
		},
		cleanup: (_source, destination) => {
			control.cleanups++;
			control.cleanupAfterPickup.push(
				events.some((event) => event.verb === "dispatch-list"),
			);
			if (control.cleanupRemoves) rmSync(destination, { recursive: true });
			return control.cleanupWait ?? control.cleanupResult;
		},
		thread: async (repo, executor) => {
			if (control.threadError) throw control.threadError;
			if (executor === "devin") expect(control.installed).toContain(repo);
			return {
				thread: {
					id: `33333333-3333-4333-8333-${String(++threadNumber).padStart(12, "0")}`,
					cliVersion: "1.2.3",
					path: "/fictional/transcript",
				},
				model: "test-model",
				modelProvider: "test-provider",
			};
		},
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
			else if (verb === "evidence") {
				if (control.evidenceError) throw control.evidenceError;
				response = control.evidence;
			} else if (verb === "status") {
				if (control.skillRunError) throw control.skillRunError;
				response = control.skillRun;
			} else if (verb === "readiness") response = control.readiness;
			else if (verb === "show" && args.includes("--file"))
				response = { path: "SKILL.md", content: "Keep all evidence in OS." };
			else if (verb === "show" && args[6] !== options.rules)
				response = control.skill;
			else if (verb === "show")
				response = {
					id: options.rules,
					revision: 7,
					contentPreview: "Keep all evidence in OS.",
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
			else if (verb === "complete" && control.completeError)
				throw control.completeError;
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
			briefs.push(brief);
			expect(deps?.label).toBe(
				items.find((row) => row.id === args[args.indexOf("--work-item") + 1])!
					.title,
			);
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
			if (
				items.find((row) => row.id === args[args.indexOf("--work-item") + 1])!
					.metadata?.artifactKind === "skill_revision"
			)
				expect(brief).toContain("--evidence-kind skill_revision");
			else expect(brief).not.toContain("--evidence-kind skill_revision");
			// One trailer paragraph with this lane's exact ids, so the pre-push
			// secret scan accepts the lane's commits.
			expect(brief).toMatch(
				new RegExp(
					`\\nWork-Item: [0-9a-f-]{36}\\nAgent-Session: ${nativeExecutor}:\\S+\\n`,
				),
			);
			expect(brief).toContain("Do not pass one -m per trailer");
			expect(deps?.forwardSignals).toBe(false);
			if (control.spawnPid) deps?.onSpawn?.(control.spawnPid);
			await new Promise<void>((done) => releases.push(done));
			if (control.deliverNote)
				await deps?.deliverWorkNote?.(control.deliverNote);
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
				finalMessage: control.finalMessage,
				tools: {},
				usage: { input: 100, cached: 40, output: 30, reasoning: 10 },
				shas: [],
				workItems: [],
				corrections: [],
				source: "wrapper",
			});
			return control.exitCode;
		},
	};
	const restart = () => new LaneDispatcher(config, dir, deps);
	const dispatcher = restart();
	return {
		dispatcher,
		restart,
		deps,
		dir,
		events,
		releases,
		control,
		items,
		recalls,
		briefs,
	};
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
				if (scenario === "lease expiry") {
					leaseCheck();
					leaseCheck();
					expect(kill).toHaveBeenCalledWith(-control.spawnPid, "SIGTERM");
					expect(
						kill.mock.calls.filter((call) => call[1] === "SIGTERM"),
					).toHaveLength(1);
				} else
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
	it("kills a child that ignores SIGTERM after the lease grace period", async () => {
		const child = spawn(
			process.execPath,
			[
				"-e",
				'process.on("SIGTERM", () => console.log("ignored")); console.log("ready"); setInterval(() => {}, 1000)',
			],
			{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		const exited = once(child, "exit");
		let now = 1_800_000_000_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		let leaseCheck!: () => void;
		let heartbeat!: () => void;
		const timer = spyOn(globalThis, "setInterval").mockImplementation(((
			callback: () => void,
			ms: number,
		) => {
			if (ms === 1000) leaseCheck = callback;
			else heartbeat = callback;
			return setTimeout(() => {}, 60_000);
		}) as typeof setInterval);
		const { dispatcher, items, control, releases, events, dir } = fixture();
		items.splice(1);
		control.spawnPid = child.pid;
		try {
			await once(child.stdout!, "data");
			await dispatcher.tick();
			await until(() => releases.length === 1);
			const ignored = once(child.stdout!, "data");
			now += 300_001;
			const stoppingAt = performance.now();
			leaseCheck();
			expect(String((await ignored)[0])).toContain("ignored");
			const receiptPath = join(dir, `${item().id}-2.json`);
			expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
				interrupted: true,
				outcome: "expired",
				phase: "running",
			});
			for (let tick = 0; tick < 10; tick++) {
				leaseCheck();
				heartbeat();
			}
			expect(events.some((event) => event.verb === "heartbeat")).toBe(false);
			expect(child.signalCode).toBeNull();
			const [code, signal] = await exited;
			expect(code).toBeNull();
			expect(signal).toBe("SIGKILL");
			expect(performance.now() - stoppingAt).toBeGreaterThanOrEqual(4900);
			releases[0]!();
			await dispatcher.drain();
			expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
				interrupted: true,
				outcome: "expired",
			});
			const log = readFileSync(join(dir, "dispatcher.log"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(log.filter((row) => row.event === "lease-expired")).toHaveLength(
				1,
			);
		} finally {
			if (child.exitCode === null && child.signalCode === null)
				process.kill(-child.pid!, "SIGKILL");
			await exited;
			for (const release of releases) release();
			await dispatcher.drain();
			timer.mockRestore();
			clock.mockRestore();
		}
	}, 15_000);
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
		const { dispatcher, events, releases, control } = fixture({
			executor: "devin",
		});
		await dispatcher.tick();
		await until(() => releases.length === 2);
		expect(
			events.find((event) => event.verb === "start")?.env.TEDIX_AGENT_SESSION,
		).toStartWith("devin:");
		for (const release of releases) release();
		await dispatcher.drain();
		expect(events.filter((event) => event.verb === "settle")).toHaveLength(2);
		expect(control.installed).toHaveLength(2);
	});
	it("posts Devin notes only to the admitted Work using its own fenced identity", async () => {
		const f = fixture({ executor: "devin" });
		f.items.splice(1);
		f.control.deliverNote = "Actual requested paragraph.";
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		const comment = f.events.find((event) => event.verb === "comment")!;
		expect(comment.args.slice(4)).toEqual([
			"work",
			"comment",
			f.items[0]!.id,
			"--body",
			f.control.deliverNote,
		]);
		const admission = f.events.find(
			(event) => event.verb === "start" && event.args[4] === "work",
		)!;
		expect(comment.env.TEDIX_AGENT_SESSION).toBe(
			admission.env.TEDIX_AGENT_SESSION,
		);
		expect(comment.env.TEDIX_EXTERNAL_AGENT).toBe(
			admission.env.TEDIX_EXTERNAL_AGENT,
		);
		expect(f.events.slice(0, f.events.indexOf(comment)).at(-1)?.verb).toBe(
			"heartbeat",
		);
	});
	it.each([
		["failed", 0],
		["succeeded", 1],
	] as const)(
		"does not settle success with telemetry %s and exit %s",
		async (outcome, exit) => {
			const f = fixture();
			f.items.splice(1);
			f.control.telemetryOutcome = outcome;
			f.control.exitCode = exit;
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.releases[0]!();
			await f.dispatcher.drain();
			const args = f.events.find((event) => event.verb === "settle")!.args;
			expect(args[args.indexOf("--outcome") + 1]).toBe("failed");
		},
	);
	it("does not create a child or admit Work when Devin dependency installation fails", async () => {
		const { dispatcher, events, releases, control } = fixture({
			executor: "devin",
		});
		control.installError = new Error("Frozen lockfile install failed");
		await dispatcher.tick();
		await dispatcher.drain();
		expect(releases).toHaveLength(0);
		expect(events.some((event) => event.verb === "start")).toBe(false);
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
	it("completes a successful result under its original session and retains a denied completion for retry", async () => {
		const { dispatcher, items, control, events, releases, dir } = fixture();
		items.splice(1);
		control.completeError = new Error("Completion unavailable");
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const path = join(dir, `${item().id}-2.json`);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved).toMatchObject({
			phase: "settled",
			outcome: "succeeded",
			completionPending: true,
			completionRetries: 1,
		});
		const complete = events.find((e) => e.verb === "complete")!;
		const settle = events.find((e) => e.verb === "settle")!;
		expect(complete.env.TEDIX_AGENT_SESSION).toBe(
			settle.env.TEDIX_AGENT_SESSION,
		);
		expect(events.indexOf(complete)).toBeGreaterThan(events.indexOf(settle));
		control.completeError = undefined;
		saved.completionRetryAt = 0;
		writeFileSync(path, JSON.stringify(saved));
		await dispatcher.tick();
		expect(JSON.parse(readFileSync(path, "utf8")).completionPending).toBe(
			false,
		);
		expect(releases).toHaveLength(1);
	});

	it.each([
		"recovered",
		"changed-version",
		"different-attempt",
		"missing-attempt",
		"completed",
		"cancelled",
		"unreadable",
	])("reconciles exhausted closure after restart: %s", async (state) => {
		const { dispatcher, restart, items, control, events, releases, dir } =
			fixture();
		items.splice(1);
		control.completeError = new Error("Completion unavailable");
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const path = join(dir, `${item().id}-2.json`);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		saved.completionRetries = 5;
		saved.completionRetryAt = 0;
		writeFileSync(path, JSON.stringify(saved));
		control.completeError = undefined;
		control.history.data = [
			{
				id: saved.attemptId,
				externalSessionKey: saved.session,
				outcome: "succeeded",
			},
		];
		if (state === "changed-version") {
			items[0]!.version++;
			items[0]!.startAt = new Date(Date.now() + 60_000).toISOString();
		}
		if (state === "different-attempt")
			control.history.data[0]!.id = "another-attempt";
		if (state === "missing-attempt") control.history.data = [];
		if (state === "completed" || state === "cancelled")
			items[0]!.disposition = state;
		if (state === "unreadable") items.splice(0);
		const before = events.filter((e) => e.verb === "complete").length;
		const resumed = restart();
		await resumed.tick();
		const recovered = JSON.parse(readFileSync(path, "utf8"));
		expect(recovered.completionRetries).toBe(6);
		expect(recovered.completionPending).toBe(
			!["recovered", "completed", "cancelled"].includes(state),
		);
		expect(events.filter((e) => e.verb === "complete")).toHaveLength(
			before + (state === "recovered" ? 1 : 0),
		);
		expect(
			events.filter((e) => e.verb === "dispatch-get").at(-1)!.env
				.TEDIX_AGENT_SESSION,
		).toBe(saved.session);
		expect(recovered.completionRetryAt).toBeGreaterThan(
			Date.now() + 14 * 60_000,
		);
		const reads = events.length;
		await resumed.tick();
		expect(
			events
				.slice(reads)
				.some((e) => e.verb === "complete" || e.verb === "dispatch-attempts"),
		).toBe(false);
		// An unclosed result does not occupy a worker slot or relaunch the old Work.
		items.splice(0, items.length, item(2));
		await resumed.tick();
		await until(() => releases.length >= 2);
		for (const release of releases.slice(1)) release();
		await resumed.drain();
		expect(
			events.filter((e) => e.verb === "start" && e.args[6] === item().id),
		).toHaveLength(1);
	});

	it.each(["lost-admission", "expired-settlement"])(
		"fresh admission follows retained %s without reviving its expired lease",
		async (state) => {
			const { dispatcher, restart, items, control, events, releases, dir } =
				fixture();
			items.splice(1);
			let now = Date.now();
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			try {
				const session = "codex:33333333-3333-4333-8333-000000000099";
				const path = join(dir, `${item().id}-2.json`);
				writeFileSync(
					path,
					JSON.stringify({
						itemId: item().id,
						version: 2,
						phase: state === "lost-admission" ? "preparing" : "failed",
						admissionState: state === "lost-admission" ? "unknown" : "admitted",
						attemptId: state === "lost-admission" ? undefined : "old-attempt",
						session,
						executorKey: "local-acme",
						outcome: state === "lost-admission" ? undefined : "succeeded",
						retries: state === "lost-admission" ? 0 : 5,
						settlementRetries: state === "lost-admission" ? undefined : 5,
						retryAt: 0,
						retryDeadlineAt: now + 30 * 60_000,
						note: "Retained result",
						telemetry: { finalMessage: "Retained result" },
					}),
				);
				control.history.data = [
					{
						id: "old-attempt",
						externalSessionKey: session,
						outcome: null,
						expiresAt: new Date(now - 1).toISOString(),
						metadata: { dispatchVersion: 2 },
					},
				];
				await dispatcher.tick();
				const saved = JSON.parse(readFileSync(path, "utf8"));
				expect(saved).toMatchObject({
					phase: "deferred",
					outcome: "expired",
					attemptId: "old-attempt",
					retries: 1,
				});
				expect(
					events.filter((e) => e.verb === "start" || e.verb === "settle"),
				).toHaveLength(0);
				if (state === "expired-settlement")
					expect(saved.settlementRetries).toBe(5);
				now = saved.retryAt + 1;
				const resumed = restart();
				await resumed.tick();
				await until(() => releases.length === 1);
				releases[0]!();
				await resumed.drain();
				expect(
					events.filter((e) => e.verb === "start" && e.input),
				).toHaveLength(1);
				expect(JSON.parse(readFileSync(path, "utf8")).attemptId).not.toBe(
					"old-attempt",
				);
				expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
					outcome: "succeeded",
					completionPending: false,
				});
			} finally {
				clock.mockRestore();
			}
		},
	);

	it.each(["dispatch-get", "agent-start"])(
		"retains interrupted checkout correlation after %s fails",
		async (failure) => {
			const { restart, deps, items, control, events, releases, dir } =
				fixture();
			items.splice(1);
			let now = Date.now();
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			const path = join(dir, `${item().id}-2.json`);
			const repo = join(dir, "runs", `${item().id}-2`, "repo");
			mkdirSync(repo, { recursive: true });
			const checkpoint = join(repo, "checkpoint.txt");
			writeFileSync(checkpoint, "unfinished work");
			const previous = {
				itemId: item().id,
				version: 2,
				phase: "deferred",
				outcome: "expired",
				admissionState: "admitted",
				attemptId: "old-attempt",
				repo,
				baseCommit: "b".repeat(40),
				session: "codex:33333333-3333-4333-8333-000000000099",
				executorKey: "local-acme",
				pid: 2_000_000_000,
				processIdentity: "v2:old-process",
			};
			writeFileSync(path, JSON.stringify(previous));
			control.history.data = [
				{
					id: previous.attemptId,
					externalSessionKey: previous.session,
					outcome: "expired",
					metadata: { dispatchVersion: 2 },
				},
			];
			control.cleanupRemoves = true;
			const cli = deps.cli!;
			deps.cli = async (args, env) => {
				if (
					(failure === "dispatch-get" && args[5] === "dispatch-get") ||
					(failure === "agent-start" &&
						args[4] === "agent" &&
						args[5] === "start")
				)
					throw new Error("Tedix CLI read deadline elapsed");
				return cli(args, env);
			};
			const provision = spyOn(deps, "provision");
			const thread = spyOn(deps, "thread");
			try {
				const interrupted = restart();
				await interrupted.tick();
				await interrupted.drain();
				const saved = JSON.parse(readFileSync(path, "utf8"));
				expect(saved).toMatchObject({
					phase: "deferred",
					outcome: "expired",
					repo,
					session: previous.session,
					attemptId: previous.attemptId,
					processIdentity: previous.processIdentity,
				});
				expect(saved.pid).toBeUndefined();
				expect(control.cleanups).toBe(0);
				await interrupted.tick();
				await interrupted.drain();
				expect(readFileSync(checkpoint, "utf8")).toBe("unfinished work");
				expect(control.cleanups).toBe(0);
				expect(
					events.some((entry) =>
						["start", "heartbeat", "settle"].includes(entry.verb),
					),
				).toBe(false);
				deps.cli = cli;
				now = saved.retryAt + 1;
				const resumed = restart();
				await resumed.tick();
				await until(() => releases.length === 1);
				expect(provision).not.toHaveBeenCalled();
				expect(thread.mock.calls.at(-1)![0]).toBe(repo);
				expect(thread.mock.calls.at(-1)![3]).toBe(
					previous.session.slice("codex:".length),
				);
				releases[0]!();
				await resumed.drain();
				expect(JSON.parse(readFileSync(path, "utf8")).attemptId).toBe(
					"fictional-attempt",
				);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it.each([
		"sent-unknown",
		"sent-rejected",
		"different-work",
		"different-version",
		"outside-runs",
		"not-interrupted",
	])("does not restore old admission correlation for %s", async (state) => {
		const { restart, deps, items, control, events, dir } = fixture({
			refuse: state === "sent-rejected",
		});
		items.splice(1);
		const sent = state.startsWith("sent-");
		const path = join(dir, `${item().id}-2.json`);
		const repo =
			state === "outside-runs"
				? join(dir, "elsewhere")
				: join(dir, "runs", `${item().id}-2`, "repo");
		mkdirSync(repo, { recursive: true });
		const previous = {
			itemId: state === "different-work" ? item(2).id : item().id,
			version: state === "different-version" ? 3 : 2,
			phase: "deferred",
			outcome: state === "not-interrupted" ? "failed" : "expired",
			admissionState: "admitted",
			attemptId: "old-attempt",
			repo,
			session: "codex:33333333-3333-4333-8333-000000000099",
			executorKey: "local-acme",
			processIdentity: "v2:old-process",
		};
		writeFileSync(path, JSON.stringify(previous));
		control.history.data = [
			{
				id: previous.attemptId,
				externalSessionKey: previous.session,
				outcome: "expired",
				metadata: { dispatchVersion: 2 },
			},
		];
		if (state === "sent-unknown")
			control.startError = new Error("Tedix CLI read deadline elapsed");
		if (!sent) {
			const cli = deps.cli!;
			deps.cli = async (args, env) => {
				if (args[5] === "dispatch-get")
					throw new Error("Tedix CLI read deadline elapsed");
				return cli(args, env);
			};
		}
		const dispatcher = restart();
		await dispatcher.tick();
		await dispatcher.drain();
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.attemptId).toBeUndefined();
		expect(saved.processIdentity).toBeUndefined();
		expect(saved.pid).toBeUndefined();
		expect(saved.outcome).toBe("failed");
		expect(
			events.some((entry) => ["heartbeat", "settle"].includes(entry.verb)),
		).toBe(false);
		if (sent) {
			expect(saved.session).not.toBe(previous.session);
			expect(saved.admissionState).toBe(
				state === "sent-unknown" ? "unknown" : "rejected",
			);
		} else {
			expect(saved.session).toBeUndefined();
			expect(saved.repo).toBeUndefined();
		}
	});

	it("settles result notes starting with a bullet through the real option parser", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		control.finalMessage = "- SHA256: digest\n- Work result recorded";
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settle = events.find((event) => event.verb === "settle")!;
		expect(parseOptions(settle.args).options.workNote).toBe(
			`Result:\n${control.finalMessage}`,
		);
	});

	it("prefixes matching lessons before launching Codex without relying on hooks", async () => {
		const { dispatcher, items, control, recalls, briefs, releases } = fixture();
		items.splice(1);
		control.recall =
			"Tedix situational recall (advisory):\n- [lesson deadbeef] Keep product bindings aligned with the production overlay.";

		await dispatcher.tick();
		await until(() => releases.length === 1);

		expect(recalls).toEqual([
			{
				brief: expect.stringContaining(`Work ${item().id}`),
				scope: options.scope,
				harness: "codex",
				cwd: expect.stringContaining("/repo"),
			},
		]);
		expect(briefs[0]).toStartWith(control.recall);
		expect(briefs[0]).toContain("Your exclusive source worktree is");
		releases[0]!();
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
	it.each(["quota", "backoff"])(
		"resumes after three routing %s pauses when capacity returns",
		async (pause) => {
			const executor = pause === "quota" ? "claude-code" : "codex";
			const { restart, deps, items, events, releases, dir } = fixture({
				executor,
			});
			items.splice(1);
			let now = Date.now();
			const capacityUntil = now + 60 * 60_000;
			let capacityReturned = false;
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			deps.budgets = () => ({
				[executor]: {
					observedAt: now,
					source: "native",
					remainingPercent: capacityReturned
						? 90
						: pause === "quota"
							? 10
							: undefined,
					resetAt: capacityUntil,
					backoffUntil:
						pause === "backoff" && !capacityReturned
							? capacityUntil
							: undefined,
				},
			});
			const path = join(dir, `${item().id}-2.json`);
			const dispatcher = restart();
			try {
				for (let n = 1; n <= 3; n++) {
					await dispatcher.tick();
					await dispatcher.drain();
					const saved = JSON.parse(readFileSync(path, "utf8"));
					expect(saved.phase).toBe("deferred");
					expect(saved.held).toBe(false);
					expect(saved.retryAt - now).toBe(60_000 * 2 ** (n - 1));
					expect(
						events.some((event) =>
							["start", "heartbeat", "settle"].includes(event.verb),
						),
					).toBe(false);
					now = saved.retryAt + 1;
				}
				capacityReturned = true;
				if (pause === "backoff") now = capacityUntil + 1;
				await dispatcher.tick();
				await until(() => releases.length === 1);
				releases[0]!();
				await dispatcher.drain();
				expect(JSON.parse(readFileSync(path, "utf8")).outcome).toBe(
					"succeeded",
				);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it("keeps unavailable-only routing failures held after three checks", async () => {
		const { restart, deps, items, events, dir } = fixture();
		items.splice(1);
		deps.available = () => false;
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const dispatcher = restart();
		const path = join(dir, `${item().id}-2.json`);
		try {
			for (let n = 1; n <= 3; n++) {
				await dispatcher.tick();
				await dispatcher.drain();
				const saved = JSON.parse(readFileSync(path, "utf8"));
				expect(saved.identicalFailures).toBe(n);
				expect(saved.held).toBe(n === 3);
				now = saved.retryAt + 1;
			}
			expect(
				events.some((event) =>
					["start", "heartbeat", "settle"].includes(event.verb),
				),
			).toBe(false);
		} finally {
			clock.mockRestore();
		}
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
	it("retries native preparation timeouts after restart, including a legacy held receipt", async () => {
		const { dispatcher, restart, dir, items, events, control, releases } =
			fixture();
		items.splice(1);
		const path = join(dir, `${item().id}-2.json`);
		control.threadError = new DOMException(
			"The operation timed out.",
			"TimeoutError",
		);
		for (let n = 1; n <= 3; n++) {
			await dispatcher.tick();
			await dispatcher.drain();
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.held).toBe(false);
			expect(saved.attemptId).toBeUndefined();
			expect(saved.retryAt).toBeGreaterThan(Date.now());
			saved.retryAt = 0;
			saved.held = n === 3;
			writeFileSync(path, JSON.stringify(saved));
		}
		control.threadError = undefined;
		const recovered = restart();
		await recovered.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await recovered.drain();
		expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(1);
		expect(JSON.parse(readFileSync(path, "utf8")).outcome).toBe("succeeded");
	});
	it("defers without holding while the executor bootstrap waits for an owner approval", async () => {
		const { dispatcher, dir, items, events, control } = fixture();
		items.splice(1);
		const path = join(dir, `${item().id}-2.json`);
		for (let n = 1; n <= 4; n++) {
			control.startError = new CliReadError(
				'Tedix CLI read failed (exit 1): Error: External-agent bootstrap is waiting for owner approval 45fe93d1-eba1-4f72-bf95-36842a9693b7 for principal "claude-code-local-host": issuing its credential is human-reserved.',
			);
			await dispatcher.tick();
			await dispatcher.drain();
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.identicalFailures).toBe(n);
			expect(saved.held).toBe(false);
			expect(saved.phase).toBe("deferred");
			saved.retryAt = 0;
			saved.retryDeadlineAt = 0;
			writeFileSync(path, JSON.stringify(saved));
		}
		expect(events.filter((e) => e.verb === "comment")).toHaveLength(0);
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
				devinAvailable: () => true,
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
			if (proof === "landed")
				expect(events.some((event) => event.verb === "evidence")).toBe(false);
			const receipt = JSON.parse(
				readFileSync(join(dir, `${item().id}-2.json`), "utf8"),
			);
			if (proof === "missing")
				expect(receipt.note).toContain("No landed commit SHA on origin/main");
		},
	);

	it("settles coding Work from completed skill revision evidence attributed to its Attempt", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "66666666-6666-4666-8666-666666666666",
			artifactSkillRevision: 3,
		};
		const runId = "44444444-4444-4444-8444-444444444444";
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: `skill://runs/${runId}`,
			},
		];
		control.skillRun = {
			runId,
			status: "completed",
			skillId: "66666666-6666-4666-8666-666666666666",
			skillRevision: 3,
			workItemId: null,
		};
		control.skill = {
			id: "66666666-6666-4666-8666-666666666666",
			lifecycleState: "active",
			tediId: null,
		};
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!;
		expect(settlement.args[settlement.args.indexOf("--outcome") + 1]).toBe(
			"succeeded",
		);
		expect(settlement.args).not.toContain("--commit");
		expect(settlement.input).toMatchObject({
			metadata: {
				settlement: {
					mode: "skill_revision",
					evidenceId: "55555555-5555-4555-8555-555555555555",
					evidenceUri: `skill://runs/${runId}`,
					skillId: "66666666-6666-4666-8666-666666666666",
					skillRevision: 3,
					skillRunId: runId,
				},
			},
		});
	});

	it("does not use skill revision evidence from another Attempt", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "66666666-6666-4666-8666-666666666666",
			artifactSkillRevision: 3,
		};
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "another-attempt",
				kind: "skill_revision",
				uri: "skill://runs/44444444-4444-4444-8444-444444444444",
			},
		];
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
		expect(events.some((event) => event.verb === "status")).toBe(false);
	});

	it("does not use a skill run linked to another Work Item", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "66666666-6666-4666-8666-666666666666",
			artifactSkillRevision: 3,
		};
		const runId = "44444444-4444-4444-8444-444444444444";
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: `skill://runs/${runId}`,
			},
		];
		control.skillRun = {
			runId,
			status: "completed",
			skillId: "66666666-6666-4666-8666-666666666666",
			skillRevision: 3,
			workItemId: item(2).id,
		};
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
	});

	it("does not settle from an ephemeral draft skill run", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "66666666-6666-4666-8666-666666666666",
			artifactSkillRevision: 3,
		};
		const runId = "44444444-4444-4444-8444-444444444444";
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: `skill://runs/${runId}`,
			},
		];
		control.skillRun = {
			runId,
			status: "completed",
			skillId: "66666666-6666-4666-8666-666666666666",
			skillRevision: 3,
			workItemId: null,
		};
		control.skill = {
			id: "66666666-6666-4666-8666-666666666666",
			lifecycleState: "draft",
			tediId: null,
		};
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
	});

	it("does not settle from a different active organization skill", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "77777777-7777-4777-8777-777777777777",
			artifactSkillRevision: 3,
		};
		const runId = "44444444-4444-4444-8444-444444444444";
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: `skill://runs/${runId}`,
			},
		];
		control.skillRun = {
			runId,
			status: "completed",
			skillId: "66666666-6666-4666-8666-666666666666",
			skillRevision: 3,
			workItemId: null,
		};
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
		expect(
			events.some(
				(event) => event.verb === "show" && event.args[6] !== options.rules,
			),
		).toBe(false);
	});

	it("rejects permanently missing skill-run evidence instead of retaining the Attempt", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "66666666-6666-4666-8666-666666666666",
			artifactSkillRevision: 3,
		};
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: "skill://runs/44444444-4444-4444-8444-444444444444",
			},
		];
		control.skillRunError = new CliReadError("run not found", "NOT_FOUND", 404);
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
	});

	it("keeps landed-commit validation for coding Work without a skill artifact declaration", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: "skill://runs/44444444-4444-4444-8444-444444444444",
			},
		];
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
		expect(events.some((event) => event.verb === "evidence")).toBe(false);
	});

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
			retries: 0,
			settlementRetries: 1,
		});
		expect(saved.retryAt).toBeGreaterThan(Date.now());
	});
});

it("installs worktree dependencies and rejects a changed frozen lockfile", async () => {
	const repo = mkdtempSync(join(tmpdir(), "lane-install-test-"));
	dirs.push(repo);
	mkdirSync(join(repo, "dependency"));
	writeFileSync(
		join(repo, "dependency/package.json"),
		JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
	);
	const manifest = {
		name: "fixture",
		dependencies: { "fixture-dependency": "file:./dependency" },
	};
	writeFileSync(join(repo, "package.json"), JSON.stringify(manifest));
	expect(spawnSync("bun", ["install"], { cwd: repo }).status).toBe(0);
	rmSync(join(repo, "node_modules"), { recursive: true });
	await installLaneDependencies(repo);
	expect(
		existsSync(join(repo, "node_modules/fixture-dependency/package.json")),
	).toBe(true);
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({ ...manifest, dependencies: {} }),
	);
	await expect(installLaneDependencies(repo)).rejects.toThrow();
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

it("dispatches Work that only mentions logins or credentials and holds credential acts for the owner", () => {
	const note = {
		authorType: "user" as const,
		authorId: "fictional-owner",
		body: "Delegation: codex work-version=2 Rotate only the fictional staging key.",
	};
	for (const description of [
		"Redesign the connections pages: login status, credentials list and reconnect button.",
		"The dispatcher refuses Work whose text mentions an owner login.",
		"Interview through the already logged-in desktop app. Never run tedix login or complete OAuth consent yourself.",
		"Fix the profile panel's consent check and approval count.",
	])
		expect(dispatchSkip({ ...item(), description })).toBeUndefined();
	const work = { ...item(), description: "Rotate the staging API key." };
	const reason = dispatchSkip(work);
	expect(reason).toContain("consent or credentials");
	expect(reason).toContain(
		"Delegation: codex work-version=2 <bounded delegation note>",
	);
	expect(dispatchSkip(work, [note])).toBeUndefined();
	expect(dispatchSkip({ ...work, version: 3 }, [note])).toContain(
		"owner comment",
	);
	expect(dispatchSkip({ ...work, accountableOwnerId: null }, [note])).toContain(
		"no accountable user owner",
	);
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

function gitFixture(withOrigin = false) {
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
	if (withOrigin) {
		const remote = join(root, "origin.git");
		git(["init", "--bare", remote]);
		git(["remote", "add", "origin", remote]);
		git(["push", "origin", "main"]);
	}
	return { root, repo, git };
}

it.each([false, true])(
	"refreshes a stale source before cutting a run (retry=%s)",
	(retry) => {
		const { root, repo, git } = gitFixture(true);
		const destination = join(root, "repo");
		if (retry) git(["worktree", "add", "--detach", destination]);
		const stale = git(["rev-parse", "HEAD"]);
		const publisher = join(root, "publisher");
		git(["clone", "--branch", "main", join(root, "origin.git"), publisher]);
		writeFileSync(join(publisher, "fresh.txt"), "latest main");
		git(["add", "fresh.txt"], publisher);
		git(
			[
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-m",
				"advance main",
			],
			publisher,
		);
		git(["push", "origin", "main"], publisher);
		const current = git(["rev-parse", "HEAD"], publisher);
		expect(git(["rev-parse", "origin/main"])).toBe(stale);
		expect(provisionLaneWorktree(repo, destination)).toBe(destination);
		expect(git(["rev-parse", "HEAD"], destination)).toBe(current);
		expect(git(["rev-parse", "HEAD"])).toBe(current);
		expect(readFileSync(join(destination, "fresh.txt"), "utf8")).toBe(
			"latest main",
		);
	},
	30_000,
);

it.each(["dirty", "unlanded"])(
	"bases runs on origin/main while preserving a %s source",
	(state) => {
		const { root, repo, git } = gitFixture(true);
		const stale = git(["rev-parse", "HEAD"]);
		git([
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			"advance main",
		]);
		git(["push", "origin", "main"]);
		const current = git(["rev-parse", "origin/main"]);
		git(["checkout", "--detach", stale]);
		writeFileSync(join(repo, "retained.txt"), "source work");
		if (state === "unlanded") {
			git(["add", "retained.txt"]);
			git(["-c", "commit.gpgsign=false", "commit", "-m", "unlanded"]);
		}
		const sourceHead = git(["rev-parse", "HEAD"]);
		const destination = provisionLaneWorktree(repo, join(root, "repo"));
		expect(git(["rev-parse", "HEAD"], destination)).toBe(current);
		expect(git(["rev-parse", "HEAD"])).toBe(sourceHead);
		expect(readFileSync(join(repo, "retained.txt"), "utf8")).toBe(
			"source work",
		);
		expect(existsSync(join(destination, "retained.txt"))).toBe(false);
	},
	30_000,
);

it("does not cut a stale run when origin cannot be fetched", () => {
	const { root, repo, git } = gitFixture(true);
	git(["remote", "set-url", "origin", join(root, "missing.git")]);
	const destination = join(root, "repo");
	expect(() => provisionLaneWorktree(repo, destination)).toThrow();
	expect(existsSync(destination)).toBe(false);
}, 30_000);

it("suppresses worktree checkout progress while provisioning", () => {
	const { root, repo } = gitFixture(true);
	const trace = join(root, "git-trace.json");
	const previousTrace = process.env.GIT_TRACE2_EVENT;
	process.env.GIT_TRACE2_EVENT = trace;
	try {
		provisionLaneWorktree(repo, join(root, "repo"));
	} finally {
		if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
		else process.env.GIT_TRACE2_EVENT = previousTrace;
	}
	const events = readFileSync(trace, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { event: string; argv?: string[] });
	expect(
		events.some(
			(event) =>
				event.event === "start" &&
				event.argv?.includes("worktree") &&
				event.argv.includes("add") &&
				event.argv.includes("--quiet"),
		),
	).toBe(true);
}, 30_000);

it("preserves an orphan destination and provisions the retry path", () => {
	const { root, repo, git } = gitFixture(true);
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
}, 30_000);

it("keeps a dirty registered worktree for inspection and provisions the retry beside it", () => {
	const { root, repo, git } = gitFixture(true);
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
}, 30_000);

it("keeps a registered worktree holding unlanded commits and provisions beside it", () => {
	const { root, repo, git } = gitFixture(true);
	const destination = join(root, "repo");
	git(["worktree", "add", "--detach", destination]);
	git(
		["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "local"],
		destination,
	);
	const local = git(["rev-parse", "HEAD"], destination);
	expect(provisionLaneWorktree(repo, destination)).toBe(`${destination}-2`);
	expect(git(["rev-parse", "HEAD"], destination)).toBe(local);
}, 30_000);

it("reuses a clean registered worktree left by a failed admission at fresh origin/main", () => {
	const { root, repo, git } = gitFixture(true);
	const destination = join(root, "repo");
	git(["worktree", "add", "--detach", destination]);
	git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "next"]);
	git(["push", "origin", "main"]);
	expect(provisionLaneWorktree(repo, destination)).toBe(destination);
	expect(git(["rev-parse", "HEAD"], destination)).toBe(
		git(["rev-parse", "HEAD"]),
	);
	expect(existsSync(`${destination}-2`)).toBe(false);
}, 30_000);

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

it("queries ready work before bounded cleanup of 715 retained runs", async () => {
	const { dispatcher, dir, items, control, releases } = fixture();
	items.splice(1);
	control.cleanupResult = false;
	for (let n = 10; n < 725; n++) {
		const old = item(n);
		const repo = join(dir, "runs", `${old.id}-2`, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(
			join(dir, `${old.id}-2.json`),
			JSON.stringify({
				itemId: old.id,
				version: 2,
				phase: "settled",
				outcome: "failed",
				repo,
			}),
		);
	}
	await dispatcher.tick();
	expect(control.cleanups).toBe(1);
	expect(control.cleanupAfterPickup).toEqual([true]);
	expect(dispatcher.nextTickDelayMs()).toBe(30_000);
	expect(
		existsSync(join(dir, "dispatcher.log")) &&
			readFileSync(join(dir, "dispatcher.log"), "utf8").includes(
				"worktree-retained",
			),
	).toBe(false);
	await until(() => releases.length === 1);
	releases[0]!();
	await dispatcher.drain();
});

it("backs off retained cleanup and archives only removed run metadata", async () => {
	const { dispatcher, restart, dir, items, control } = fixture();
	items.splice(0);
	const repo = join(dir, "runs", "finished", "repo");
	mkdirSync(repo, { recursive: true });
	const path = join(dir, `${item().id}-2.json`);
	writeFileSync(
		path,
		JSON.stringify({
			itemId: item().id,
			version: 2,
			phase: "settled",
			outcome: "failed",
			repo,
		}),
	);
	control.cleanupResult = false;
	await dispatcher.tick();
	await dispatcher.tick();
	expect(control.cleanups).toBe(1);
	expect(existsSync(repo)).toBe(true);
	expect(existsSync(join(dir, "dispatcher.log"))).toBe(false);
	writeFileSync(join(dirname(repo), "last.txt"), "Result in OS");
	control.cleanupResult = true;
	control.cleanupRemoves = true;
	const recovering = restart();
	await recovering.tick();
	await recovering.drain();
	expect(existsSync(dirname(repo))).toBe(false);
	const archived = readdirSync(join(dir, "archive"));
	expect(archived).toHaveLength(1);
	expect(
		readFileSync(join(dir, "archive", archived[0]!, "last.txt"), "utf8"),
	).toBe("Result in OS");
});

it.each(["succeeded", "failed"])(
	"only retries settled failures on the same revision: %s",
	async (outcome) => {
		const { dispatcher, dir, items, releases, events, control } = fixture();
		items.splice(1);
		writeFileSync(
			join(dir, `${item().id}-2.json`),
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "settled",
				outcome,
				attemptId: "old-attempt",
				retryAt: 0,
			}),
		);
		control.history.data = [
			{ id: "old-attempt", outcome, metadata: { dispatchVersion: 2 } },
		];
		await dispatcher.tick();
		if (outcome === "failed") {
			await until(() => releases.length === 1);
			releases[0]!();
		}
		await dispatcher.drain();
		expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
			outcome === "failed" ? 1 : 0,
		);
	},
);

it.each(["dirty", "unlanded", "live", "locked", "ignored", "landed"])(
	"cleanup protects work and uses origin/main: %s",
	async (state) => {
		const { root, repo, git } = gitFixture(true);
		const destination = join(root, "runs", "finished", "repo");
		git(["worktree", "add", "--detach", destination]);
		if (state === "dirty")
			writeFileSync(join(destination, "unfinished.txt"), "keep");
		if (state === "unlanded" || state === "landed") {
			git(
				[
					"-c",
					"commit.gpgsign=false",
					"commit",
					"--allow-empty",
					"-m",
					"run work",
				],
				destination,
			);
			if (state === "landed") {
				git(["push", "origin", "HEAD:main"], destination);
				git(["fetch", "origin", "main"]);
				expect(git(["rev-parse", "HEAD"])).not.toBe(
					git(["rev-parse", "HEAD"], destination),
				);
			}
		}
		if (state === "locked") git(["worktree", "lock", destination]);
		if (state === "ignored") {
			writeFileSync(join(destination, ".gitignore"), ".env\n");
			git(["add", ".gitignore"], destination);
			git(
				["-c", "commit.gpgsign=false", "commit", "-m", "ignore local settings"],
				destination,
			);
			git(["push", "origin", "HEAD:main"], destination);
			git(["fetch", "origin", "main"]);
			writeFileSync(join(destination, ".env"), "LOCAL_SETTING=keep");
		}
		expect(
			await cleanupLaneWorktree(repo, destination, () => state === "live"),
		).toBe(state === "landed");
		expect(existsSync(destination)).toBe(state !== "landed");
	},
);

it("keeps polling and picking up unrelated work while a large worktree is removed", async () => {
	const { dispatcher, dir, items, control, releases } = fixture();
	const ready = items.splice(0);
	const old = item(99);
	const repo = join(dir, "runs", "old", "repo");
	mkdirSync(repo, { recursive: true });
	writeFileSync(
		join(dir, `${old.id}-2.json`),
		JSON.stringify({
			itemId: old.id,
			version: 2,
			phase: "settled",
			outcome: "succeeded",
			repo,
		}),
	);
	let finish!: (value: boolean) => void;
	control.cleanupWait = new Promise<boolean>((resolve) => {
		finish = resolve;
	});
	await dispatcher.tick();
	expect(control.cleanups).toBe(1);
	items.push(ready[0]!);
	try {
		await dispatcher.tick();
		await until(() => releases.length === 1);
		expect(control.cleanups).toBe(1);
	} finally {
		finish(false);
		for (const release of releases) release();
		await dispatcher.drain();
	}
});

it("detects a live process inside a landed worktree independently of its receipt", async () => {
	const { root, repo, git } = gitFixture(true);
	const destination = join(root, "runs", "old", "repo");
	git(["worktree", "add", "--detach", destination]);
	const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
		cwd: destination,
		detached: true,
		stdio: "ignore",
	});
	await once(child, "spawn");
	try {
		expect(await cleanupLaneWorktree(repo, destination)).toBe(false);
		expect(existsSync(destination)).toBe(true);
	} finally {
		const ended = once(child, "exit");
		process.kill(-child.pid!, "SIGTERM");
		await ended;
	}
});

it("keeps even an empty pending-proof marker fenced from retry and cleanup", async () => {
	const { dispatcher, dir, items, releases, control } = fixture();
	items.splice(1);
	const repo = join(dir, "runs", "pending", "repo");
	mkdirSync(repo, { recursive: true });
	writeFileSync(
		join(dir, `${item().id}-2.json`),
		JSON.stringify({
			itemId: item().id,
			version: 2,
			phase: "settled",
			outcome: "failed",
			pendingCommitProof: "",
			repo,
		}),
	);
	await dispatcher.tick();
	await dispatcher.drain();
	expect(releases).toHaveLength(0);
	expect(control.cleanups).toBe(0);
	expect(existsSync(repo)).toBe(true);
});

it.each(["failed", "stopped"] as const)(
	"backs off and holds three identical admitted %s runs across restarts",
	async (outcome) => {
		const f = fixture();
		f.items.splice(1);
		f.control.telemetryOutcome = outcome;
		f.control.exitCode = outcome === "failed" ? 1 : 0;
		const path = join(f.dir, `${item().id}-2.json`);
		for (let n = 1; n <= 3; n++) {
			const dispatcher = f.restart();
			await dispatcher.tick();
			await until(() => f.releases.length === n);
			f.releases[n - 1]!();
			await dispatcher.drain();
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.outcome).toBe(outcome === "stopped" ? "expired" : "failed");
			expect(saved.retries).toBe(n);
			expect(saved.identicalFailures).toBe(n);
			expect(saved.held).toBe(n === 3);
			expect(saved.retryAt - Date.now()).toBeGreaterThan(
				60_000 * 2 ** (n - 1) - 2000,
			);
			const count = f.releases.length;
			await dispatcher.tick();
			await dispatcher.drain();
			expect(f.releases).toHaveLength(count);
			f.control.history.data = [
				{
					id: saved.attemptId,
					externalSessionKey: saved.session,
					outcome: saved.outcome,
					metadata: { dispatchVersion: 2 },
				},
			];
			saved.retryAt = 0;
			writeFileSync(path, JSON.stringify(saved));
		}
		await f.restart().tick();
		expect(f.releases).toHaveLength(3);
		expect(f.events.filter((e) => e.verb === "comment")).toHaveLength(1);
	},
);

it("does not charge settlement retries as additional execution failures", async () => {
	const f = fixture({ failSettle: true });
	f.items.splice(1);
	f.control.exitCode = 1;
	f.control.telemetryOutcome = "failed";
	await f.dispatcher.tick();
	await until(() => f.releases.length === 1);
	f.releases[0]!();
	await f.dispatcher.drain();
	const path = join(f.dir, `${item().id}-2.json`);
	const saved = JSON.parse(readFileSync(path, "utf8"));
	f.control.history.data = [
		{
			id: saved.attemptId,
			externalSessionKey: saved.session,
			outcome: null,
			expiresAt: new Date(Date.now() + 300000).toISOString(),
		},
	];
	saved.retryAt = 0;
	writeFileSync(path, JSON.stringify(saved));
	await f.restart().tick();
	const retained = JSON.parse(readFileSync(path, "utf8"));
	expect(retained).toMatchObject({
		phase: "settling",
		retries: 1,
		identicalFailures: 1,
		settlementRetries: 2,
		held: false,
	});
	expect(f.releases).toHaveLength(1);
});
