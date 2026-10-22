import assert from "node:assert/strict";
const bunTestModule = "bun:test";
const { mock } = await import(bunTestModule);
let pushes = 0;
let fail = false;
let duringPush: (() => void) | undefined;
let remoteEntries: any[] = [];
mock.module("./workspace", () => ({
	utcDateSlug: (ts: number) => new Date(ts).toISOString().slice(0, 10),
	commitDailyLogEntries: async (_: unknown, opts: any) => {
		pushes++;
		const entries = opts.batches.flatMap((b: any) => b.entries);
		assert.ok(entries.length <= 50);
		duringPush?.();
		duringPush = undefined;
		remoteEntries.push(...entries);
		if (fail) throw new Error("lost push response");
		return {
			commitOid: "a".repeat(40),
			pushedRefs: {},
			acknowledgedRef: "refs/heads/main",
			fileCount: 1,
		};
	},
}));
mock.module("./artifacts-git", () => ({
	readFileFromRepo: async (
		_: unknown,
		_a: unknown,
		_n: unknown,
		_t: unknown,
		_s: unknown,
		path: string,
	) =>
		remoteEntries
			.filter((e) => path.includes(new Date(e.ts).toISOString().slice(0, 10)))
			.map(
				(e) =>
					`\n## ${new Date(e.ts).toISOString()}  ${e.role}  \`${e.turnId}\`\n\n${e.content.trim()}\n\n---\n`,
			)
			.join(""),
}));
const {
	enqueueDailyLogPair,
	onDailyLogFlush,
	readDailyLogQueue,
	DAILY_LOG_QUEUE_CAP,
} = await import("./runtime-memory-effects");
function fixture() {
	const rows = new Map<string, any>();
	const kv = {
		get: (k: string) => structuredClone(rows.get(k)),
		put: (k: string, v: any) => {
			rows.set(k, structuredClone(v));
		},
		delete: (k: string) => rows.delete(k),
		list: ({ prefix }: any) =>
			new Map(
				[...rows]
					.filter(([k]) => k.startsWith(prefix))
					.sort(([a], [b]) => a.localeCompare(b)),
			),
	};
	const host: any = {
		state: { pendingDailyEntries: [], tediId: "fixture", slug: "fixture" },
		ctx: {
			storage: {
				kv,
				transactionSync: (fn: any) => fn(),
				get: async (k: string) => kv.get(k),
				put: async (k: string, v: any) => kv.put(k, v),
				list: async ({ prefix, startAfter, limit }: any) =>
					new Map(
						[...rows]
							.filter(
								([k]) =>
									k.startsWith(prefix) && (!startAfter || k > startAfter),
							)
							.sort(([a], [b]) => a.localeCompare(b))
							.slice(0, limit),
					),
			},
		},
		env: { ARTIFACTS: {}, CF_ACCOUNT_ID: "example" },
		dailyLogWriteLock: Promise.resolve(),
		setState(v: any) {
			this.state = v;
		},
		assertChatTurnActive: async () => {},
		ensureIdentity: async () => {},
		admittedEffectPort: (v: any) => v,
		runtimeAdmission: () => null,
	};
	return {
		host,
		rows,
		enqueue(i: number) {
			enqueueDailyLogPair.call(
				host,
				{ ts: i * 2 + 1, role: "user", content: `question ${i}` },
				{ ts: i * 2 + 2, role: "assistant", content: `answer ${i}` } as any,
			);
		},
	};
}
{
	const f = fixture();
	for (let i = 0; i < 750; i++) f.enqueue(i);
	const queue = readDailyLogQueue(f.host);
	assert.ok(queue.length <= DAILY_LOG_QUEUE_CAP);
	assert.equal(f.host.state.pendingDailyEntries.length, 0);
	assert.match(queue[0]!.entry.content, /folded|summary/i);
	const before = queue.length;
	duringPush = () => f.enqueue(9999);
	await onDailyLogFlush.call(f.host, "flush-1");
	assert.ok(readDailyLogQueue(f.host).length <= before - 50 + 2);
	assert.ok(
		readDailyLogQueue(f.host).some((r) => r.entry.content === "answer 9999"),
	);
	while (readDailyLogQueue(f.host).length)
		await onDailyLogFlush.call(f.host, `flush-${pushes + 1}`);
	assert.equal(readDailyLogQueue(f.host).length, 0);
}
{
	const f = fixture();
	f.enqueue(10000);
	fail = true;
	await assert.rejects(onDailyLogFlush.call(f.host, "lost"), /lost push/);
	assert.ok(f.rows.has("runtime-admission-artifacts-pending"));
	fail = false;
	f.enqueue(10001);
	await onDailyLogFlush.call(f.host, "next");
	assert.equal(readDailyLogQueue(f.host).length, 0);
	assert.equal(f.rows.has("runtime-admission-artifacts-pending"), false);
	assert.ok(f.rows.get("runtime-admission-artifacts:lost"));
}
{
	const f = fixture();
	f.host.state.pendingDailyEntries = Array.from({ length: 1240 }, (_, i) => ({
		ts: i,
		role: "user",
		content: "legacy",
		turnId: `legacy-${i}`,
	}));
	assert.ok(readDailyLogQueue(f.host).length <= DAILY_LOG_QUEUE_CAP);
	assert.deepEqual(f.host.state.pendingDailyEntries, []);
}
console.log(
	"PASS bounded daily queue, migration, batch drain, concurrent enqueue and uncertain push recovery",
);
{
	const f = fixture();
	f.enqueue(20000);
	fail = true;
	await assert.rejects(
		onDailyLogFlush.call(f.host, "missing-remote"),
		/lost push/,
	);
	remoteEntries = [];
	fail = false;
	await onDailyLogFlush.call(f.host, "retry-missing");
	assert.equal(
		readDailyLogQueue(f.host).length,
		0,
		"remote absence retries the original batch",
	);
	f.enqueue(20001);
	const priorPushes = pushes;
	await onDailyLogFlush.call(f.host, "missing-remote");
	assert.equal(
		pushes,
		priorPushes,
		"an acknowledged original run never drains another batch",
	);
	assert.equal(readDailyLogQueue(f.host).length, 2);
}
{
	const f = fixture();
	const snapshot = Array.from({ length: 120 }, (_, i) => ({
		ts: i,
		role: "user" as const,
		content: `old push ${i}`,
		turnId: `old-${i}`,
	}));
	f.rows.set("runtime-admission-artifacts-pending", {
		runId: "legacy-push",
		snapshot,
		stage: "running",
	});
	remoteEntries = [];
	await assert.rejects(
		onDailyLogFlush.call(f.host, "legacy-push"),
		/reconciliation remains pending/,
	);
	assert.equal(
		f.rows.get("runtime-admission-artifacts-pending").snapshot.length,
		70,
	);
	await assert.rejects(
		onDailyLogFlush.call(f.host, "legacy-push"),
		/reconciliation remains pending/,
	);
	await onDailyLogFlush.call(f.host, "legacy-push");
	assert.equal(f.rows.has("runtime-admission-artifacts-pending"), false);
	assert.equal(
		remoteEntries.length,
		120,
		"legacy unbounded push is recovered in bounded chunks",
	);
}

{
	const { memoryDiagnostics } = await import("./runtime-diagnostics");
	const f = fixture();
	f.enqueue(30000);
	f.host.compiledDirectives = [{}];
	for (let i = 0; i < 125; i++)
		f.rows.set(`tedix:pi:maintenance:fire:${String(i).padStart(3, "0")}`, {
			stage: i % 2 ? "completed" : "uncertain",
		});
	const memory = await memoryDiagnostics(f.host);
	assert.deepEqual(memory, {
		pendingDailyEntries: 2,
		lastFlushAt: null,
		lastFlushError: null,
		compiledDirectives: 1,
		lastDirectiveCompileAt: null,
		uncertainMaintenanceFires: 63,
	});
}
{
	const { compileBrainDigest } = await import("./brain/brain-digest");
	const result = await compileBrainDigest(
		{
			getDomains: async () => new Map(),
			memorySearch: async () => ({
				results: Array.from({ length: 30 }, (_, i) => ({
					factId: `f${i}`,
					score: 1,
					fact: {
						summary: `fact ${i}`,
						content: "x".repeat(100000),
						confidence: 1,
					},
				})),
			}),
		} as any,
		{
			model: "fixture",
			llm: {
				chat: async (input: any) => {
					const chars = input.messages.reduce(
						(n: number, m: any) => n + m.content.length,
						0,
					);
					assert.ok(chars < 27000, `digest input bounded: ${chars}`);
					return {
						content: "## Knowledge Digest\n" + "bounded facts ".repeat(10),
					};
				},
			},
		},
	);
	assert.equal(result?.factCount, 30);
}
