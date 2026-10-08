import { z } from "zod";
import type { Schedule } from "agents";

export const PARENT_MAINTENANCE_TASKS = {
	"isolate-daily-log-flush": 300,
	"isolate-directive-compile": 14_400,
	"isolate-brain-digest": 14_400,
	"isolate-corpus-audit": 86_400,
	"isolate-skill-guidance-refresh": 14_400,
} as const;

export type ParentMaintenanceTask = keyof typeof PARENT_MAINTENANCE_TASKS;
export interface MaintenancePayload {
	taskId: ParentMaintenanceTask;
	bridge?: true;
}

export interface ParentServiceOperation {
	operationId: string;
	kind: "maintenance" | "telegram";
	requestHash: string;
	sessionKey?: string;
	scheduledAt?: number;
	input: Record<string, unknown>;
}
export type ParentServiceClaim = { generation: number } | null;
export interface ParentServiceAdmissionHost {
	assertRuntimeActive(): Promise<void>;
	admitAccepted(operation: ParentServiceOperation): Promise<ParentServiceClaim>;
	assertOriginal(
		operation: ParentServiceOperation,
		claim: ParentServiceClaim,
	): Promise<void>;
	assertActive(
		operation: ParentServiceOperation,
		claim: ParentServiceClaim,
	): Promise<void>;
	completeOriginal(
		operation: ParentServiceOperation,
		claim: ParentServiceClaim,
		receipt: { terminal: "completed"; receiptHash: string },
	): Promise<void>;
}
async function digest(value: unknown): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(value)),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
interface AcceptedServiceOperation {
	operation: ParentServiceOperation;
	claim: ParentServiceClaim;
}

export interface MaintenanceEffectReceipt {
	status: "acknowledged";
	operationId: string;
	requestHash: string;
	taskId: ParentMaintenanceTask;
	acknowledgmentId: string;
	/** Hash of the actual persisted effect journal, independently checked by completeOriginal. */
	receiptHash: string;
}
export interface MaintenanceUncertainEffect {
	status: "uncertain";
	operationId: string;
	requestHash: string;
	taskId: ParentMaintenanceTask;
	reason: "timeout" | "failed" | "unconfirmed";
}
export type MaintenanceEffectResult =
	| MaintenanceEffectReceipt
	| MaintenanceUncertainEffect;
function maintenanceEffect(
	operation: ParentServiceOperation,
	value: unknown,
): MaintenanceEffectResult {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Maintenance effect acknowledgment missing");
	const receipt = value as Record<string, unknown>;
	if (
		receipt.operationId !== operation.operationId ||
		receipt.requestHash !== operation.requestHash ||
		receipt.taskId !== operation.input.taskId
	)
		throw new Error("Maintenance effect original identity changed");
	const identity = {
		operationId: operation.operationId,
		requestHash: operation.requestHash,
		taskId: receipt.taskId as ParentMaintenanceTask,
	};
	if (
		receipt.status === "uncertain" &&
		["timeout", "failed", "unconfirmed"].includes(String(receipt.reason))
	)
		return {
			status: "uncertain",
			...identity,
			reason: receipt.reason as MaintenanceUncertainEffect["reason"],
		};
	if (
		receipt.status !== "acknowledged" ||
		typeof receipt.acknowledgmentId !== "string" ||
		!receipt.acknowledgmentId ||
		receipt.acknowledgmentId.length > 512 ||
		typeof receipt.receiptHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(receipt.receiptHash)
	)
		throw new Error("Maintenance effect acknowledgment missing");
	return {
		status: "acknowledged",
		...identity,
		acknowledgmentId: receipt.acknowledgmentId,
		receiptHash: receipt.receiptHash,
	};
}
/** Root independently verifies this exact receipt against its actual operation journal. */
export async function maintenanceCompletionReceiptHash(
	operation: ParentServiceOperation,
	receipt: MaintenanceEffectReceipt,
): Promise<string> {
	const effectReceipt = maintenanceEffect(operation, receipt);
	if (effectReceipt.status !== "acknowledged")
		throw new Error("Maintenance effect remains uncertain");
	return digest({ operation, effectReceipt });
}
interface MaintenanceFire extends AcceptedServiceOperation {
	stage: "accepted" | "running" | "acknowledged" | "completed" | "uncertain";
	effectReceipt?: MaintenanceEffectReceipt;
	uncertainEffect?: MaintenanceUncertainEffect;
}
interface MaintenanceHost extends ParentServiceAdmissionHost {
	storage: DurableObjectStorage;
	schedule(
		at: Date,
		callback: "onParentMaintenance",
		payload: MaintenancePayload,
		options: { idempotent: true; retry: { maxAttempts: number } },
	): Promise<Schedule<MaintenancePayload>>;
	scheduleEvery(
		interval: number,
		callback: "onParentMaintenance",
		payload: MaintenancePayload,
		options: { retry: { maxAttempts: number } },
	): Promise<Schedule<MaintenancePayload>>;
	getScheduleById(id: string): Promise<Schedule<unknown> | undefined>;
	cancelSchedule(id: string): Promise<boolean>;
	listSchedules(): Promise<Schedule<unknown>[]>;
	/** False only when the canonical-owner lookup proves this DO is orphaned. */
	isCanonical(): Promise<boolean>;
	run(
		taskId: ParentMaintenanceTask,
		operation: ParentServiceOperation,
	): Promise<MaintenanceEffectResult>;
}

interface MaintenanceRecord {
	nextRunAt: number;
	legacyScheduleIds: string[];
	legacyCancelled: boolean;
	nativeScheduleId?: string;
	recurringScheduleId?: string;
}

/** Native Agents scheduling; no Think class, declarations or alarm override. */
export class ParentMaintenanceServices {
	constructor(private readonly host: MaintenanceHost) {}

	private key(taskId: ParentMaintenanceTask): string {
		return `tedix:pi:maintenance:v1:${taskId}`;
	}

	private legacyRows(taskId: ParentMaintenanceTask): {
		schedule_id: string | null;
		next_run_at: number | null;
	}[] {
		const sql = this.host.storage.sql;
		if (
			sql
				.exec(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='cf_think_scheduled_tasks'",
				)
				.toArray().length === 0
		)
			return [];
		return sql
			.exec<{ schedule_id: string | null; next_run_at: number | null }>(
				"SELECT schedule_id, next_run_at FROM cf_think_scheduled_tasks WHERE task_id = ?",
				taskId,
			)
			.toArray();
	}

	async ensure(): Promise<void> {
		// Maintenance is owned by the canonical parent DO.
		await this.host.assertRuntimeActive();
		if (!(await this.host.isCanonical())) return;
		for (const taskId of Object.keys(
			PARENT_MAINTENANCE_TASKS,
		) as ParentMaintenanceTask[]) {
			let record = await this.host.storage.get<MaintenanceRecord>(
				this.key(taskId),
			);
			if (!record) {
				const rows = this.legacyRows(taskId);
				const pending = rows
					.map((row) => row.next_run_at)
					.filter((value): value is number => typeof value === "number");
				record = {
					nextRunAt: pending.length
						? Math.min(...pending)
						: Date.now() + PARENT_MAINTENANCE_TASKS[taskId] * 1000,
					legacyScheduleIds: rows
						.map((row) => row.schedule_id)
						.filter((value): value is string => Boolean(value)),
					legacyCancelled: false,
				};
				// Persist phase before cancelling legacy alarms, so a restart cannot lose it.
				await this.host.assertRuntimeActive();
				await this.host.storage.put(this.key(taskId), record);
			}
			if (!record.legacyCancelled) {
				for (const id of record.legacyScheduleIds) {
					await this.host.assertRuntimeActive();
					await this.host.cancelSchedule(id);
					if (await this.host.getScheduleById(id))
						throw new Error(`Legacy maintenance schedule still exists: ${id}`);
				}
				// Remove stranded old callback rows even if Think's mapping lost their id.
				for (const row of await this.host.listSchedules()) {
					const payload = row.payload as { taskId?: string } | null;
					if (
						String(row.callback) === "_runDeclaredScheduledTask" &&
						payload?.taskId === taskId
					) {
						await this.host.assertRuntimeActive();
						await this.host.cancelSchedule(row.id);
						if (await this.host.getScheduleById(row.id))
							throw new Error(
								`Legacy maintenance schedule still exists: ${row.id}`,
							);
					}
				}
				record.legacyCancelled = true;
				await this.host.assertRuntimeActive();
				await this.host.storage.put(this.key(taskId), record);
			}
			if (
				record.recurringScheduleId &&
				(await this.host.getScheduleById(record.recurringScheduleId))
			)
				continue;
			// Recover a crash between native insertion and recording its id.
			const existingRecurring = (await this.host.listSchedules()).find(
				(row) =>
					row.callback === "onParentMaintenance" &&
					row.type === "interval" &&
					row.intervalSeconds === PARENT_MAINTENANCE_TASKS[taskId] &&
					(row.payload as MaintenancePayload | null)?.taskId === taskId &&
					!(row.payload as MaintenancePayload | null)?.bridge,
			);
			if (existingRecurring) {
				record.recurringScheduleId = existingRecurring.id;
				await this.host.assertRuntimeActive();
				await this.host.storage.put(this.key(taskId), record);
				continue;
			}
			if (
				record.nativeScheduleId &&
				(await this.host.getScheduleById(record.nativeScheduleId))
			)
				continue;
			await this.host.assertRuntimeActive();
			const bridge = await this.host.schedule(
				new Date(Math.max(Date.now() + 1000, record.nextRunAt)),
				"onParentMaintenance",
				{ taskId, bridge: true },
				{ idempotent: true, retry: { maxAttempts: 3 } },
			);
			record.nativeScheduleId = bridge.id;
			await this.host.assertRuntimeActive();
			await this.host.storage.put(this.key(taskId), record);
		}
	}

	async run(
		payload: MaintenancePayload,
		schedule: Schedule<MaintenancePayload>,
	): Promise<void> {
		if (!(payload.taskId in PARENT_MAINTENANCE_TASKS))
			throw new Error("Invalid parent maintenance task");
		if (
			!schedule ||
			schedule.callback !== "onParentMaintenance" ||
			!schedule.id ||
			!Number.isFinite(schedule.time) ||
			JSON.stringify(schedule.payload) !== JSON.stringify(payload)
		)
			throw new Error(
				"Maintenance native schedule identity missing or mismatched",
			);
		const scheduledAt = schedule.time * 1000;
		const input = {
			taskId: payload.taskId,
			scheduleId: schedule.id,
			scheduleType: schedule.type,
			scheduledAt,
			bridge: payload.bridge === true,
		};
		const operation: ParentServiceOperation = {
			operationId: `maintenance:${schedule.id}:${schedule.time}`,
			kind: "maintenance",
			scheduledAt,
			input,
			requestHash: await digest(input),
		};
		const fireKey = `tedix:pi:maintenance:fire:${operation.operationId}`;
		let fire = await this.host.storage.get<MaintenanceFire>(fireKey);
		if (fire && JSON.stringify(fire.operation) !== JSON.stringify(operation))
			throw new Error("Maintenance accepted fire input changed");
		if (fire?.stage === "completed" || fire?.stage === "acknowledged") {
			if (!fire.effectReceipt)
				throw new Error("Maintenance completed effect receipt missing");
			await this.host.assertOriginal(fire.operation, fire.claim);
			await this.host.completeOriginal(fire.operation, fire.claim, {
				terminal: "completed",
				receiptHash: await maintenanceCompletionReceiptHash(
					fire.operation,
					fire.effectReceipt,
				),
			});
			await this.host.storage.put(fireKey, { ...fire, stage: "completed" });
			return;
		}
		if (fire?.stage === "running" || fire?.stage === "uncertain")
			throw new Error("Maintenance prior execution is uncertain");
		await this.host.assertRuntimeActive();
		if (!(await this.host.isCanonical())) return;
		if (!fire) {
			fire = {
				operation,
				claim: await this.host.admitAccepted(operation),
				stage: "accepted",
			};
			const admitted = fire;
			fire = await this.host.storage.transaction(async (transaction) => {
				const current = await transaction.get<typeof admitted>(fireKey);
				if (current) {
					if (JSON.stringify(current.operation) !== JSON.stringify(operation))
						throw new Error("Maintenance accepted fire input changed");
					return current;
				}
				await transaction.put(fireKey, admitted);
				return admitted;
			});
		}
		if (fire.stage === "completed" || fire.stage === "acknowledged") {
			if (!fire.effectReceipt)
				throw new Error("Maintenance completed effect receipt missing");
			await this.host.assertOriginal(fire.operation, fire.claim);
			await this.host.completeOriginal(fire.operation, fire.claim, {
				terminal: "completed",
				receiptHash: await maintenanceCompletionReceiptHash(
					fire.operation,
					fire.effectReceipt,
				),
			});
			await this.host.storage.put(fireKey, { ...fire, stage: "completed" });
			return;
		}
		if (fire.stage === "running" || fire.stage === "uncertain")
			throw new Error("Maintenance prior execution is uncertain");
		await this.host.assertActive(fire.operation, fire.claim);
		if (payload.bridge && fire.stage === "accepted") {
			const key = this.key(payload.taskId);
			const record = await this.host.storage.get<MaintenanceRecord>(key);
			if (!record) throw new Error("Maintenance migration record missing");
			if (
				!record.recurringScheduleId ||
				!(await this.host.getScheduleById(record.recurringScheduleId))
			) {
				await this.host.assertActive(fire.operation, fire.claim);
				const recurring = await this.host.scheduleEvery(
					PARENT_MAINTENANCE_TASKS[payload.taskId],
					"onParentMaintenance",
					{ taskId: payload.taskId },
					{ retry: { maxAttempts: 3 } },
				);
				await this.host.assertActive(fire.operation, fire.claim);
				await this.host.storage.put(key, {
					...record,
					recurringScheduleId: recurring.id,
				});
			}
		}
		await this.host.assertActive(fire.operation, fire.claim);
		if (fire.stage === "accepted") {
			await this.host.storage.transaction(async (transaction) => {
				const current = await transaction.get<
					AcceptedServiceOperation & { stage: string }
				>(fireKey);
				if (
					!current ||
					JSON.stringify(current.operation) !==
						JSON.stringify(fire.operation) ||
					current.stage !== "accepted"
				)
					throw new Error(
						"Maintenance original fire already executing or changed",
					);
				await this.host.assertActive(fire.operation, fire.claim);
				await transaction.put(fireKey, { ...fire, stage: "running" });
			});
			fire.stage = "running";
			await this.host.assertActive(fire.operation, fire.claim);
			try {
				const outcome = maintenanceEffect(
					operation,
					await this.host.run(payload.taskId, structuredClone(operation)),
				);
				if (outcome.status === "uncertain") {
					fire.stage = "uncertain";
					fire.uncertainEffect = outcome;
					await this.host.storage.put(fireKey, fire);
					throw new Error("Maintenance effect remains uncertain");
				}
				fire.effectReceipt = outcome;
				fire.stage = "acknowledged";
				await this.host.storage.put(fireKey, fire);
			} catch (error) {
				if (fire.stage === "running") {
					fire.stage = "uncertain";
					fire.uncertainEffect = {
						status: "uncertain",
						operationId: operation.operationId,
						requestHash: operation.requestHash,
						taskId: payload.taskId,
						reason: "unconfirmed",
					};
					await this.host.storage.put(fireKey, fire);
				}
				throw error;
			}
		}
		await this.host.assertOriginal(fire.operation, fire.claim);
		if (!fire.effectReceipt)
			throw new Error("Maintenance acknowledged effect receipt missing");
		await this.host.completeOriginal(fire.operation, fire.claim, {
			terminal: "completed",
			receiptHash: await maintenanceCompletionReceiptHash(
				fire.operation,
				fire.effectReceipt,
			),
		});
		await this.host.storage.put(fireKey, { ...fire, stage: "completed" });
	}
}

// Native Telegram transport and durable delivery.
import { createTelegramAdapter } from "@chat-adapter/telegram";
import {
	Chat,
	ThreadImpl,
	type Author,
	type Message,
	type MessageContext,
	type SerializedThread,
	type Thread,
} from "chat";
import {
	createChatSdkState,
	ChatSdkStateAgent,
	type ChatSdkStateParent,
} from "agents/chat-sdk";
import type { Agent, FiberRecoveryContext, FiberRecoveryResult } from "agents";
import {
	decideTelegramTurn,
	type TelegramTurnPolicyConfig,
} from "./telegram-turn-policy";
import type { SurfaceTrust } from "./turn-trust";

export const TelegramStateAgent = class ThinkMessengerStateAgent extends ChatSdkStateAgent {};

const FIBER = "tedix:pi:telegram-reply";
export interface TelegramTurn {
	operationId: string;
	sessionKey: string;
	text: string;
	metadata: Record<string, unknown>;
	/** Decided by `decideTelegramTurn` from the tedi's channel policy. */
	trust: SurfaceTrust;
}
interface ReplyRecord extends AcceptedServiceOperation {
	version: 1;
	turn: TelegramTurn;
	thread: SerializedThread;
	stage: "accepted" | "answered" | "sending" | "completed" | "uncertain";
	chunks?: string[];
	nextChunk: number;
	messageIds: string[];
	error?: string;
}
interface TelegramHost extends ChatSdkStateParent, ParentServiceAdmissionHost {
	storage: DurableObjectStorage;
	/** Current `channels.telegram` policy; read per message so edits apply live. */
	turnPolicy?(): TelegramTurnPolicyConfig | null;
	startFiber: Agent["startFiber"];
	resolveFiber: Agent["resolveFiber"];
	/** Must use operationId as native Pi submission id and return its owned answer. */
	runTurn(
		turn: TelegramTurn,
		onDelta?: (text: string) => void,
	): Promise<string>;
}
export interface PiTelegramOptions {
	token: string;
	userName: string;
	secretToken: string;
}

function label(author: Author): string {
	return (
		author.userName ? `@${author.userName}` : author.fullName || author.userId
	)
		.replace(/[\r\n:]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}
function split(text: string): string[] {
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 3500) {
		let boundary = remaining.lastIndexOf("\n", 3500);
		if (boundary < 1750) boundary = remaining.lastIndexOf(" ", 3500);
		if (boundary < 1750) boundary = 3500;
		chunks.push(remaining.slice(0, boundary));
		remaining = remaining.slice(boundary);
	}
	if (remaining.trim()) chunks.push(remaining);
	return chunks;
}

export class PiTelegram {
	private readonly adapter;
	private readonly state;
	private readonly chat;
	private readonly userName: string;
	constructor(
		private readonly host: TelegramHost,
		options: PiTelegramOptions,
	) {
		this.userName = options.userName;
		if (!options.secretToken)
			throw new Error("Telegram webhook secret is required");
		this.adapter = createTelegramAdapter({
			botToken: options.token,
			userName: options.userName,
			secretToken: options.secretToken,
			mode: "webhook",
		});
		this.state = createChatSdkState({
			parent: host,
			agent: TelegramStateAgent,
			lockHeartbeat: true,
			keyShard: (key) =>
				key.startsWith("dedupe:telegram:")
					? `telegram:${key.slice(16).split(":")[0]}`
					: undefined,
		});
		this.chat = new Chat({
			userName: options.userName,
			adapters: { telegram: this.adapter },
			state: this.state,
			concurrency: {
				strategy: "burst",
				debounceMs: 600,
				queueEntryTtlMs: 1_800_000,
			},
		});
		this.chat.onDirectMessage((thread, message, _channel, context) =>
			this.message(thread, message, "direct-message", context),
		);
		this.chat.onNewMention(async (thread, message, context) => {
			await this.host.assertRuntimeActive();
			await thread.subscribe();
			await this.message(thread, message, "mention", context);
		});
		this.chat.onSubscribedMessage((thread, message, context) =>
			this.message(
				thread,
				message,
				this.mentionsBot(message) ||
					context?.skipped.some((entry) => this.mentionsBot(entry))
					? "mention"
					: "subscribed-message",
				context,
			),
		);
		this.chat.onNewMessage(/[\s\S]*/, async (thread, message, context) => {
			if (!context?.skipped.some((entry) => this.mentionsBot(entry))) return;
			await this.host.assertRuntimeActive();
			await thread.subscribe();
			await this.message(thread, message, "mention", context);
		});
		this.chat.onAction(async (event) => {
			if (!event.thread) return;
			const details = [
				`Action selected: ${event.actionId}`,
				event.value ? `Value: ${event.value}` : "",
				event.messageId ? `Source message: ${event.messageId}` : "",
			]
				.filter(Boolean)
				.join("\n");
			await this.accept(
				event.thread,
				event.user,
				"action",
				`${event.messageId}:${event.actionId}:${event.user.userId}:${event.value ?? ""}`,
				details,
			);
		});
	}

	private mentionsBot(message: Message): boolean {
		if (message.isMention) return true;
		const escape = (value: string) =>
			value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`@${escape(this.userName)}\\b`, "i").test(message.text))
			return true;
		const id = this.adapter.botUserId;
		return (
			!!id &&
			new RegExp(`(?:@${escape(id)}\\b|<@!?${escape(id)}>)`, "i").test(
				message.text,
			)
		);
	}

	async handleRequest(request: Request): Promise<Response> {
		await this.host.assertRuntimeActive();
		if (request.method !== "POST")
			return Promise.resolve(
				new Response("Method Not Allowed", { status: 405 }),
			);
		// Do not pass waitUntil: respond only after the durable handler has settled.
		return this.chat.webhooks.telegram(request);
	}

	/** Closes the durable-input-before-fiber crash window on every DO wake. */
	async recoverPending(): Promise<void> {
		const prefix = "tedix:pi:telegram:reply:";
		let startAfter: string | undefined;
		for (;;) {
			const records = await this.host.storage.list<ReplyRecord>({
				prefix,
				limit: 100,
				...(startAfter ? { startAfter } : {}),
			});
			for (const [key, record] of records) {
				startAfter = key;
				if (record.stage === "completed" || record.stage === "uncertain")
					continue;
				if (this.fullyAcknowledged(record)) {
					await this.execute(record.turn.operationId);
					continue;
				}
				await this.host.assertRuntimeActive();
				await this.chat.initialize();
				await this.assertRecord(record);
				const lock = await this.state.acquireLock(record.thread.id, 30_000);
				if (!lock) continue;
				try {
					await this.execute(record.turn.operationId);
				} finally {
					await this.state.releaseLock(lock);
				}
			}
			if (records.size < 100) break;
		}
	}

	private key(operationId: string): string {
		return `tedix:pi:telegram:reply:${operationId}`;
	}
	private async message(
		thread: Thread<unknown>,
		message: Message,
		kind: string,
		context?: MessageContext,
	): Promise<void> {
		const messages = [...(context?.skipped ?? []), message];
		const text = messages
			.map((entry) => {
				const speaker = thread.isDM ? "" : `${label(entry.author)}: `;
				const attachments = entry.attachments
					.map(
						(file) =>
							`${file.name || file.type}${file.url ? ` (${file.url})` : ""}`,
					)
					.join("\n");
				return `${speaker}${entry.text}${attachments ? `\nAttachments:\n${attachments}` : ""}`;
			})
			.join("\n");
		await this.accept(thread, message.author, kind, message.id, text);
	}

	private async accept(
		thread: Thread<unknown>,
		author: Author,
		kind: string,
		messageId: string,
		text: string,
	): Promise<void> {
		if (author.isMe) return;
		const decision = decideTelegramTurn(this.host.turnPolicy?.() ?? null, {
			isDM: thread.isDM,
			channelId: thread.channelId,
			author,
			mentioned: kind !== "subscribed-message",
		});
		if (!decision.accept) {
			console.log({
				event: "tedi.telegram.dropped",
				reason: decision.reason,
				threadId: thread.id,
				messageId,
			});
			return;
		}
		const threadId = thread.id;
		const operationId = `telegram:${threadId}:${messageId}`;
		const key = this.key(operationId);
		let record = await this.host.storage.get<ReplyRecord>(key);
		{
			const serialized = thread.toJSON();
			const providerThreadId = threadId;
			const sessionKey = `telegram:${providerThreadId}`;
			const metadata = {
				surface: "messenger",
				provider: "telegram",
				messengerId: "telegram",
				kind,
				sessionKey,
				thread: {
					id: threadId,
					providerThreadId,
					channelId: thread.channelId,
					isDirectMessage: thread.isDM,
				},
				principal: {
					id: author.userId,
					userName: author.userName,
					fullName: author.fullName,
					isBot: author.isBot,
				},
			};
			const candidate = {
				version: 1 as const,
				turn: {
					operationId,
					sessionKey,
					text:
						kind === "action" && !thread.isDM
							? `${label(author)}: ${text}`
							: text,
					metadata,
					trust: decision.trust,
				},
				thread: serialized,
				stage: "accepted" as const,
				nextChunk: 0,
				messageIds: [],
			};
			const input = { turn: candidate.turn, thread: candidate.thread };
			const operation: ParentServiceOperation = {
				operationId,
				kind: "telegram",
				sessionKey,
				input,
				requestHash: await digest(input),
			};
			if (record) {
				if (JSON.stringify(record.operation) !== JSON.stringify(operation))
					throw new Error("Telegram accepted input changed");
			} else {
				record = {
					...candidate,
					operation,
					claim: await this.host.admitAccepted(operation),
				};
				await this.assertRecord(record);
				const admitted = record;
				record = await this.host.storage.transaction(async (transaction) => {
					const current = await transaction.get<ReplyRecord>(key);
					if (current) {
						if (JSON.stringify(current.operation) !== JSON.stringify(operation))
							throw new Error("Telegram accepted input changed");
						return current;
					}
					await transaction.put(key, admitted);
					return admitted;
				});
			}
		}
		if (record.stage === "completed" || record.stage === "uncertain") return;
		if (this.fullyAcknowledged(record)) {
			await this.execute(operationId);
			return;
		}
		await this.assertRecord(record);
		await this.host.startFiber(
			FIBER,
			async (fiber) => {
				fiber.stash({ operationId });
				await this.execute(operationId, thread);
			},
			{
				idempotencyKey: operationId,
				metadata: { operationId },
				waitForCompletion: true,
			},
		);
	}

	private fullyAcknowledged(record: ReplyRecord): boolean {
		return (
			record.stage === "answered" &&
			Array.isArray(record.chunks) &&
			record.chunks.length > 0 &&
			Array.isArray(record.messageIds) &&
			record.nextChunk === record.chunks.length &&
			record.messageIds.length === record.chunks.length &&
			record.messageIds.every(
				(id) => typeof id === "string" && Boolean(id.trim()),
			)
		);
	}

	private async assertRecord(
		record: ReplyRecord,
		receiptOnly = false,
	): Promise<void> {
		if (!record.operation || !("claim" in record))
			throw new Error("Telegram original admission is missing");
		const input = { turn: record.turn, thread: record.thread };
		if (
			record.operation.operationId !== record.turn.operationId ||
			record.operation.kind !== "telegram" ||
			record.operation.sessionKey !== record.turn.sessionKey ||
			JSON.stringify(record.operation.input) !== JSON.stringify(input) ||
			record.operation.requestHash !== (await digest(input))
		)
			throw new Error("Telegram original admission input changed");
		await this.host.assertOriginal(record.operation, record.claim);
		if (!receiptOnly)
			await this.host.assertActive(record.operation, record.claim);
	}

	private async execute(
		operationId: string,
		liveThread?: Thread<unknown>,
	): Promise<void> {
		const key = this.key(operationId);
		const record = await this.host.storage.get<ReplyRecord>(key);
		if (!record) throw new Error("Telegram durable reply record is missing");
		if (record.stage === "completed" || record.stage === "uncertain") return;
		await this.assertRecord(record, this.fullyAcknowledged(record));
		if (record.stage === "sending") {
			record.stage = "uncertain";
			record.error =
				"Telegram send acknowledgment was lost; automatic replay is fenced";
			await this.host.storage.put(key, record);
			console.error("[tedi.pi.telegram.delivery_uncertain]", {
				operationId,
				chunk: record.nextChunk,
			});
			return;
		}
		const thread =
			liveThread ?? ThreadImpl.fromJSON(record.thread, this.adapter);
		if (record.stage === "accepted") {
			await this.assertRecord(record);
			await thread
				.startTyping()
				.catch((error) =>
					console.warn("[tedi.pi.telegram.typing_failed]", error),
				);
			await this.assertRecord(record);
			const answer = await this.host.runTurn(record.turn);
			await this.assertRecord(record);
			record.chunks = split(
				answer.trim() ||
					"I couldn't produce a text response. Please try again.",
			);
			record.stage = "answered";
			await this.host.storage.put(key, record);
		}

		for (; record.nextChunk < (record.chunks?.length ?? 0);) {
			const chunk = record.chunks?.[record.nextChunk];
			if (chunk === undefined) throw new Error("Telegram reply chunk missing");
			await this.assertRecord(record);
			record.stage = "sending";
			await this.host.storage.put(key, record);
			try {
				await this.assertRecord(record);
				const sent = await thread.post({ markdown: chunk });
				if (!("id" in sent) || typeof sent.id !== "string" || !sent.id.trim())
					throw new Error("Telegram send lacks acknowledgment id");
				await this.assertRecord(record, true);
				record.messageIds.push(sent.id);
				record.nextChunk++;
				record.stage = "answered";
				await this.host.storage.put(key, record);
			} catch (error) {
				// Even a network rejection can occur after Telegram accepted the send.
				record.stage = "uncertain";
				record.error = error instanceof Error ? error.message : String(error);
				await this.host.storage.put(key, record);
				throw error;
			}
		}
		await this.assertRecord(record, true);
		await this.host.completeOriginal(record.operation, record.claim, {
			terminal: "completed",
			receiptHash: await digest({
				operationId,
				messageIds: record.messageIds,
				nextChunk: record.nextChunk,
			}),
		});
		record.stage = "completed";
		await this.host.storage.put(key, record);
	}

	async onFiberRecovered(
		context: FiberRecoveryContext,
	): Promise<FiberRecoveryResult | undefined> {
		if (context.name !== FIBER) return undefined;
		const operationId =
			context.metadata?.operationId ??
			(context.snapshot as { operationId?: string } | null)?.operationId;
		if (typeof operationId !== "string")
			return {
				status: "error",
				error: "Telegram recovery operation id missing",
			};
		const record = await this.host.storage.get<ReplyRecord>(
			this.key(operationId),
		);
		if (!record)
			return { status: "error", error: "Telegram recovery record missing" };
		if (record.stage === "completed")
			return { status: "completed", snapshot: { operationId } };
		if (record.stage === "uncertain")
			return {
				status: "interrupted",
				reason: record.error,
				snapshot: { operationId },
			};
		if (this.fullyAcknowledged(record)) {
			await this.execute(operationId);
			return { status: "completed", snapshot: { operationId } };
		}
		await this.host.assertRuntimeActive();
		await this.chat.initialize();
		await this.assertRecord(record);
		const lock = await this.state.acquireLock(record.thread.id, 30_000);
		if (!lock) throw new Error("Telegram recovery thread lock busy");
		try {
			await this.execute(operationId);
			const terminal = await this.host.storage.get<ReplyRecord>(
				this.key(operationId),
			);
			return terminal?.stage === "uncertain"
				? {
						status: "interrupted",
						reason: terminal.error,
						snapshot: { operationId },
					}
				: terminal?.stage === "completed"
					? { status: "completed", snapshot: { operationId } }
					: { status: "error", error: "Telegram delivery is not terminal" };
		} finally {
			await this.state.releaseLock(lock);
		}
	}
}

/** Consume the existing streamChatTurn SSE contract without selecting latest history. */
export async function consumeTelegramTurnStream(
	response: Response,
	onDelta?: (text: string) => void,
): Promise<string> {
	if (!response.ok || !response.body)
		throw new Error(`Telegram turn stream unavailable (${response.status})`);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let answer: string | undefined;
	const frame = (block: string) => {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data) return;
		const event = JSON.parse(data) as {
			kind?: string;
			text?: string;
			message?: string;
		};
		if (event.kind === "error")
			throw new Error(event.message ?? "Telegram turn failed");
		if (event.kind === "delta" && typeof event.text === "string")
			onDelta?.(event.text);
		if (event.kind === "done" && typeof event.text === "string")
			answer = event.text;
	};
	try {
		for (;;) {
			const next = await reader.read();
			pending += decoder
				.decode(next.value, { stream: !next.done })
				.replace(/\r\n/g, "\n");
			let boundary: number;
			while ((boundary = pending.indexOf("\n\n")) >= 0) {
				frame(pending.slice(0, boundary));
				pending = pending.slice(boundary + 2);
			}
			if (next.done) break;
		}
		if (pending.trim()) frame(pending);
		if (answer === undefined)
			throw new Error("Telegram turn ended without owned terminal answer");
		return answer;
	} finally {
		reader.releaseLock();
	}
}

/** Run before super(): Agents recovers fibers before calling user onStart.
 * Read-only activation fence; never cancels, resolves or deletes old work. */
export function assertLegacyThinkTasksSettled(
	storage: Pick<DurableObjectStorage, "sql">,
): void {
	const tables = new Set(
		[
			...storage.sql.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table'",
			),
		].map((row) => row.name),
	);
	const pending = (table: string, query: string) => {
		if (!tables.has(table)) return;
		const row = [...storage.sql.exec<{ id: string }>(query)][0];
		if (row)
			throw new Error(
				`Legacy Think recovery receipt requires reconciliation before Pi activation: ${table}:${row.id}`,
			);
	};
	pending(
		"cf_agents_fibers",
		"SELECT fiber_id AS id FROM cf_agents_fibers WHERE (name = 'think:messenger-reply' OR name = '__cf_internal_chat_turn' OR name GLOB '__cf_internal_chat_turn:*') AND status NOT IN ('completed','aborted','error') LIMIT 1",
	);
	// The SDK adds `completed_at` inside super(), so a table from an older SDK
	// lacks it here; that schema deleted finished runs, so every row is open.
	const runsTrackCompletion =
		tables.has("cf_agents_runs") &&
		[
			...storage.sql.exec<{ name: string }>(
				"SELECT name FROM pragma_table_info('cf_agents_runs') WHERE name='completed_at'",
			),
		].length !== 0;
	pending(
		"cf_agents_runs",
		"SELECT id FROM cf_agents_runs WHERE (name = 'think:messenger-reply' OR name = '__cf_internal_chat_turn' OR name GLOB '__cf_internal_chat_turn:*')" +
			(runsTrackCompletion ? " AND completed_at IS NULL" : "") +
			" LIMIT 1",
	);
	pending(
		"cf_agents_task_runs",
		"SELECT run_id AS id FROM cf_agents_task_runs WHERE definition IN ('__cf_internal_messenger_reply','__cf_internal_chat_turn','__cf_internal_chat_recovery') AND state IN ('pending','running','waiting') LIMIT 1",
	);
	if (tables.has("cf_think_submissions")) {
		const hasResultStatus =
			[
				...storage.sql.exec<{ name: string }>(
					"SELECT name FROM pragma_table_info('cf_think_submissions') WHERE name='result_status'",
				),
			].length !== 0;
		pending(
			"cf_think_submissions",
			"SELECT submission_id AS id FROM cf_think_submissions WHERE status NOT IN ('completed','aborted','skipped','error')" +
				(hasResultStatus ? " OR result_status = 'retry'" : "") +
				" LIMIT 1",
		);
	}
}

/** Run before any Pi cognitive submit; catches snapshots without live SQL runs.
 * Completed messenger snapshots and terminal recovery incidents stay retained. */
export async function assertLegacyThinkReceiptsSettled(
	storage: Pick<DurableObjectStorage, "get" | "list">,
): Promise<void> {
	if (await storage.get("facet-pending-submission"))
		throw new Error(
			"Legacy Think facet receipt requires reconciliation before Pi cognition",
		);
	for (const prefix of [
		"__cf_messenger_recovery:",
		"cf:chat-recovery:incident:",
	]) {
		let startAfter: string | undefined;
		for (;;) {
			const rows = await storage.list<Record<string, unknown>>({
				prefix,
				limit: 100,
				...(startAfter ? { startAfter } : {}),
			});
			for (const [key, receipt] of rows) {
				startAfter = key;
				if (
					prefix === "__cf_messenger_recovery:"
						? receipt?.stage !== "completed"
						: !["completed", "skipped", "exhausted", "failed"].includes(
								String(receipt?.status),
							)
				)
					throw new Error(
						`Legacy Think persisted receipt requires reconciliation before Pi cognition: ${key}`,
					);
			}
			if (rows.size < 100) break;
		}
	}
}

/** Passive projection; phase metadata never proves a completed effect. */
export function inspectMaintenanceRecords(storage: DurableObjectStorage) {
	const schema = z.strictObject({
		nextRunAt: z.number().finite(),
		legacyScheduleIds: z.array(z.string().min(1).max(512)).max(200),
		legacyCancelled: z.boolean(),
		nativeScheduleId: z.string().min(1).max(512).optional(),
		recurringScheduleId: z.string().min(1).max(512).optional(),
	});
	const pairs = new Map(
		storage.kv.list({ prefix: "tedix:pi:maintenance:v1:" }),
	);
	if (pairs.size > 200) throw new Error("Invalid maintenance inventory");
	const result = [];
	for (const [key, value] of [...pairs].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const taskId = key.slice("tedix:pi:maintenance:v1:".length);
		if (
			!Object.keys(PARENT_MAINTENANCE_TASKS).includes(
				taskId as ParentMaintenanceTask,
			)
		)
			throw new Error("Invalid maintenance task identity");
		const record = schema.parse(value);
		result.push({
			taskId,
			nextRunAt: record.nextRunAt,
			legacyScheduleIds: record.legacyScheduleIds,
			legacyCancelled: record.legacyCancelled,
			nativeScheduleId: record.nativeScheduleId ?? null,
			recurringScheduleId: record.recurringScheduleId ?? null,
		});
	}
	return result;
}
