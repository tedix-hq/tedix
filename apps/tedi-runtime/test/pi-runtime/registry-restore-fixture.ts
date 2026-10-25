import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import {
	Harness,
	createRegistry,
	defineTask,
	type TaskId,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RuntimeAdmissionDO } from "../../src/runtime-admission-do";
import {
	runtimeFacetTurns,
	type RuntimeFacetTurnsHost,
} from "../../src/runtime-facet-turns";
import { FacetDispatchJournal } from "../../src/facet-dispatch-journal";
import { KeyedFacetTurnGate } from "../../src/facet-turn-gate";
import { assertTediChatNotCanceled } from "../../src/pi-recovery";
import type { ChatTurnParams } from "../../src/chat-turn-input";
import { jsonSchema, type ToolSet } from "ai";

const RUN = "native-registry-run";
const SESSION = "agent:main:registry";

/** Native scheduler/SQLite and production parent proxy; only tool preparation/effects are scripted. */
export class RegistryRestoreFixture extends Agent<
	Cloudflare.Env,
	{ tediId: string; orgId: string }
> {
	initialState = {
		tediId: "registry-native-tedi",
		orgId: "registry-native-org",
	};
	private readonly active = new Map<string, ToolSet>();
	private readonly conversations = new Map<string, string>();
	private readonly authorities = new Map();
	private readonly turns = new KeyedFacetTurnGate();
	private readonly journal = new FacetDispatchJournal(this.ctx.storage);
	private admission() {
		return new RuntimeAdmissionDO(this.ctx.storage, {
			...this.state,
			objectId: this.ctx.id.toString(),
		});
	}
	private tools(): ToolSet {
		return {
			probe: {
				inputSchema: jsonSchema({ type: "object", properties: {} }),
				execute: async () => {
					await this.ctx.storage.put(
						"effects",
						(this.ctx.storage.kv.get<number>("effects") ?? 0) + 1,
					);
					return { ok: true };
				},
			},
		};
	}
	private host(): RuntimeFacetTurnsHost {
		return {
			ctx: this.ctx,
			state: this.state,
			activeFacetTurnTools: this.active,
			activeFacetTurnConversations: this.conversations,
			activeFacetTurnAuthorities: this.authorities,
			facetWorkflowTurns: this.turns,
			facetDispatchJournal: this.journal,
			assertChatTurnActive: async (runId: string) => {
				await assertTediChatNotCanceled(runId, async (id) =>
					Boolean(this.ctx.storage.kv.get(`wfcancel:${id}`)),
				);
				await this.admission().assertAcceptedTurn({ runId });
			},
			ensureIdentity: async () => {},
			prepareMcpFacetTurn: async () => {
				await this.ctx.storage.put(
					"preparations",
					(this.ctx.storage.kv.get<number>("preparations") ?? 0) + 1,
				);
				return { tools: this.tools(), system: "", turnBinding: null };
			},
			getPlatformClient: async () => {
				throw new Error("Ordinary task must not acquire a Work lease");
			},
			bufferFacetToolCall: () => 0,
			completeFacetToolCall: async () => {},
			nativeToolLedger: {
				observe: async (
					_context: unknown,
					_call: unknown,
					execute: () => Promise<unknown>,
				) => execute(),
			},
		} as unknown as RuntimeFacetTurnsHost;
	}
	private readonly task = defineTask<
		{ until: number },
		{ phase: "pause" | "tool" },
		null
	>({
		name: "fixture.registry-restore",
		version: 1,
		initial: () => ({ phase: "pause" }),
		phases: {
			pause: async (task, runtime, context) => {
				await runtime.sleepUntil(task.input.until, { phase: "tool" }, context);
			},
			tool: async (task, runtime, context) => {
				const result = await runtimeFacetTurns.executeFacetTool.call(
					this.host(),
					{
						runId: RUN,
						toolCallId: `task-${task.id}`,
						tool: "probe",
						args: {},
					},
				);
				if (
					!(
						result &&
						typeof result === "object" &&
						"ok" in result &&
						result.ok === true
					)
				)
					throw new Error("Native task could not restore its original tool");
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: null },
					}),
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }),
				context,
			);
		},
	});
	private readonly native = new PiHarness({
		harness: async ({ storage, context, onWake }) => {
			const registry = createRegistry();
			registry.install({
				name: "registry-restore-fixture",
				tasks: [this.task],
			});
			return Harness.open(
				storage,
				{ registry, models: createModels(), onWake },
				context,
			);
		},
	});
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.lifecycle.use(this.native);
	}
	async begin() {
		const admission = this.admission();
		admission.gate.initialize({
			operationId: "native-registry-init",
			state: "active",
			evidence: await admission.prepareEvidence("initialize"),
		});
		const params: ChatTurnParams = {
			runId: RUN,
			sessionKey: SESSION,
			userText: "Restore one owned fixture tool",
			userTs: 1,
			conversationId: "registry:agent:main:registry",
			clientRequestId: "registry",
		};
		await admission.beginAcceptedTurn({
			runId: RUN,
			sessionKey: SESSION,
			principalId: this.state.tediId,
			input: { kind: "fixture-ingress" },
			expectedGeneration: 1,
		});
		await this.ctx.storage.put(`runtime-admission-workflow:${RUN}`, {
			params,
			id: "registry",
			stage: "dispatched",
		});
		await this.journal.enroll(RUN);
		this.active.set(RUN, this.tools());
		const pi = await this.native.pi();
		const conversation = await this.native.conversation(
			(await this.native.sessions.create()).id,
		);
		const id = await pi.commit(
			(tx) =>
				tx.createTask(
					this.task,
					{ until: Date.now() + 3_000 },
					{
						conversationId: conversation.id,
						ownership: { kind: "conversation" },
					},
				),
			BACKGROUND_CONTEXT,
		);
		await this.ctx.storage.put("task-id", id);
		return Number(id);
	}
	async snapshot() {
		const id = this.ctx.storage.kv.get<TaskId<null>>("task-id")!;
		const task = await (
			await this.native.storage()
		).task(id, BACKGROUND_CONTEXT);
		const inspection = await (
			await this.native.pi()
		).inspect(BACKGROUND_CONTEXT);
		const callId = `task-${id}`;
		const receipt = this.ctx.storage.kv.get<{ status: string }>(
			`facet-dispatch-call:${JSON.stringify([RUN, callId])}`,
		);
		return {
			id: Number(id),
			status: task?.state.status,
			outcome:
				task?.state.status === "terminal" ? task.state.outcome.status : null,
			registry: this.active.has(RUN),
			liveTasks: inspection.tasks.length,
			callId,
			dispatchStatus: receipt?.status ?? null,
			effects: this.ctx.storage.kv.get<number>("effects") ?? 0,
			preparations: this.ctx.storage.kv.get<number>("preparations") ?? 0,
			accepted: await this.admission().assertOriginalClaim({ runId: RUN }),
		};
	}
	async abortProbe() {
		const id = this.ctx.storage.kv.get<TaskId<null>>("task-id");
		if (id) await (await this.native.pi()).abortTask(id, BACKGROUND_CONTEXT);
	}
}
