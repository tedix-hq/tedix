import { afterEach, expect, it } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LaneDispatcher,
	type DispatchItem,
	type ServeOptions,
} from "./lane-serve";
import type { ExecutorBudgets, LocalExecutor } from "./lane-routing";
import type { RunnerDuty } from "./supervise-runners";
import { testRoutingPolicy } from "./lane-routing.fixture";
const dirs: string[] = [];
afterEach(() => {
	for (const path of dirs.splice(0))
		rmSync(path, { recursive: true, force: true });
});
function fixture(configured = true) {
	const dir = mkdtempSync(join(tmpdir(), "lane-route-integration-"));
	dirs.push(dir);
	const routingConfig = join(dir, "routing.json");
	writeFileSync(routingConfig, JSON.stringify(testRoutingPolicy));
	const item: DispatchItem = {
		id: "11111111-1111-4111-8111-111111111111",
		title: "Inspect a widget",
		description: "Record findings",
		workKind: "research",
		disposition: "accepted",
		version: 1,
		projectId: "22222222-2222-4222-8222-222222222222",
		startAt: null,
		acceptanceContract: { version: 1, doneLooksLike: "Record findings" },
		metadata: { executor: "any-local" },
		accountableOwnerType: null,
		accountableOwnerId: null,
	};
	const options: ServeOptions = {
		executor: "any-local",
		...(configured ? { routingConfig } : {}),
		coordinated: false,
		acceptProposed: false,
		rules: "rules",
		repo: dir,
		scope: ["--workspace", "acme", "--organization", "org_acme"],
		once: true,
		install: false,
	};
	const control = {
		budgets: {} as ExecutorBudgets,
		preflightFailures: {} as Partial<Record<LocalExecutor, string>>,
		message: "Verified",
		nativeError: undefined as Error | undefined,
		workError: undefined as Error | undefined,
		exit: 0,
		stopped: false,
		missing: false,
		history: [] as Record<string, unknown>[],
		threads: [] as Array<{ executor: LocalExecutor; resume?: string }>,
		launches: [] as string[][],
		events: [] as string[],
	};
	const duties: RunnerDuty[] = [];
	let sequence = 0;
	const create = (overrides: Partial<ServeOptions> = {}) => {
		if (overrides.executor)
			mkdirSync(join(dir, overrides.executor), { recursive: true });
		const config = { ...options, ...overrides };
		const directory = overrides.executor ? join(dir, overrides.executor) : dir;
		return new LaneDispatcher(config, directory, {
			runners: () => duties,
			createHeartbeat: () => async () => ({
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
			}),
			createStepSender: () => async () => ({ accepted: 0, pending: [] }),
			health: () => [],
			darkWake: () => false,
			available: () => ({ available: true }),
			preflight: async (executor) => control.preflightFailures[executor],
			devinAvailability: () => ({ available: true }),
			budgets: () => control.budgets,
			baseCommit: () => "a".repeat(40),
			landedCommits: async () => [],
			cleanup: () => false,
			provision: (_source, destination) => {
				mkdirSync(destination, { recursive: true });
				return destination;
			},
			thread: async (_repo, executor, model, resume) => {
				control.events.push("native");
				if (control.nativeError) throw control.nativeError;
				control.threads.push({ executor, resume });
				if (resume && control.missing) throw new Error("rollout not found");
				return {
					thread: {
						id:
							resume ??
							(executor === "opencode"
								? "ses_0123456789abABCDEFGHIJKLMN"
								: `33333333-3333-4333-8333-${String(++sequence).padStart(12, "0")}`),
						cliVersion: "1.2.3",
					},
					model: model?.split("/").at(-1) ?? "test-model",
					modelProvider: executor === "opencode" ? "example" : "test-provider",
				};
			},
			cli: async <T>(args: string[]): Promise<T> => {
				const verb = args[5]!;
				control.events.push(verb);
				let response: unknown = {};
				if (verb === "dispatch-list") {
					const query = JSON.parse(args[args.indexOf("--input") + 1]!);
					const executors = Array.isArray(query.executor)
						? query.executor
						: [query.executor];
					response = {
						data: executors.includes(item.executorId ?? item.metadata?.executor)
							? [item]
							: [],
						pagination: { hasMore: false },
					};
				}
				if (verb === "dispatch-reassign") {
					const input = JSON.parse(args[args.indexOf("--input") + 1]!);
					if (
						(item.executorId ?? item.metadata?.executor) !==
						input.idleReassignment.fromExecutor
					)
						throw new Error("Stale assignment");
					item.executorId = input.executor;
					item.metadata = {
						...item.metadata,
						idleReassignment: {
							reason: "chosen",
							version: item.version,
							detail: input.idleReassignment.detail,
						},
					};
				}
				if (verb === "dispatch-get")
					response = { workItem: item, comments: [] };
				if (verb === "dispatch-attempts")
					response = { data: control.history, nextCursor: null };
				if (verb === "show")
					response = {
						id: "rules",
						revision: 1,
						content: "Keep scope",
						lifecycleState: "active",
					};
				if (verb === "readiness") response = { ready: true };
				if (verb === "runner-rules")
					response = { rules: { content: "Own the Attempt", version: 1 } };
				if (verb === "start" && args[4] !== "agent" && control.workError)
					throw control.workError;
				if (verb === "start")
					response =
						args[4] === "agent"
							? { principalKey: "local-acme" }
							: {
									workItem: item,
									attempt: {
										id: "prior-attempt",
										expiresAt: new Date(Date.now() + 300000).toISOString(),
									},
								};
				return response as T;
			},
			launch: async (args, deps) => {
				control.events.push("launch");
				control.launches.push(args);
				const at = new Date().toISOString();
				const result = JSON.stringify({
					outcome: "completed",
					workItemId: item.id,
					workVersion: item.version,
					contractVersion: item.acceptanceContract!.version,
					outcomeText: item.acceptanceContract!.doneLooksLike,
				});
				if (args[args.indexOf("--executor") + 1] === "codex")
					writeFileSync(args[args.indexOf("-o") + 1]!, result);
				deps?.onTelemetry?.({
					executor: args[args.indexOf("--executor") + 1] as LocalExecutor,
					model: "test-model",
					provider: "test-provider",
					reasoningEffort: null,
					brief: "",
					startedAt: at,
					heartbeatAt: at,
					finishedAt: at,
					outcome: control.stopped
						? "stopped"
						: control.exit
							? "failed"
							: "succeeded",
					finalMessage: `${control.message}\nTEDIX_LANE_RESULT ${result}`,
					tools: {},
					usage: null,
					shas: [],
					workItems: [],
					corrections: [],
					source: "wrapper",
				});
				return control.exit;
			},
		});
	};
	const receiptPath = join(dir, `${item.id}-1.json`);
	const retry = () => {
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		receipt.recheckAt = 0;
		writeFileSync(receiptPath, JSON.stringify(receipt));
		return receipt;
	};
	return { dir, item, control, create, receiptPath, retry, duties, options };
}
it("retains unconfigured automatic Work without native allocation or admission", async () => {
	const { control, create, receiptPath } = fixture(false);
	const dispatcher = create();
	await dispatcher.tick();
	await dispatcher.drain();
	expect(control.threads).toEqual([]);
	expect(control.launches).toEqual([]);
	expect(control.events).not.toContain("native");
	expect(control.events).not.toContain("start");
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
	expect(receipt.phase).toBe("deferred");
	expect(receipt.note).toContain("--routing-config");
});
it("uses a healthy route when the first executor fails pre-flight", async () => {
	const { control, create } = fixture();
	control.preflightFailures.codex = "network check failed";
	const dispatcher = create();
	await dispatcher.tick();
	await dispatcher.drain();
	expect(control.threads.map(({ executor }) => executor)).toEqual([
		"claude-code",
	]);
	expect(control.launches).toHaveLength(1);
});
it("routes an any-local Work around a Codex cooldown and Claude allowance reserve and launches native OpenCode after admission", async () => {
	const { control, create } = fixture();
	for (const executor of ["codex", "claude-code"] as const)
		control.budgets[executor] = {
			source: "native",
			observedAt: Date.now(),
			remainingPercent: 1,
			...(executor === "codex" ? { backoffUntil: Date.now() + 60_000 } : {}),
		};
	const dispatcher = create();
	await dispatcher.tick();
	await dispatcher.drain();
	expect(control.threads[0]?.executor).toBe("opencode");
	const args = control.launches[0]!;
	expect(args.slice(args.indexOf("--") + 1)).toContain("opencode");
	expect(args).toContain("example/general");
	expect(control.events.indexOf("native")).toBeLessThan(
		control.events.indexOf("start"),
	);
	expect(control.events.lastIndexOf("start")).toBeLessThan(
		control.events.indexOf("launch"),
	);
});
it("persists rate-limit cooldown across restarts and routes the next turn elsewhere", async () => {
	const { control, create, retry } = fixture();
	control.message = "429 rate limit retry-after: 300";
	control.exit = 1;
	const first = create();
	await first.tick();
	await first.drain();
	const receipt = retry();
	expect(receipt.phase).toBe("deferred");
	control.history = [
		{
			id: "prior-attempt",
			outcome: "failed",
			externalSessionKey: receipt.session,
		},
	];
	control.message = "Verified";
	control.exit = 0;
	const second = create();
	await second.tick();
	await second.drain();
	expect(control.threads.map((t) => t.executor)).toEqual([
		"codex",
		"claude-code",
	]);
});
it("resumes interrupted native state, allocating fresh only when that rollout is missing", async () => {
	const { control, create, retry, receiptPath } = fixture();
	control.stopped = true;
	control.exit = 1;
	const dispatcher = create();
	await dispatcher.tick();
	await dispatcher.drain();
	const receipt = retry();
	expect(receipt.outcome).toBe("expired");
	control.history = [
		{
			id: "prior-attempt",
			outcome: "expired",
			externalSessionKey: receipt.session,
		},
	];
	control.stopped = false;
	control.exit = 0;
	control.missing = true;
	await dispatcher.tick();
	await dispatcher.drain();
	expect(control.threads[1]?.resume).toBe(
		receipt.session.slice("codex:".length),
	);
	expect(control.threads[2]?.resume).toBeUndefined();
	expect(JSON.parse(readFileSync(receiptPath, "utf8")).outcome).toBe(
		"succeeded",
	);
});
it("reaps only canonically expired dead runs before resuming their retained worktree", async () => {
	const { dir, control, create, receiptPath, retry } = fixture();
	const repo = join(dir, "runs", "prior", "repo");
	mkdirSync(repo, { recursive: true });
	const session = "codex:33333333-3333-4333-8333-000000000001";
	writeFileSync(
		receiptPath,
		JSON.stringify({
			itemId: "11111111-1111-4111-8111-111111111111",
			version: 1,
			phase: "running",
			attemptId: "prior-attempt",
			session,
			repo,
			baseCommit: "a".repeat(40),
		}),
	);
	control.history = [
		{ id: "prior-attempt", outcome: "expired", externalSessionKey: session },
	];
	const dispatcher = create();
	await dispatcher.tick();
	await dispatcher.drain();
	expect(control.threads).toHaveLength(0);
	expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
		phase: "deferred",
		outcome: "expired",
	});
	retry();
	await dispatcher.tick();
	await dispatcher.drain();
	expect(control.threads[0]?.resume).toBe(session.slice("codex:".length));
});

it("readmits with fresh identity when a rollout disappears after allocation", async () => {
	const { control, create, retry } = fixture();
	control.message = "rollout not found";
	control.exit = 1;
	const dispatcher = create();
	await dispatcher.tick();
	await dispatcher.drain();
	const receipt = retry();
	expect(receipt.phase).toBe("deferred");
	control.history = [
		{
			id: "prior-attempt",
			outcome: "failed",
			externalSessionKey: receipt.session,
		},
	];
	control.message = "Verified";
	control.exit = 0;
	control.missing = true;
	await dispatcher.tick();
	await dispatcher.drain();
	expect(control.threads[1]?.resume).toBe(
		receipt.session.slice("codex:".length),
	);
	expect(control.threads[2]?.resume).toBeUndefined();
});

it("does not misclassify shared Work admission limits as executor quota", async () => {
	const { dir, control, create } = fixture();
	control.workError = new Error("429 shared Work admission rate limit");
	const dispatcher = create();
	await dispatcher.tick();
	await dispatcher.drain();
	expect(
		JSON.parse(readFileSync(join(dir, "budgets.state"), "utf8")).codex
			?.backoffUntil,
	).toBeUndefined();
});
it("records native allocation limits before any Work admission", async () => {
	const { dir, control, create } = fixture();
	control.nativeError = new Error("429 native rate limit");
	const dispatcher = create();
	await dispatcher.tick();
	await dispatcher.drain();
	expect(
		JSON.parse(readFileSync(join(dir, "budgets.state"), "utf8")).codex
			.backoffUntil,
	).toBeGreaterThan(Date.now());
	expect(control.events).not.toContain("start");
});

it("does not back off a successful result merely mentioning rate-limit handling", async () => {
	const { dir, control, create } = fixture();
	control.message = "Verified rate-limit handling";
	const dispatcher = create();
	await dispatcher.tick();
	await dispatcher.drain();
	expect(
		JSON.parse(readFileSync(join(dir, "budgets.state"), "utf8")).codex
			?.backoffUntil,
	).toBeUndefined();
});

it("keeps interrupted coding Work resumable without requiring a success commit", async () => {
	const { item, control, create, receiptPath } = fixture();
	item.workKind = "coding";
	control.stopped = true;
	control.exit = 1;
	const dispatcher = create();
	await dispatcher.tick();
	await dispatcher.drain();
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
	expect(receipt.outcome).toBe("expired");
	expect(receipt.phase).toBe("deferred");
	expect(receipt.note).not.toContain("No landed commit");
});
it("a stopping drain gives up at its deadline instead of holding the lane for a whole model turn", async () => {
	const { create } = fixture();
	const dispatcher = create();
	const running = (
		dispatcher as unknown as { running: Map<string, Promise<void>> }
	).running;
	const id = "33333333-3333-4333-8333-333333333333";
	running.set(id, new Promise<void>(() => {}));
	expect(await dispatcher.drain(20)).toBe(false);
	expect(dispatcher.inFlight()).toEqual([id]);
	running.clear();
	expect(await dispatcher.drain(20)).toBe(true);
});

it.each([false, true])(
	"coordinated runners select Auto once and admit only on the chosen runner (first preflight fails: %s)",
	async (preflightFails) => {
		const f = fixture();
		f.item.executorType = "external_agent";
		f.item.executorId = "any-local";
		f.item.dispatchState = "ready";
		for (const executor of ["codex", "claude-code"] as const)
			f.duties.push({
				workspace: "acme",
				organization: "org_acme",
				executor,
				repo: f.dir,
				coordinated: true,
				enabled: true,
				acceptProposed: false,
			});
		if (preflightFails)
			f.control.preflightFailures.codex = "network check failed";
		const chosen = preflightFails ? "claude-code" : "codex";
		const codex = f.create({ executor: "codex", coordinated: true });
		const claude = f.create({ executor: "claude-code", coordinated: true });
		await Promise.all([codex.tick(), claude.tick()]);
		expect(f.item.executorId).toBe(chosen);
		expect(f.item.metadata?.idleReassignment).toMatchObject({
			detail: expect.stringContaining("general"),
		});
		expect(
			f.control.events.filter((event) => event === "dispatch-reassign"),
		).toHaveLength(1);
		await Promise.all([codex.tick(), claude.tick()]);
		await Promise.all([codex.drain(), claude.drain()]);
		expect(f.control.launches).toHaveLength(1);
		expect(f.control.threads.map((thread) => thread.executor)).toEqual([
			chosen,
		]);
	},
);

const autoDuty = (executor: LocalExecutor, repo: string): RunnerDuty => ({
	workspace: "acme",
	organization: "org_acme",
	executor,
	repo,
	coordinated: true,
	enabled: true,
	acceptProposed: false,
});
const markAtCap = (directory: string, executor: LocalExecutor) =>
	writeFileSync(
		join(directory, `at-cap-${executor}.json`),
		JSON.stringify({
			itemId: "99999999-9999-4999-8999-999999999999",
			version: 1,
			phase: "running",
			session: `${executor}:33333333-3333-4333-8333-999999999999`,
		}),
	);
const autoItem = (item: DispatchItem) => {
	item.executorType = "external_agent";
	item.executorId = "any-local";
	item.dispatchState = "ready";
};

it("routes Auto to the sole eligible alternate when the preferred harness is at its cap", async () => {
	const f = fixture();
	autoItem(f.item);
	for (const executor of ["codex", "claude-code"] as const)
		f.duties.push(autoDuty(executor, f.dir));
	writeFileSync(
		join(f.dir, "routing.json"),
		JSON.stringify({
			...testRoutingPolicy,
			tools: {
				codex: { strengths: "large multi-file changes", maxRunning: 1 },
				"claude-code": { strengths: "careful edits" },
			},
		}),
	);
	const codex = f.create({ executor: "codex", coordinated: true });
	const claude = f.create({ executor: "claude-code", coordinated: true });
	for (const directory of [join(f.dir, "codex"), join(f.dir, "claude-code")])
		markAtCap(directory, "codex");
	await Promise.all([codex.tick(), claude.tick()]);
	expect(f.item.executorId).toBe("claude-code");
	expect(
		f.control.events.filter((event) => event === "dispatch-reassign"),
	).toHaveLength(1);
	await Promise.all([codex.tick(), claude.tick()]);
	await Promise.all([codex.drain(), claude.drain()]);
	expect(f.control.launches).toHaveLength(1);
	expect(f.control.threads.map((thread) => thread.executor)).toEqual([
		"claude-code",
	]);
});

it("keeps Auto unassigned while every eligible harness is at its cap", async () => {
	const f = fixture();
	autoItem(f.item);
	for (const executor of ["codex", "claude-code"] as const)
		f.duties.push(autoDuty(executor, f.dir));
	writeFileSync(
		join(f.dir, "routing.json"),
		JSON.stringify({
			...testRoutingPolicy,
			tools: {
				codex: { strengths: "large multi-file changes", maxRunning: 1 },
				"claude-code": { strengths: "careful edits", maxRunning: 1 },
			},
		}),
	);
	const codex = f.create({ executor: "codex", coordinated: true });
	const claude = f.create({ executor: "claude-code", coordinated: true });
	for (const directory of [join(f.dir, "codex"), join(f.dir, "claude-code")]) {
		markAtCap(directory, "codex");
		markAtCap(directory, "claude-code");
	}
	await Promise.all([codex.tick(), claude.tick()]);
	await Promise.all([codex.tick(), claude.tick()]);
	expect(f.item.executorId).toBe("any-local");
	expect(f.control.events).not.toContain("dispatch-reassign");
	expect(f.control.events).not.toContain("choose-tool");
	expect(f.control.launches).toHaveLength(0);
	expect(f.control.threads).toHaveLength(0);
});

it("enforces the running cap on the fallback when tool selection fails", async () => {
	const f = fixture();
	autoItem(f.item);
	for (const executor of ["codex", "claude-code", "opencode"] as const)
		f.duties.push(autoDuty(executor, f.dir));
	writeFileSync(
		join(f.dir, "routing.json"),
		JSON.stringify({
			...testRoutingPolicy,
			tools: {
				codex: { strengths: "large multi-file changes", maxRunning: 1 },
				"claude-code": { strengths: "careful edits" },
				opencode: { strengths: "small routine edits" },
			},
		}),
	);
	const codex = f.create({ executor: "codex", coordinated: true });
	const claude = f.create({ executor: "claude-code", coordinated: true });
	for (const directory of [join(f.dir, "codex"), join(f.dir, "claude-code")])
		markAtCap(directory, "codex");
	await Promise.all([codex.tick(), claude.tick()]);
	expect(f.control.events).toContain("choose-tool");
	expect(f.item.executorId).toBe("claude-code");
	expect(
		f.control.events.filter((event) => event === "dispatch-reassign"),
	).toHaveLength(1);
});

it("leaves Auto work to its project duty in another repository", async () => {
	const f = fixture();
	f.item.executorType = "external_agent";
	f.item.executorId = "any-local";
	f.item.dispatchState = "ready";
	f.duties.push(
		{
			workspace: "acme",
			organization: "org_acme",
			executor: "codex",
			repo: f.dir,
			coordinated: true,
			enabled: true,
			acceptProposed: false,
		},
		{
			workspace: "acme",
			organization: "org_acme",
			executor: "any-local",
			project: f.item.projectId!,
			repo: join(f.dir, "ops"),
			coordinated: false,
			enabled: true,
			acceptProposed: false,
		},
	);
	const runner = f.create({ executor: "codex", coordinated: true });
	await runner.tick();
	await runner.startRequested(f.item.id);
	await runner.drain();
	expect(f.control.events).not.toContain("dispatch-reassign");
	expect(f.control.launches).toHaveLength(0);
});
