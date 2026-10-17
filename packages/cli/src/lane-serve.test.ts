import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	LaneDispatcher,
	retainedLaneWorktree,
	dispatchSkip,
	parseServeOptions,
	serialCalls,
	type DispatchItem,
	type ServeOptions,
} from "./lane-serve";
import { laneServicePlist } from "./lane-service";
import { laneChildEnv } from "./lane-child-env";

const projectId = "11111111-1111-4111-8111-111111111111";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const item = (n = 1): DispatchItem => ({
	id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
	title: "Summarize the guide",
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
	executor = "codex" as ServeOptions["executor"],
} = {}) {
	const dir = mkdtempSync(join(tmpdir(), "lane-dispatch-test-"));
	dirs.push(dir);
	const items = [item(1), item(2), item(3)].map((row) => ({
		...row,
		metadata: { executor },
	}));
	const events: Array<{
		verb: string;
		env: NodeJS.ProcessEnv;
		input?: Record<string, unknown>;
	}> = [];
	const releases: Array<() => void> = [];
	let threadNumber = 0;
	const dispatcher = new LaneDispatcher({ ...options, executor }, dir, {
		darkWake: () => dark,
		provision: () => {},
		cleanup: () => true,
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
			events.push({ verb, env, input });
			if (verb === "dispatch-list") expect(input.dispatchReadyOnly).toBe(true);
			let response: unknown;
			if (verb === "dispatch-list")
				response = { data: items, pagination: { hasMore: false } };
			else if (verb === "dispatch-get")
				response = {
					workItem: items.find((row) => row.id === args[6]),
					comments: [],
				};
			else if (verb === "dispatch-attempts") response = { data: [] };
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
				if (refuse) throw new Error("Admission refused: resource capacity");
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
			const brief = readFileSync(args[args.indexOf("--brief") + 1]!, "utf8");
			expect(deps?.cwd).toBe(
				join(dirname(args[args.indexOf("--brief") + 1]!), "repo"),
			);
			expect(args.slice(args.indexOf("--") + 1)).toEqual(
				executor === "claude-code"
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
			await new Promise<void>((done) => releases.push(done));
			deps?.onTelemetry?.({
				executor,
				model: "test-model",
				provider: "test-provider",
				reasoningEffort: null,
				brief: "test",
				startedAt: "2026-10-01T00:00:00.000Z",
				heartbeatAt: "2026-10-01T00:00:01.000Z",
				finishedAt: "2026-10-01T00:00:01.000Z",
				outcome: "succeeded",
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
	});
	return { dispatcher, dir, events, releases };
}
async function until(test: () => boolean) {
	for (let n = 0; n < 100 && !test(); n++)
		await new Promise((done) => setTimeout(done, 2));
	expect(test()).toBe(true);
}

describe("dispatcher admission", () => {
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
	it("never launches after admission refusal and does not retry the revision", async () => {
		const { dispatcher, releases } = fixture({ refuse: true });
		await dispatcher.tick();
		await dispatcher.drain();
		await dispatcher.tick();
		await dispatcher.drain();
		expect(releases).toHaveLength(0);
	});
	it("does nothing during dark wake", async () => {
		const { dispatcher, events } = fixture({ dark: true });
		await dispatcher.tick();
		expect(events).toHaveLength(0);
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
it("validates concurrency and pins selectors without persisting inherited identity or credentials", () => {
	const args = ["--executor", "codex", "--rules", projectId];
	const env = { TEDIX_WORKSPACE: "acme", TEDIX_ORGANIZATION: "org_acme" };
	expect(parseServeOptions(args, env).max).toBe(5);
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
