import assert from "node:assert/strict";
import type {
	ParentServiceOperation,
	ParentMaintenanceTask,
} from "./pi-parent-services";
const bunTestModule = "bun:test";
const { mock } = await import(bunTestModule);

// Only provider/network/framework boundaries are faked. Exercise the actual
// application delivery state machine against a storage image surviving restarts.
class FakeChat {
	static latest: FakeChat;
	direct!: (...args: any[]) => Promise<void>;
	mention!: (...args: any[]) => Promise<void>;
	action!: (...args: any[]) => Promise<void>;
	constructor(readonly config: any) {
		FakeChat.latest = this;
	}
	onDirectMessage(fn: any) {
		this.direct = fn;
	}
	onNewMention(fn: any) {
		this.mention = fn;
	}
	onSubscribedMessage(_fn: any) {}
	onNewMessage(_pattern: any, _fn: any) {}
	onAction(fn: any) {
		this.action = fn;
	}
	async initialize() {}
	webhooks = { telegram: async () => new Response("ok") };
}
const locks = new Set<string>();
const state = {
	async acquireLock(id: string) {
		if (locks.has(id)) return null;
		locks.add(id);
		return { threadId: id, token: id, expiresAt: Date.now() + 30_000 };
	},
	async releaseLock(lock: any) {
		locks.delete(lock.threadId);
	},
};
let recoveredThread: any;
mock.module("chat", () => ({
	Chat: FakeChat,
	ThreadImpl: { fromJSON: () => recoveredThread },
}));
mock.module("@chat-adapter/telegram", () => ({
	createTelegramAdapter: (config: any) => ({ ...config, botUserId: "bot-1" }),
}));
mock.module("agents/chat-sdk", () => ({
	ChatSdkStateAgent: class {},
	createChatSdkState: (config: any) => {
		assert.equal(config.lockHeartbeat, true);
		return state;
	},
}));
const {
	PiTelegram,
	ParentMaintenanceServices,
	consumeTelegramTurnStream,
	assertLegacyThinkTasksSettled,
	assertLegacyThinkReceiptsSettled,
	maintenanceCompletionReceiptHash,
} = await import("./pi-parent-services");

class Storage {
	rows = new Map<string, any>();
	crash?: (key: string, value: any) => "before" | "after" | undefined;
	sql: any = { exec: () => ({ toArray: () => [] }) };
	async get<T>(key: string): Promise<T | undefined> {
		const value = this.rows.get(key);
		return value === undefined ? undefined : structuredClone(value);
	}
	async put(key: string, value: any) {
		const crash = this.crash?.(key, value);
		if (crash === "before") throw new Error("eviction");
		this.rows.set(key, structuredClone(value));
		if (crash === "after") throw new Error("eviction");
	}
	async transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
		return fn(this);
	}
	async list<T>({ prefix, startAfter, limit }: any): Promise<Map<string, T>> {
		return new Map(
			[...this.rows]
				.filter(
					([key]) =>
						key.startsWith(prefix) && (!startAfter || key > startAfter),
				)
				.sort(([a], [b]) => a.localeCompare(b))
				.slice(0, limit)
				.map(([key, value]) => [key, structuredClone(value)]),
		);
	}
}
const options = {
	token: "123:fake",
	userName: "testbot",
	secretToken: "verified-provider-secret",
};
const author = {
	userId: "human-1",
	userName: "alice",
	fullName: "Alice",
	isMe: false,
	isBot: false,
};
const message = {
	id: "message-1",
	author,
	text: "hello",
	attachments: [],
	isMention: false,
};
function fixture() {
	const storage = new Storage();
	let modelAdmissions = 0;
	let sends = 0;
	const nativeReceipts = new Map<string, string>();
	const fibers = new Map<string, any>();
	const thread = {
		id: "telegram:123",
		channelId: "telegram:123",
		isDM: true,
		toJSON: () => ({
			_type: "chat:Thread",
			adapterName: "telegram",
			id: "telegram:123",
			channelId: "telegram:123",
			isDM: true,
		}),
		subscribe: async () => {},
		startTyping: async () => {},
		async post(body: any) {
			sends++;
			let text = "";
			if (body[Symbol.asyncIterator]) {
				for await (const delta of body) text += delta;
			} else text = body.markdown;
			return { id: `sent-${sends}`, text };
		},
	};
	recoveredThread = thread;
	const host = {
		assertRuntimeActive: async () => {},
		admitAccepted: async () => null,
		assertOriginal: async () => {},
		assertActive: async () => {},
		completeOriginal: async () => {},
		storage: storage as any,
		subAgent: async () => ({}) as any,
		resolveFiber: async () => true,
		async startFiber(_name: string, fn: any, args: any) {
			if (fibers.has(args.idempotencyKey))
				return fibers.get(args.idempotencyKey);
			await fn({ stash() {}, signal: new AbortController().signal });
			const result = { accepted: true, status: "completed" };
			fibers.set(args.idempotencyKey, result);
			return result;
		},
		async runTurn(turn: any, onDelta?: (text: string) => void) {
			const existing = nativeReceipts.get(turn.operationId);
			if (existing) return existing;
			modelAdmissions++;
			assert.equal(turn.metadata.principal.id, "human-1");
			assert.equal(turn.sessionKey, "telegram:telegram:123");
			onDelta?.("Hello ");
			onDelta?.("Alice");
			nativeReceipts.set(turn.operationId, "Hello Alice");
			return "Hello Alice";
		},
	};
	const create = () => new PiTelegram(host as any, options);
	return {
		storage,
		host,
		thread,
		create,
		counts: () => ({ modelAdmissions, sends }),
		nativeReceipts,
	};
}
const tests: [string, () => Promise<void>][] = [];
function test(name: string, fn: () => Promise<void>) {
	tests.push([name, fn]);
}

test("eviction after persisted ingress before fiber admission resumes once with immutable identity", async () => {
	const f = fixture();
	f.host.startFiber = async () => {
		throw new Error("eviction");
	};
	f.create();
	await assert.rejects(
		FakeChat.latest.direct(f.thread, message, undefined, undefined),
		/eviction/,
	);
	assert.deepEqual(f.counts(), { modelAdmissions: 0, sends: 0 });
	const stored = [...f.storage.rows.values()][0];
	assert.equal(stored.stage, "accepted");
	assert.equal(stored.turn.metadata.principal.id, "human-1");
	await f.create().recoverPending();
	assert.deepEqual(f.counts(), { modelAdmissions: 1, sends: 1 });
	await f.create().recoverPending();
	assert.deepEqual(f.counts(), { modelAdmissions: 1, sends: 1 });
});

test("native owned answer survives eviction before send fence without another model admission", async () => {
	const f = fixture();
	f.storage.crash = (_key, value) =>
		value.stage === "sending" ? "before" : undefined;
	f.create();
	await assert.rejects(
		FakeChat.latest.direct(f.thread, message, undefined, undefined),
		/eviction/,
	);
	assert.deepEqual(f.counts(), { modelAdmissions: 1, sends: 0 });
	assert.equal([...f.storage.rows.values()][0].stage, "answered");
	f.storage.crash = undefined;
	await f.create().recoverPending();
	assert.deepEqual(f.counts(), { modelAdmissions: 1, sends: 1 });
});

test("eviction after send fence before external send is uncertain and never automatically replays", async () => {
	const f = fixture();
	f.storage.crash = (_key, value) =>
		value.stage === "sending" ? "after" : undefined;
	f.create();
	await assert.rejects(
		FakeChat.latest.direct(f.thread, message, undefined, undefined),
		/eviction/,
	);
	assert.equal(f.counts().sends, 0);
	f.storage.crash = undefined;
	await f.create().recoverPending();
	assert.equal(f.counts().sends, 0);
	assert.equal([...f.storage.rows.values()][0].stage, "uncertain");
});

test("reply receipt survives eviction before completion marker without duplicate inference or send", async () => {
	const f = fixture();
	f.storage.crash = (_key, value) =>
		value.stage === "completed" ? "before" : undefined;
	f.create();
	await assert.rejects(
		FakeChat.latest.direct(f.thread, message, undefined, undefined),
		/eviction/,
	);
	assert.deepEqual(f.counts(), { modelAdmissions: 1, sends: 1 });
	assert.deepEqual([...f.storage.rows.values()][0].messageIds, ["sent-1"]);
	f.storage.crash = undefined;
	await f.create().recoverPending();
	assert.deepEqual(f.counts(), { modelAdmissions: 1, sends: 1 });
	assert.equal([...f.storage.rows.values()][0].stage, "completed");
});

test("lost send acknowledgment becomes uncertain instead of repeating Telegram delivery", async () => {
	const f = fixture();
	f.storage.crash = (_key, value) =>
		value.stage === "answered" && value.nextChunk > 0 ? "before" : undefined;
	f.create();
	await assert.rejects(
		FakeChat.latest.direct(f.thread, message, undefined, undefined),
		/eviction/,
	);
	assert.deepEqual(f.counts(), { modelAdmissions: 1, sends: 1 });
	f.storage.crash = undefined;
	await f.create().recoverPending();
	assert.deepEqual(f.counts(), { modelAdmissions: 1, sends: 1 });
	assert.equal([...f.storage.rows.values()][0].stage, "uncertain");
});

test("same provider operation id produces one admission and one reply", async () => {
	const f = fixture();
	f.create();
	await FakeChat.latest.direct(f.thread, message, undefined, undefined);
	await FakeChat.latest.direct(f.thread, message, undefined, undefined);
	assert.deepEqual(f.counts(), { modelAdmissions: 1, sends: 1 });
});

test("SSE consumes exact terminal answer and fails closed without a terminal receipt", async () => {
	const deltas: string[] = [];
	const response = new Response(
		'data: {"kind":"delta","text":"Hello"}\n\ndata: {"kind":"done","text":"Hello Alice"}\n\n',
	);
	assert.equal(
		await consumeTelegramTurnStream(response, (text) => deltas.push(text)),
		"Hello Alice",
	);
	assert.deepEqual(deltas, ["Hello"]);
	await assert.rejects(
		consumeTelegramTurnStream(
			new Response('data: {"kind":"delta","text":"partial"}\n\n'),
		),
		/terminal/,
	);
});

function maintenanceFixture() {
	const storage = new Storage();
	const rows = new Map<string, any>();
	let serial = 0;
	let runs = 0;
	let completions = 0;
	let canonical = true;
	function insert(
		type: string,
		interval: number,
		callback: string,
		payload: any,
		retry: any,
	) {
		const prior = [...rows.values()].find(
			(row) =>
				row.type === type &&
				row.callback === callback &&
				row.intervalSeconds === interval &&
				JSON.stringify(row.payload) === JSON.stringify(payload),
		);
		if (prior) return prior;
		const row = {
			id: `s-${++serial}`,
			type,
			time: Date.now() / 1000,
			callback,
			payload,
			retry: retry.retry,
			...(type === "interval" ? { intervalSeconds: interval } : {}),
		};
		rows.set(row.id, row);
		return row;
	}
	const host = {
		assertRuntimeActive: async () => {},
		admitAccepted: async () => null,
		assertOriginal: async () => {},
		assertActive: async () => {},
		completeOriginal: async (
			operation: ParentServiceOperation,
			_claim: unknown,
			terminal: { receiptHash: string },
		) => {
			const fire = await storage.get<any>(
				`tedix:pi:maintenance:fire:${operation.operationId}`,
			);
			const actual = await storage.get<any>(
				`tedix:pi:maintenance:effect:${operation.operationId}`,
			);
			assert.ok(actual, "actual maintenance effect journal missing");
			assert.equal(actual.stage, "acknowledged");
			assert.deepEqual(actual.operation, operation);
			assert.deepEqual(fire.operation, operation);
			assert.ok(["acknowledged", "completed"].includes(fire.stage));
			assert.deepEqual(fire.effectReceipt, actual.receipt);
			assert.equal(actual.receipt.receiptHash, await sha(actual.evidence));
			assert.equal(
				terminal.receiptHash,
				await maintenanceCompletionReceiptHash(operation, actual.receipt),
			);
			completions++;
		},
		storage: storage as any,
		isCanonical: async () => canonical,
		run: async (
			taskId: ParentMaintenanceTask,
			operation: ParentServiceOperation,
		) => {
			runs++;
			const evidence = {
				operation,
				taskId,
				acknowledgmentId: `${operation.operationId}:fixture-effects`,
				status: "acknowledged",
			};
			const receipt = {
				status: "acknowledged" as const,
				operationId: operation.operationId,
				requestHash: operation.requestHash,
				taskId,
				acknowledgmentId: evidence.acknowledgmentId,
				receiptHash: await sha(evidence),
			};
			await storage.put(
				`tedix:pi:maintenance:effect:${operation.operationId}`,
				{ operation, stage: "acknowledged", evidence, receipt },
			);
			return receipt;
		},
		listSchedules: async () => [...rows.values()],
		getScheduleById: async (id: string) => rows.get(id),
		cancelSchedule: async (id: string) => rows.delete(id),
		schedule: async (_at: Date, cb: string, payload: any, retry: any) =>
			insert("scheduled", 0, cb, payload, retry),
		scheduleEvery: async (
			interval: number,
			cb: string,
			payload: any,
			retry: any,
		) => insert("interval", interval, cb, payload, retry),
	};
	return {
		storage,
		rows,
		host,
		create: () => new ParentMaintenanceServices(host as any),
		runs: () => runs,
		completions: () => completions,
		orphan: () => {
			canonical = false;
		},
	};
}
async function sha(value: unknown): Promise<string> {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(JSON.stringify(value)),
			),
		),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}
test("repeated maintenance wakes and bridge retries keep one schedule per cadence", async () => {
	const f = maintenanceFixture();
	await f.create().ensure();
	await f.create().ensure();
	assert.equal(f.rows.size, 5);
	const row = [...f.rows.values()].find(
		(row) => row.payload.taskId === "isolate-daily-log-flush",
	);
	assert.equal(row.retry.maxAttempts, 3);
	await f.create().run(row.payload, row);
	await f.create().run(row.payload, row);
	const recurring = [...f.rows.values()].filter(
		(row) => row.type === "interval",
	);
	assert.equal(recurring.length, 1);
	assert.equal(recurring[0].intervalSeconds, 300);
	assert.equal(f.runs(), 1);
	assert.equal(f.completions(), 2);
	f.orphan();
	await f.create().run(row.payload, row);
	assert.equal(f.runs(), 1);
	await f.create().ensure();
	assert.equal(f.rows.size, 6);
});

test("maintenance completion verifies persisted acknowledgments on duplicate wakes", async () => {
	const f = maintenanceFixture();
	await f.create().ensure();
	const row = [...f.rows.values()].find(
		(row) => row.payload.taskId === "isolate-daily-log-flush",
	);
	await f.create().run(row.payload, row);
	const key = `tedix:pi:maintenance:effect:maintenance:${row.id}:${row.time}`;
	const actual = await f.storage.get<any>(key);
	await f.storage.put(key, {
		...actual,
		receipt: { ...actual.receipt, acknowledgmentId: "foreign-effect" },
	});
	await assert.rejects(
		f.create().run(row.payload, row),
		/Expected values to be strictly deep-equal/,
	);
	assert.equal(f.runs(), 1);
	assert.equal(f.completions(), 1);
	await f.storage.put(key, actual);
	await f.create().run(row.payload, row);
	assert.equal(f.runs(), 1);
	assert.equal(f.completions(), 2);
});

test("maintenance callbacks with no acknowledgment remain uncertain and never replay", async () => {
	const f = maintenanceFixture();
	await f.create().ensure();
	const row = [...f.rows.values()].find(
		(row) => row.payload.taskId === "isolate-daily-log-flush",
	);
	let attempts = 0;
	(f.host as any).run = async () => {
		attempts++;
	};
	await assert.rejects(
		f.create().run(row.payload, row),
		/acknowledgment missing/,
	);
	await assert.rejects(f.create().run(row.payload, row), /uncertain/);
	assert.equal(attempts, 1);
	assert.equal(f.completions(), 0);
	assert.equal(
		f.storage.rows.get(
			`tedix:pi:maintenance:fire:maintenance:${row.id}:${row.time}`,
		).stage,
		"uncertain",
	);
});

test("legacy maintenance phase is journaled before cancellation and repaired after cancellation failure", async () => {
	const f = maintenanceFixture();
	const due = Date.now() + 1_234_567;
	f.rows.set("legacy", {
		id: "legacy",
		callback: "_runDeclaredScheduledTask",
		payload: { taskId: "isolate-daily-log-flush" },
		type: "scheduled",
		time: due / 1000,
	});
	f.rows.set("customer-job", {
		id: "customer-job",
		callback: "onCronFire",
		payload: { taskId: "isolate-daily-log-flush" },
		type: "scheduled",
		time: due / 1000,
	});
	f.storage.sql = {
		exec: (query: string, taskId?: string) => ({
			toArray: () =>
				query.includes("sqlite_master")
					? [{ name: "cf_think_scheduled_tasks" }]
					: taskId === "isolate-daily-log-flush"
						? [{ schedule_id: "legacy", next_run_at: due }]
						: [],
		}),
	};
	const originalCancel = f.host.cancelSchedule;
	let fail = true;
	f.host.cancelSchedule = async (id: string) => {
		const journal = f.storage.rows.get(
			"tedix:pi:maintenance:v1:isolate-daily-log-flush",
		);
		assert.equal(journal.nextRunAt, due);
		if (fail) throw new Error("cancel temporarily unavailable");
		return originalCancel(id);
	};
	await assert.rejects(f.create().ensure(), /cancel temporarily/);
	assert.equal(f.rows.has("legacy"), true);
	assert.equal(
		f.storage.rows.get("tedix:pi:maintenance:v1:isolate-daily-log-flush")
			.legacyCancelled,
		false,
	);
	fail = false;
	const originalSchedule = f.host.schedule;
	let preserved: number | undefined;
	f.host.schedule = async (at: Date, cb: string, payload: any, retry: any) => {
		if (payload.taskId === "isolate-daily-log-flush") preserved = at.getTime();
		return originalSchedule(at, cb, payload, retry);
	};
	await f.create().ensure();
	assert.equal(preserved, due);
	assert.equal(f.rows.has("legacy"), false);
	assert.equal(f.rows.has("customer-job"), true);
	await f.create().ensure();
	assert.equal(f.rows.size, 6);
});

const { classifyTediContextOverflow } = await import("./context-overflow");
const { repairMalformedToolCall } = await import("./repair-tool-call");
const { admitTediNativeRecovery } = await import("./pi-recovery");

test("local context classifier retains provider overflow signals and rejects unrelated errors", async () => {
	for (const message of [
		"prompt is too long",
		"context_length_exceeded",
		"maximum context length",
		"too many input tokens",
		"input token count exceeded",
	])
		assert.equal(
			classifyTediContextOverflow(new Error(message)),
			"context_overflow",
		);
	assert.equal(
		classifyTediContextOverflow({ error: { code: "context_length_exceeded" } }),
		"context_overflow",
	);
	assert.equal(classifyTediContextOverflow(new Error("rate limit")), undefined);
});

test("direct SDK deterministic tool repair preserves call identity without inference", async () => {
	const call = {
		type: "tool-call" as const,
		toolCallId: "call-1",
		toolName: "read",
		input: '```json\n{"arguments":{"path":"/owned"}}\n```',
	};
	const repaired = await repairMalformedToolCall({
		toolCall: call,
		error: { name: "AI_InvalidToolInputError" },
	});
	assert.equal(repaired?.toolCallId, "call-1");
	assert.equal(repaired?.toolName, "read");
	assert.equal(repaired?.input, '{"path":"/owned"}');
	assert.equal(
		await repairMalformedToolCall({
			toolCall: call,
			error: { name: "AI_NoSuchToolError" },
		}),
		null,
	);
});

function recoveryStorage() {
	const storage = new Storage();
	let serial = Promise.resolve();
	return {
		rows: storage.rows,
		transaction<T>(fn: (transaction: any) => Promise<T>): Promise<T> {
			const next = serial.then(() => fn(storage));
			serial = next.then(
				() => undefined,
				() => undefined,
			);
			return next;
		},
	};
}
test("native recovery preserves finite age, real-progress and OOM bounds across recreated storage clients", async () => {
	const storage = recoveryStorage();
	const authority = async () => true;
	assert.equal(
		(
			await admitTediNativeRecovery(
				storage as any,
				"run-progress",
				{ createdAt: 0, progress: "entry-1", now: 299_999 },
				authority,
			)
		).allowed,
		true,
	);
	assert.deepEqual(
		(
			await admitTediNativeRecovery(
				storage as any,
				"run-progress",
				{ createdAt: 0, progress: "entry-1", now: 300_000 },
				authority,
			)
		).allowed,
		false,
	);
	assert.equal(
		(
			await admitTediNativeRecovery(
				storage as any,
				"run-progress",
				{ createdAt: 0, progress: "entry-2", now: 300_000 },
				authority,
			)
		).allowed,
		true,
	);
	const age = await admitTediNativeRecovery(
		storage as any,
		"run-progress",
		{ createdAt: 0, progress: "entry-3", now: 900_000 },
		authority,
	);
	assert.equal(age.allowed, false);
	if (!age.allowed) assert.equal(age.reason, "age");
	for (let i = 0; i < 3; i++)
		assert.equal(
			(
				await admitTediNativeRecovery(
					storage as any,
					"run-oom",
					{ createdAt: 0, progress: "entry-1", now: i, oom: true },
					authority,
				)
			).allowed,
			true,
		);
	const oom = await admitTediNativeRecovery(
		storage as any,
		"run-oom",
		{ createdAt: 0, progress: "entry-1", now: 4, oom: true },
		authority,
	);
	assert.equal(oom.allowed, false);
	if (!oom.allowed) assert.equal(oom.reason, "oom");
});
test("concurrent native recovery budget claims cannot exceed 200 and denied authority remains denied", async () => {
	const storage = recoveryStorage();
	const results = await Promise.all(
		Array.from({ length: 205 }, () =>
			admitTediNativeRecovery(
				storage as any,
				"bounded-run",
				{ createdAt: 0, progress: "entry-1", now: 1 },
				async () => true,
			),
		),
	);
	assert.equal(results.filter((result) => result.allowed).length, 200);
	const rejected = await admitTediNativeRecovery(
		storage as any,
		"denied-run",
		{ createdAt: 0, progress: "entry-1", now: 1 },
		async () => false,
	);
	assert.equal(rejected.allowed, false);
	if (!rejected.allowed) assert.equal(rejected.reason, "authority");
});

const sqliteModule = "bun:sqlite";
const { Database } = await import(sqliteModule);
function legacySqlFixture() {
	const db = new Database(":memory:");
	db.exec(
		"CREATE TABLE cf_agents_fibers(fiber_id TEXT,name TEXT,status TEXT); CREATE TABLE cf_agents_runs(id TEXT,name TEXT,completed_at INTEGER); CREATE TABLE cf_agents_task_runs(run_id TEXT,definition TEXT,state TEXT); CREATE TABLE cf_think_submissions(submission_id TEXT,status TEXT,result_status TEXT)",
	);
	const reads: string[] = [];
	return {
		db,
		reads,
		storage: {
			sql: {
				exec(query: string) {
					assert.match(query, /^SELECT /);
					reads.push(query);
					return db.query(query).all();
				},
			},
		} as any,
	};
}
test("pre-super gate preserves old pending chat/messenger SQL receipts before SDK construction", async () => {
	for (const insert of [
		"INSERT INTO cf_agents_fibers VALUES('fiber-1','think:messenger-reply','interrupted')",
		"INSERT INTO cf_agents_runs VALUES('run-1','__cf_internal_chat_turn:request-1',NULL)",
		"INSERT INTO cf_agents_task_runs VALUES('task-1','__cf_internal_messenger_reply','waiting')",
		"INSERT INTO cf_agents_task_runs VALUES('task-1','__cf_internal_chat_recovery','pending')",
		"INSERT INTO cf_think_submissions VALUES('submission-1','completed','retry')",
	]) {
		const f = legacySqlFixture();
		f.db.exec(insert);
		let sdkConstructions = 0;
		class NativeBase {
			constructor() {
				sdkConstructions++;
			}
		}
		class Cutover extends NativeBase {
			constructor() {
				assertLegacyThinkTasksSettled(f.storage);
				super();
			}
		}
		assert.throws(() => new Cutover(), /reconciliation before Pi activation/);
		assert.equal(sdkConstructions, 0);
		assert.ok(f.reads.length);
		assert.equal(
			f.db
				.query("SELECT count(*) AS count FROM sqlite_master WHERE type='table'")
				.get().count,
			4,
		);
		f.db.close();
	}
});
test("legacy gate reads a cf_agents_runs table that predates completed_at", async () => {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE cf_agents_runs(id TEXT,name TEXT)");
	const storage = {
		sql: { exec: (query: string) => db.query(query).all() },
	} as any;
	assertLegacyThinkTasksSettled(storage);
	db.exec("INSERT INTO cf_agents_runs VALUES('run-1','workstation:provision')");
	assertLegacyThinkTasksSettled(storage);
	db.exec(
		"INSERT INTO cf_agents_runs VALUES('run-2','__cf_internal_chat_turn:request-2')",
	);
	assert.throws(
		() => assertLegacyThinkTasksSettled(storage),
		/reconciliation before Pi activation: cf_agents_runs:run-2/,
	);
	db.close();
});
test("legacy gate permits terminal receipts and unrelated workstation work without mutations", async () => {
	const f = legacySqlFixture();
	f.db.exec(
		"INSERT INTO cf_agents_fibers VALUES('workstation-1','workstation:provision','running'); INSERT INTO cf_agents_fibers VALUES('old-messenger','think:messenger-reply','completed'); INSERT INTO cf_agents_task_runs VALUES('work-task','workstation-provision','pending'); INSERT INTO cf_think_submissions VALUES('old-input','completed','completed')",
	);
	assertLegacyThinkTasksSettled(f.storage);
	assert.equal(
		f.db
			.query(
				"SELECT status FROM cf_agents_fibers WHERE fiber_id='workstation-1'",
			)
			.get().status,
		"running",
	);
	assert.equal(
		f.db.query("SELECT count(*) AS count FROM cf_agents_task_runs").get().count,
		1,
	);
	f.db.close();
});
test("orphan persisted messenger/channel receipts fail closed while terminal receipts remain intact", async () => {
	const storage = new Storage();
	storage.rows.set("__cf_messenger_recovery:msgr-1", {
		stage: "accepted",
		event: { provider: "telegram" },
	});
	await assert.rejects(
		assertLegacyThinkReceiptsSettled(storage as any),
		/persisted receipt/,
	);
	assert.equal(storage.rows.size, 1);
	storage.rows.set("__cf_messenger_recovery:msgr-1", { stage: "completed" });
	await assertLegacyThinkReceiptsSettled(storage as any);
	assert.equal(storage.rows.size, 1);
	storage.rows.set("cf:chat-recovery:incident:request-1", {
		status: "attempting",
	});
	await assert.rejects(
		assertLegacyThinkReceiptsSettled(storage as any),
		/persisted receipt/,
	);
	storage.rows.set("cf:chat-recovery:incident:request-1", {
		status: "exhausted",
	});
	await assertLegacyThinkReceiptsSettled(storage as any);
	assert.equal(storage.rows.size, 2);
});

test("cancelled legacy recovery is terminal while pending delivery remains independently fenced", async () => {
	const storage = new Storage();
	for (const status of ["completed", "skipped", "exhausted", "failed"]) {
		const receipt = {
			status,
			reason: status === "skipped" ? "user_cancelled" : "terminal",
		};
		storage.rows.set("cf:chat-recovery:incident:request-cancelled", receipt);
		await assertLegacyThinkReceiptsSettled(storage as any);
		assert.deepEqual(
			storage.rows.get("cf:chat-recovery:incident:request-cancelled"),
			receipt,
		);
	}
	storage.rows.set("cf:chat-recovery:incident:request-cancelled", {
		status: "skipped",
		reason: "user_cancelled",
	});
	storage.rows.set("__cf_messenger_recovery:msgr-cancelled", {
		stage: "accepted",
		outcome: "interrupted",
	});
	await assert.rejects(
		assertLegacyThinkReceiptsSettled(storage as any),
		/persisted receipt/,
	);
	assert.equal(storage.rows.size, 2);
	storage.rows.delete("__cf_messenger_recovery:msgr-cancelled");
	for (const status of ["detected", "scheduled", "attempting", "unknown"]) {
		storage.rows.set("cf:chat-recovery:incident:request-cancelled", { status });
		await assert.rejects(
			assertLegacyThinkReceiptsSettled(storage as any),
			/persisted receipt/,
		);
	}
});

for (const [name, fn] of tests) {
	locks.clear();
	await fn();
	console.log(`PASS ${name}`);
}
console.log(`${tests.length} native Pi parent service tests passed`);
