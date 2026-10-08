import assert from "node:assert/strict";
const bunTestModule = "bun:test";
const { mock } = await import(bunTestModule);
class ChatBoundary {
	static latest: ChatBoundary;
	direct!: (...args: any[]) => Promise<void>;
	constructor(_config: unknown) {
		ChatBoundary.latest = this;
	}
	onDirectMessage(fn: any) {
		this.direct = fn;
	}
	onNewMention(_fn: any) {}
	onSubscribedMessage(_fn: any) {}
	onNewMessage(_pattern: any, _fn: any) {}
	onAction(_fn: any) {}
	async initialize() {}
	webhooks = { telegram: async () => new Response("ok") };
}
let recoveredThread: any;
mock.module("chat", () => ({
	Chat: ChatBoundary,
	ThreadImpl: { fromJSON: () => recoveredThread },
}));
mock.module("@chat-adapter/telegram", () => ({
	createTelegramAdapter: () => ({ botUserId: "bot" }),
}));
mock.module("agents/chat-sdk", () => ({
	ChatSdkStateAgent: class {},
	createChatSdkState: () => ({
		acquireLock: async () => ({}),
		releaseLock: async () => {},
	}),
}));
const {
	PiTelegram,
	ParentMaintenanceServices,
	maintenanceCompletionReceiptHash,
} = await import("./pi-parent-services");
import type {
	ParentServiceOperation,
	ParentServiceClaim,
	MaintenanceEffectReceipt,
} from "./pi-parent-services";
class Storage {
	rows = new Map<string, any>();
	sql: any = { exec: () => ({ toArray: () => [] }) };
	async transaction<T>(fn: (transaction: Storage) => Promise<T>): Promise<T> {
		return fn(this);
	}
	async get<T>(key: string): Promise<T | undefined> {
		const row = this.rows.get(key);
		return row === undefined ? undefined : structuredClone(row);
	}
	async put(key: string, value: any) {
		this.rows.set(key, structuredClone(value));
	}
	async list<T>({ prefix }: any): Promise<Map<string, T>> {
		return new Map(
			[...this.rows]
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, row]) => [key, structuredClone(row)]),
		);
	}
}
function admission(selected = true) {
	let active = true;
	const claims = new Map<string, ParentServiceOperation>();
	const completed = new Map<string, string>();
	let admits = 0,
		completes = 0;
	return {
		revoke() {
			active = false;
		},
		get admits() {
			return admits;
		},
		get completes() {
			return completes;
		},
		async assertRuntimeActive() {
			if (!active) throw new Error("held");
		},
		async admitAccepted(
			op: ParentServiceOperation,
		): Promise<ParentServiceClaim> {
			if (!active) throw new Error("held");
			const prior = claims.get(op.operationId);
			if (prior && JSON.stringify(prior) !== JSON.stringify(op))
				throw new Error("changed");
			if (!prior) {
				admits++;
				claims.set(op.operationId, structuredClone(op));
			}
			return selected ? { generation: 7 } : null;
		},
		async assertOriginal(
			op: ParentServiceOperation,
			claim: ParentServiceClaim,
		) {
			if (
				JSON.stringify(claims.get(op.operationId)) !== JSON.stringify(op) ||
				(selected ? claim?.generation !== 7 : claim !== null)
			)
				throw new Error("original claim missing");
		},
		async assertActive(op: ParentServiceOperation, claim: ParentServiceClaim) {
			await this.assertOriginal(op, claim);
			if (!active) throw new Error("held");
		},
		async completeOriginal(
			op: ParentServiceOperation,
			claim: ParentServiceClaim,
			receipt: any,
		) {
			await this.assertOriginal(op, claim);
			assert.equal(receipt.terminal, "completed");
			assert.match(receipt.receiptHash, /^[a-f0-9]{64}$/);
			if (completed.has(op.operationId))
				assert.equal(completed.get(op.operationId), receipt.receiptHash);
			else {
				completed.set(op.operationId, receipt.receiptHash);
				completes++;
			}
		},
	};
}
const author = {
	userId: "alice",
	userName: "alice",
	fullName: "Alice",
	isMe: false,
	isBot: false,
};
const message = { id: "m1", text: "hello", author, attachments: [] };
function telegram(
	selected = true,
	turnPolicy?: () => Record<string, unknown> | null,
) {
	const storage = new Storage(),
		gate = admission(selected);
	const trusts: string[] = [];
	let sends = 0,
		models = 0,
		typing = 0,
		fibers = 0;
	let afterTyping: (() => void) | undefined,
		afterSend: (() => void) | undefined,
		afterModel: (() => void) | undefined,
		beforeComplete: (() => void) | undefined;
	const thread: any = {
		id: "telegram:1",
		channelId: "channel",
		isDM: true,
		toJSON: () => ({ id: "telegram:1", channelId: "channel", isDM: true }),
		startTyping: async () => {
			typing++;
			afterTyping?.();
		},
		post: async (body: any) => {
			assert.equal(typeof body.markdown, "string");
			sends++;
			afterSend?.();
			return { id: `ack${sends}` };
		},
	};
	recoveredThread = thread;
	const service = new PiTelegram(
		{
			...gate,
			completeOriginal: async (
				operation: ParentServiceOperation,
				claim: ParentServiceClaim,
				receipt: unknown,
			) => {
				beforeComplete?.();
				await gate.completeOriginal(operation, claim, receipt);
			},
			storage,
			subAgent: async () => ({}),
			resolveFiber: async () => true,
			startFiber: async (_name: string, fn: any) => {
				fibers++;
				await fn({ stash() {} });
			},
			turnPolicy,
			runTurn: async (turn: { trust: string }) => {
				models++;
				trusts.push(turn.trust);
				afterModel?.();
				return "x".repeat(8000);
			},
		} as any,
		{ token: "token", userName: "bot", secretToken: "secret" },
	);
	return {
		service,
		storage,
		gate,
		thread,
		trusts,
		get sends() {
			return sends;
		},
		get models() {
			return models;
		},
		get typing() {
			return typing;
		},
		get fibers() {
			return fibers;
		},
		set afterTyping(fn: (() => void) | undefined) {
			afterTyping = fn;
		},
		set afterSend(fn: (() => void) | undefined) {
			afterSend = fn;
		},
		set afterModel(fn: (() => void) | undefined) {
			afterModel = fn;
		},
		set beforeComplete(fn: (() => void) | undefined) {
			beforeComplete = fn;
		},
		accept: (msg = message) => ChatBoundary.latest.direct(thread, msg),
	};
}
{
	// The channel policy decides the turn before anything is admitted: a
	// disabled DM policy drops the message without a record, a fiber or a model
	// call; an allowlisted author's trust rides the turn into the model call.
	const closed = telegram(true, () => ({ dmPolicy: "disabled" }));
	await closed.accept();
	assert.equal(closed.gate.admits, 0);
	assert.equal(closed.fibers, 0);
	assert.equal(closed.models, 0);
	assert.equal(closed.sends, 0);
	const bot = telegram(true, () => ({ dmPolicy: "open" }));
	await bot.accept({ ...message, author: { ...author, isBot: true } });
	assert.equal(bot.models, 0);
	const listed = telegram(true, () => ({
		dmPolicy: "allowlist",
		allowFrom: ["@alice"],
	}));
	await listed.accept();
	assert.deepEqual(listed.trusts, ["trusted"]);
	await listed.accept({
		...message,
		id: "m2",
		author: { ...author, userId: "mallory", userName: "mallory" },
	});
	assert.deepEqual(listed.trusts, ["trusted", "untrusted"]);
	const unconfigured = telegram();
	await unconfigured.accept();
	assert.deepEqual(unconfigured.trusts, ["untrusted"]);
}
{
	const f = telegram();
	await f.accept();
	assert.equal(f.sends, 3);
	assert.equal(f.gate.completes, 1);
	await f.accept();
	assert.equal(f.sends, 3);
	assert.equal(f.gate.admits, 1);
	await assert.rejects(
		f.accept({ ...message, text: "changed" }),
		/input changed/,
	);
	await assert.rejects(
		f.accept({ ...message, author: { ...author, userId: "mallory" } }),
		/input changed/,
	);
}
{
	const f = telegram();
	f.gate.revoke();
	await assert.rejects(f.accept(), /held/);
	assert.equal(f.fibers, 0);
	assert.equal(f.typing, 0);
	assert.equal(f.models, 0);
	assert.equal(f.sends, 0);
}
{
	const f = telegram();
	f.afterTyping = () => f.gate.revoke();
	await assert.rejects(f.accept(), /held/);
	assert.equal(f.models, 0);
	assert.equal(f.sends, 0);
	await assert.rejects(f.service.recoverPending(), /held/);
	assert.equal(f.gate.admits, 1);
}
{
	const f = telegram();
	f.afterModel = () => f.gate.revoke();
	await assert.rejects(f.accept(), /held/);
	assert.equal(f.sends, 0);
	assert.equal(f.gate.completes, 0);
}
{
	const f = telegram();
	f.afterSend = () => f.gate.revoke();
	await assert.rejects(f.accept(), /held/);
	assert.equal(f.sends, 1);
	assert.equal(f.gate.completes, 0);
	const record = [...f.storage.rows.values()][0];
	assert.equal(record.stage, "answered");
	assert.equal(record.nextChunk, 1);
	assert.deepEqual(record.messageIds, ["ack1"]);
	await assert.rejects(f.service.recoverPending(), /held/);
	assert.equal(f.sends, 1);
}
{
	const f = telegram();
	f.afterSend = () => {
		if (f.sends === 3) f.gate.revoke();
	};
	await f.accept();
	assert.equal(f.sends, 3);
	assert.equal(f.gate.completes, 1);
	assert.equal([...f.storage.rows.values()][0].stage, "completed");
	await f.service.recoverPending();
	assert.equal(f.sends, 3);
	assert.equal(f.models, 1);
}
{
	const f = telegram();
	f.beforeComplete = () => {
		f.gate.revoke();
		throw new Error("completion storage unavailable");
	};
	await assert.rejects(f.accept(), /completion storage unavailable/);
	const [key, known] = [...f.storage.rows][0]!;
	assert.equal(known.stage, "answered");
	assert.equal(known.nextChunk, known.chunks.length);
	assert.equal(f.gate.completes, 0);
	f.beforeComplete = undefined;
	f.storage.rows.set(key, { ...known, claim: { generation: 99 } });
	await assert.rejects(f.service.recoverPending(), /original claim/);
	assert.equal(f.gate.completes, 0);
	f.storage.rows.set(key, known);
	await f.service.recoverPending();
	assert.equal(f.gate.completes, 1);
	assert.equal(f.sends, 3);
	assert.equal(f.models, 1);
	assert.equal(f.fibers, 1);
}
{
	const f = telegram();
	await f.accept();
	const [key, record] = [...f.storage.rows][0]!;
	record.stage = "accepted";
	delete record.claim;
	await f.storage.put(key, record);
	await assert.rejects(f.service.recoverPending(), /original admission/);
	assert.equal(f.gate.admits, 1);
	assert.equal(f.models, 1);
}
{
	const f = telegram();
	await f.accept();
	const [key, record] = [...f.storage.rows][0]!;
	record.stage = "sending";
	await f.storage.put(key, record);
	await f.service.recoverPending();
	assert.equal((await f.storage.get<any>(key)).stage, "uncertain");
	assert.equal(f.sends, 3);
	await f.service.recoverPending();
	assert.equal(f.sends, 3);
}
{
	const f = telegram(false);
	await f.accept();
	assert.equal(f.sends, 3);
	assert.equal(f.gate.completes, 1);
}
function maintenance() {
	const storage = new Storage(),
		gate = admission();
	let runs = 0,
		fail = false,
		revokeAfterRun = false,
		outcome: "acknowledged" | "void" | "uncertain" | "foreign" = "acknowledged",
		failComplete = false;
	const journal = new Map<string, MaintenanceEffectReceipt>();
	const host = {
		...gate,
		storage,
		isCanonical: async () => true,
		schedule: async () => {
			throw new Error("unused");
		},
		scheduleEvery: async () => {
			throw new Error("unused");
		},
		getScheduleById: async () => undefined,
		listSchedules: async () => [],
		cancelSchedule: async () => true,
		run: async (taskId: string, operation: ParentServiceOperation) => {
			runs++;
			if (revokeAfterRun) gate.revoke();
			if (fail) throw new Error("lost task acknowledgment");
			if (outcome === "void") return undefined;
			if (outcome === "uncertain")
				return {
					status: "uncertain",
					operationId: operation.operationId,
					requestHash: operation.requestHash,
					taskId,
					reason: "timeout",
				};
			const receipt = {
				status: "acknowledged" as const,
				operationId: operation.operationId,
				requestHash: operation.requestHash,
				taskId: taskId as MaintenanceEffectReceipt["taskId"],
				acknowledgmentId: `effect:${operation.operationId}`,
				receiptHash: "a".repeat(64),
			};
			journal.set(operation.operationId, structuredClone(receipt));
			return outcome === "foreign"
				? { ...receipt, operationId: "foreign-fire" }
				: receipt;
		},
		completeOriginal: async (
			operation: ParentServiceOperation,
			claim: ParentServiceClaim,
			receipt: { terminal: "completed"; receiptHash: string },
		) => {
			if (failComplete) throw new Error("terminal journal unavailable");
			const fire = await storage.get<any>(
				`tedix:pi:maintenance:fire:${operation.operationId}`,
			);
			const actual = journal.get(operation.operationId);
			assert.ok(actual, "actual effect journal missing");
			assert.deepEqual(
				fire.effectReceipt,
				actual,
				"effect journal differs from fire receipt",
			);
			assert.equal(
				receipt.receiptHash,
				await maintenanceCompletionReceiptHash(operation, actual),
			);
			await gate.completeOriginal(operation, claim, receipt);
		},
	};
	return {
		service: new ParentMaintenanceServices(host as any),
		gate,
		storage,
		get runs() {
			return runs;
		},
		set fail(value: boolean) {
			fail = value;
		},
		set outcome(value: typeof outcome) {
			outcome = value;
		},
		set failComplete(value: boolean) {
			failComplete = value;
		},
		set revokeAfterRun(value: boolean) {
			revokeAfterRun = value;
		},
	};
}
const payload = { taskId: "isolate-daily-log-flush" as const };
const schedule = {
	id: "native-tick",
	callback: "onParentMaintenance",
	payload,
	type: "interval" as const,
	time: 172800,
	intervalSeconds: 300,
};
{
	const f = maintenance();
	await f.service.run(payload, schedule);
	await f.service.run(payload, schedule);
	assert.equal(f.runs, 1);
	assert.equal(f.gate.admits, 1);
	assert.equal(f.gate.completes, 1);
	await f.service.run(payload, { ...schedule, time: schedule.time + 300 });
	assert.equal(f.runs, 2);
	await assert.rejects(
		f.service.run(payload, undefined as any),
		/schedule identity/,
	);
}
{
	const f = maintenance();
	f.fail = true;
	await assert.rejects(f.service.run(payload, schedule), /lost task/);
	f.fail = false;
	await assert.rejects(f.service.run(payload, schedule), /uncertain/);
	assert.equal(f.runs, 1);
	assert.equal(f.gate.admits, 1);
}
{
	const f = maintenance();
	f.revokeAfterRun = true;
	await f.service.run(payload, schedule);
	assert.equal(f.gate.completes, 1);
	assert.equal([...f.storage.rows.values()][0].stage, "completed");
	await f.service.run(payload, schedule);
	assert.equal(f.runs, 1);
	assert.equal(f.gate.completes, 1);
}
{
	const f = maintenance();
	f.gate.revoke();
	await assert.rejects(f.service.ensure(), /held/);
	await assert.rejects(f.service.run(payload, schedule), /held/);
	assert.equal(f.runs, 0);
	assert.equal(f.storage.rows.size, 0);
}

for (const outcome of ["void", "uncertain", "foreign"] as const) {
	const f = maintenance();
	f.outcome = outcome;
	await assert.rejects(
		f.service.run(payload, schedule),
		/acknowledgment missing|uncertain|identity changed/,
	);
	assert.equal(f.gate.completes, 0);
	assert.equal([...f.storage.rows.values()][0].stage, "uncertain");
	f.outcome = "acknowledged";
	await assert.rejects(f.service.run(payload, schedule), /uncertain/);
	assert.equal(f.runs, 1);
	assert.equal(f.gate.admits, 1);
}
{
	const f = maintenance();
	f.failComplete = true;
	await assert.rejects(
		f.service.run(payload, schedule),
		/terminal journal unavailable/,
	);
	assert.equal([...f.storage.rows.values()][0].stage, "acknowledged");
	f.failComplete = false;
	await f.service.run(payload, schedule);
	assert.equal(f.runs, 1);
	assert.equal(f.gate.completes, 1);
}
{
	const f = maintenance();
	f.failComplete = true;
	await assert.rejects(
		f.service.run(payload, schedule),
		/terminal journal unavailable/,
	);
	const [key, fire] = [...f.storage.rows.entries()][0]!;
	fire.effectReceipt.receiptHash = "b".repeat(64);
	await f.storage.put(key, fire);
	f.failComplete = false;
	await assert.rejects(
		f.service.run(payload, schedule),
		/effect journal differs/,
	);
	assert.equal(f.runs, 1);
	assert.equal(f.gate.completes, 0);
}
{
	const f = maintenance();
	f.outcome = "void";
	await assert.rejects(
		f.service.run(payload, schedule),
		/acknowledgment missing/,
	);
	const [key, fire] = [...f.storage.rows.entries()][0]!;
	fire.stage = "completed";
	await f.storage.put(key, fire);
	await assert.rejects(
		f.service.run(payload, schedule),
		/completed effect receipt missing/,
	);
	assert.equal(f.gate.completes, 0);
	assert.equal(f.runs, 1);
}

{
	const f = maintenance();
	await f.service.run(payload, schedule);
	const [key, fire] = [...f.storage.rows.entries()][0]!;
	fire.effectReceipt.receiptHash = "b".repeat(64);
	await f.storage.put(key, fire);
	await assert.rejects(
		f.service.run(payload, schedule),
		/effect journal differs/,
	);
	assert.equal(f.runs, 1);
	assert.equal(f.gate.completes, 1);
}
console.log(
	"PASS parent service immutable admission, revocation, ACK custody and native tick retry boundaries",
);

const { inspectMaintenanceRecords } = await import("./pi-parent-services");
const stored = new Map<string, unknown>([
	[
		"tedix:pi:maintenance:v1:isolate-corpus-audit",
		{
			nextRunAt: 100,
			legacyScheduleIds: ["old"],
			legacyCancelled: true,
			nativeScheduleId: "native",
		},
	],
]);
const passiveStorage = {
	kv: { list: () => new Map(stored) },
} as unknown as DurableObjectStorage;
assert.deepEqual(await inspectMaintenanceRecords(passiveStorage), [
	{
		taskId: "isolate-corpus-audit",
		nextRunAt: 100,
		legacyScheduleIds: ["old"],
		legacyCancelled: true,
		nativeScheduleId: "native",
		recurringScheduleId: null,
	},
]);
stored.set("tedix:pi:maintenance:v1:isolate-corpus-audit", {
	nextRunAt: 100,
	legacyScheduleIds: [],
	legacyCancelled: true,
	secret: "PRIVATE",
});
assert.throws(() => inspectMaintenanceRecords(passiveStorage));
stored.clear();
stored.set("tedix:pi:maintenance:v1:unknown", {
	nextRunAt: 100,
	legacyScheduleIds: [],
	legacyCancelled: true,
});
assert.throws(() => inspectMaintenanceRecords(passiveStorage), /task identity/);
