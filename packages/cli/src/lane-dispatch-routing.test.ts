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
		max: 1,
		rules: "rules",
		repo: dir,
		scope: ["--workspace", "acme", "--organization", "org_acme"],
		once: true,
		install: false,
	};
	const control = {
		budgets: {} as ExecutorBudgets,
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
	let sequence = 0;
	const create = () =>
		new LaneDispatcher(options, dir, {
			darkWake: () => false,
			available: () => true,
			devinAvailable: () => true,
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
				if (verb === "dispatch-list")
					response = { data: [item], pagination: { hasMore: false } };
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
					finalMessage: `${control.message}\nTEDIX_LANE_RESULT ${JSON.stringify({ outcome: "completed", workItemId: item.id, workVersion: item.version, contractVersion: item.acceptanceContract!.version, outcomeText: item.acceptanceContract!.doneLooksLike })}`,
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
	const receiptPath = join(dir, `${item.id}-1.json`);
	const retry = () => {
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		receipt.retryAt = 0;
		writeFileSync(receiptPath, JSON.stringify(receipt));
		return receipt;
	};
	return { dir, item, control, create, receiptPath, retry };
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
	expect(JSON.parse(readFileSync(receiptPath, "utf8")).retryAt).toBeGreaterThan(
		Date.now(),
	);
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
