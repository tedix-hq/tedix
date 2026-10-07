import {
	readPrivateInferenceOrigin,
	type RuntimeInferenceOrigin,
} from "../../src/runtime-inference-origin";
import { assertProviderDispatchReady } from "@tedix/workers-ai/gateway-transport";
import { CLOUDFLARE_AUTO_PROVIDER_METADATA_KEY } from "@tedix/workers-ai/model-select";
export {
	DurableCodeRecoveryFixture,
	RecoveryRuntimeFixture as CodemodeRuntime,
} from "./durable-codemode-recovery-fixture";
import { recordToolRead, refuseStaleWrite } from "../../src/read-evidence";
export { ComputerTurnFixture } from "./computer-turn-fixture";
export { KernelWakeFixture } from "./kernel-wake-fixture";
export { PiPlatformFixture } from "./platform-fixtures";
import { PiStorageFixture as ActualPiStorageFixture } from "./storage-fixture";
export class PiStorageFixture extends ActualPiStorageFixture {
	protected override facetAdmissionClassName() {
		return null;
	}
	protected override async facetAdmissionCustody(
		_runId: string,
		_sessionKey: string,
	): Promise<import("../../src/pi-agent").FacetAdmissionResponse> {
		return { enabled: false as const };
	}
}
import { PiFacetMediaFixture as ActualPiFacetMediaFixture } from "./media-fixture";
export class PiFacetMediaFixture extends ActualPiFacetMediaFixture {
	protected override async facetAdmissionCustody(
		_runId: string,
		_sessionKey: string,
	): Promise<import("../../src/pi-agent").FacetAdmissionResponse> {
		return { enabled: false as const };
	}
}
export { TediComputerWorkspaceDO } from "../../src/computer-workspace-do";
export { WorkspaceServiceProxy } from "@cloudflare/computer";
import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import {
	Harness,
	createRegistry,
	defineExtension,
	defineTool,
} from "@earendil-works/pi-durable";
import {
	createModels,
	Type,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import { createTedixPiProvider } from "../../src/pi-model";
import type { LanguageModelV3 } from "@ai-sdk/provider";

const model: Model<Api> = {
	id: "test",
	name: "Test",
	provider: "tedix",
	api: "openai-completions",
	baseUrl: "",
	input: ["text"],
	reasoning: false,
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
interface State {
	requests: number;
	reservations: number;
	receipts: number;
	blocked: boolean;
	effects: number;
	toolMode: boolean;
	stall: boolean;
}
export class PiRuntimeFixture extends Agent<Cloudflare.Env, State> {
	initialState: State = {
		requests: 0,
		reservations: 0,
		receipts: 0,
		blocked: false,
		effects: 0,
		toolMode: false,
		stall: false,
	};
	private readonly native = new PiHarness({
		defaults: { model },
		harness: async ({ storage, context }) => {
			const models = createModels();
			models.setProvider(
				createTedixPiProvider({
					catalog: () => [model],
					resolveModel: () => this.model(),
					prepare: async () => {
						if (this.state.blocked) throw new Error("authority revoked");
						this.setState({
							...this.state,
							reservations: this.state.reservations + 1,
						});
						return { receipt: crypto.randomUUID() };
					},
					settled: async (receipt, _message, measurement) => {
						if (!receipt || !measurement.hasUsage)
							throw new Error("usage receipt unavailable");
						this.setState({ ...this.state, receipts: this.state.receipts + 1 });
					},
				}),
			);
			const registry = createRegistry();
			registry.install(this.toolExtension);
			return Harness.open(
				storage,
				{
					models,
					registry,
					settings: { retry: { enabled: false, maxRetries: 0 } },
				},
				context,
			);
		},
	});
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.lifecycle.use(this.native);
	}
	private readonly tool = defineTool({
		name: "fixture_effect",
		description: "One durable effect",
		parameters: Type.Object({}),
		replay: "unsafe",
		execute: async () => {
			this.setState({ ...this.state, effects: this.state.effects + 1 });
			return { content: [{ type: "text", text: "effect recorded" }] };
		},
	});
	private readonly toolExtension = defineExtension({
		name: "fixture",
		tools: [this.tool],
	});
	async enableTool() {
		this.setState({ ...this.state, toolMode: true });
		const pi = await this.native.pi();
		const context = {
			abortSignal: undefined,
			value: () => undefined,
			toString: () => "fixture",
		};
		const conversation = await pi.conversation(
			1 as Parameters<typeof pi.conversation>[0],
			context,
		);
		if (!conversation) throw new Error("missing fixture session");
		await conversation.configure(
			{ extensions: [this.toolExtension], tools: [this.tool] },
			context,
		);
	}
	private model(): LanguageModelV3 {
		return {
			specificationVersion: "v3",
			provider: "test",
			modelId: "test",
			supportedUrls: {},
			doGenerate: async () => {
				throw new Error("stream only");
			},
			doStream: async (options) => {
				this.setState({ ...this.state, requests: this.state.requests + 1 });
				const stall = this.state.stall;
				const callTool =
					this.state.toolMode &&
					!options.prompt.some((message) => message.role === "tool");
				return {
					stream: new ReadableStream({
						start(controller) {
							if (callTool) {
								controller.enqueue({
									type: "tool-call",
									toolCallId: "exact-effect",
									toolName: "fixture_effect",
									input: "{}",
								});
								controller.enqueue({
									type: "finish",
									finishReason: { unified: "tool-calls", raw: "tool-calls" },
									usage: {
										inputTokens: {
											total: 2,
											noCache: 2,
											cacheRead: 0,
											cacheWrite: 0,
										},
										outputTokens: { total: 3, text: 3, reasoning: 0 },
									},
								});
								controller.close();
								return;
							}
							if (stall) {
								controller.enqueue({ type: "text-start", id: "t" });
								controller.enqueue({
									type: "text-delta",
									id: "t",
									delta: "partial",
								});
								return;
							}
							controller.enqueue({ type: "text-start", id: "t" });
							controller.enqueue({
								type: "text-delta",
								id: "t",
								delta: "native Pi answer",
							});
							controller.enqueue({ type: "text-end", id: "t" });
							controller.enqueue({
								type: "finish",
								finishReason: { unified: "stop", raw: "stop" },
								usage: {
									inputTokens: {
										total: 2,
										noCache: 2,
										cacheRead: 0,
										cacheWrite: 0,
									},
									outputTokens: { total: 3, text: 3, reasoning: 0 },
								},
							});
							controller.close();
						},
					}),
				};
			},
		};
	}
	async submit(id: string) {
		return JSON.stringify(
			await this.native.submit("hello", { operationId: id }),
		);
	}
	async wait(id: string) {
		return JSON.stringify(await this.native.wait(id));
	}
	async inspect() {
		return this.state;
	}
	async stallRequest() {
		this.setState({ ...this.state, stall: true });
	}
	async allowRestart() {
		this.setState({ ...this.state, stall: false });
	}
	async revoke() {
		this.setState({ ...this.state, blocked: true });
	}
}
export default {
	fetch() {
		return new Response("Pi runtime fixture");
	},
};

import {
	ConversationFacet as ProductionConversationFacet,
	type ConversationParentPort,
	type ConversationTurnConfiguration,
} from "../../src/conversation-facet";
import { DoInferenceBudgetStore } from "../../src/inference-budget-store-do";
import { FacetDispatchJournal } from "../../src/facet-dispatch-journal";
export interface ConversationStats {
	requests: number;
	effects: number;
	reservations: number;
	receipts: number;
	mode: "text" | "tool" | "stall" | "overflow";
	cancelled: boolean;
	prompts: unknown[];
	toolChoices: unknown[];
	modelSteps?: unknown[];
}
const conversationStats = (): ConversationStats => ({
	requests: 0,
	effects: 0,
	reservations: 0,
	receipts: 0,
	mode: "text",
	cancelled: false,
	prompts: [],
	toolChoices: [],
});
export class PiConversationFixture extends ProductionConversationFacet {
	protected override async facetAdmissionCustody(
		_runId: string,
		_sessionKey: string,
	): Promise<import("../../src/pi-agent").FacetAdmissionResponse> {
		return { enabled: false as const };
	}
	private readonly budget = new DoInferenceBudgetStore(this);
	private readonly dispatch = new FacetDispatchJournal(this.ctx.storage);
	private readonly limits = {
		dailyMessageLimit: -1,
		dailyTokenLimit: -1,
		operatorMessageReserve: 0,
		operatorTokenReserve: 0,
		governedLearningMessageReserve: 0,
		governedLearningTokenReserve: 0,
	};
	private async stats() {
		return (
			(await this.ctx.storage.get<ConversationStats>("fixture:stats")) ??
			conversationStats()
		);
	}
	protected async parent(): Promise<ConversationParentPort> {
		return {
			assertChatTurnActive: async () => {
				if ((await this.stats()).cancelled)
					throw new Error("fixture authority cancelled");
			},
			enrollFacetDispatchRun: async (runId) => {
				this.budget.admit(runId, this.limits, 1);
				await this.dispatch.enroll(runId);
			},
			reservePiStep: async (input) => {
				const stats = await this.stats();
				if (stats.cancelled) throw new Error("fixture authority cancelled");
				const receipt = this.budget.reserveStep(
					input.runId,
					input.stepId,
					input.estimatedTokens,
					this.limits,
				);
				await this.ctx.storage.put("fixture:stats", {
					...stats,
					reservations: stats.reservations + 1,
				});
				return receipt;
			},
			recordPiStep: async (input) => {
				const result = this.budget.recordStep(
					input.runId,
					input.stepId,
					input.actualTokens,
					this.limits,
				);
				const stats = await this.stats();
				await this.ctx.storage.put("fixture:stats", {
					...stats,
					receipts: stats.receipts + 1,
				});
				return result;
			},
			reconcileFacetToolEffect: async (runId, toolCallId) =>
				this.dispatch.returned(runId, toolCallId),
			recordFacetModelStep: async (input) => {
				const stats = await this.stats();
				await this.ctx.storage.put("fixture:stats", {
					...stats,
					modelSteps: [...(stats.modelSteps ?? []), input.payload],
				});
			},
			executeFacetTool: async (input) => {
				if ((await this.stats()).cancelled)
					throw new Error("fixture authority cancelled");
				if (!(await this.dispatch.claim(input, true)))
					throw new Error("fixture duplicate effect rejected");
				const stats = await this.stats();
				await this.ctx.storage.put("fixture:stats", {
					...stats,
					effects: stats.effects + 1,
				});
				await this.dispatch.markReturned(input, "completed");
				return { ok: true };
			},
			checkFacetTurnBudget: async () => ({ abort: false, reason: null }),
		};
	}
	protected selectModelForTurn() {
		return {
			model: this.conversationModel(),
			identity: { provider: "workers-ai" as const, model: "@cf/test" },
		};
	}
	private conversationModel(): LanguageModelV3 {
		return {
			specificationVersion: "v3",
			provider: "test",
			modelId: "native-facet",
			supportedUrls: {},
			doGenerate: async () => {
				throw new Error("stream only");
			},
			doStream: async (options) => {
				const stats = await this.stats();
				const request = stats.requests + 1;
				await this.ctx.storage.put("fixture:stats", {
					...stats,
					requests: request,
					prompts: [
						...stats.prompts,
						JSON.parse(JSON.stringify(options.prompt)) as unknown,
					],
					toolChoices: [...stats.toolChoices, options.toolChoice ?? null],
				});
				let lastUser = -1;
				options.prompt.forEach((message, index) => {
					if (message.role === "user") lastUser = index;
				});
				const tool =
					stats.mode === "tool" &&
					options.toolChoice?.type !== "none" &&
					!options.prompt
						.slice(lastUser + 1)
						.some((message) => message.role === "tool");
				return {
					stream: new ReadableStream({
						start: (controller) => {
							if (stats.mode === "overflow" && request === 2) {
								controller.error(new Error("input is too long"));
								return;
							}
							if (stats.mode === "stall") {
								controller.enqueue({ type: "text-start", id: "text" });
								controller.enqueue({
									type: "text-delta",
									id: "text",
									delta: "partial",
								});
								options.abortSignal?.addEventListener(
									"abort",
									() => controller.error(options.abortSignal?.reason),
									{ once: true },
								);
								return;
							}
							if (tool)
								controller.enqueue({
									type: "tool-call",
									toolCallId: `fixture-call:${this.state.runId}`,
									toolName: "fixture_effect",
									input: "{}",
								});
							else {
								controller.enqueue({ type: "text-start", id: "text" });
								controller.enqueue({
									type: "text-delta",
									id: "text",
									delta: `owned answer ${request}`,
								});
								controller.enqueue({ type: "text-end", id: "text" });
							}
							controller.enqueue({
								type: "finish",
								finishReason: {
									unified: tool ? "tool-calls" : "stop",
									raw: tool ? "tool-calls" : "stop",
								},
								usage: {
									inputTokens: {
										total: 2,
										noCache: 2,
										cacheRead: 0,
										cacheWrite: 0,
									},
									outputTokens: { total: 3, text: 3, reasoning: 0 },
								},
								// Auto Router routing receipt, as packages/workers-ai attaches it.
								providerMetadata: {
									[CLOUDFLARE_AUTO_PROVIDER_METADATA_KEY]: {
										routedModel: "@cf/routed-test",
										routingReason: "fixture-route",
										routingDecisionId: "decision-1",
									},
								},
							});
							controller.close();
						},
					}),
				};
			},
		};
	}
	protected summarizeCompaction(
		messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
	): Promise<string | null> {
		return this.ctx.storage
			.put("fixture:summary-input", messages)
			.then(() => "Fixture retained summary");
	}
	async seedReadEvidenceFixture() {
		recordToolRead(
			"pi-compaction-check",
			"read",
			undefined,
			{ path: "/compaction-proof.txt" },
			{ content: "retained" },
		);
		return (
			refuseStaleWrite("pi-compaction-check", "write", undefined, {
				path: "/compaction-proof.txt",
			}) === null
		);
	}
	async staleReadEvidenceFixture() {
		return JSON.stringify(
			refuseStaleWrite("pi-compaction-check", "write", undefined, {
				path: "/compaction-proof.txt",
			}),
		);
	}

	async compactFixture() {
		const context = {
			abortSignal: undefined,
			value: () => undefined,
			toString: () => "native-compaction-fixture",
		};
		const conversation = await this.nativeConversation();
		const task = await conversation.compact(undefined, context);
		return JSON.stringify(
			await (await this.piHarness.pi()).waitForTask(task, context),
		);
	}
	async seedCompactionEntries(count = 32, offset = 0) {
		const context = {
			abortSignal: undefined,
			value: () => undefined,
			toString: () => "native-compaction-seed",
		};
		const conversation = await this.nativeConversation();
		for (let index = offset; index < offset + count; index++) {
			const submitted = await conversation.submit(
				{
					type: "write",
					requestId: `seed:${index}`,
					entry: {
						kind: "fixture.history",
						model: [
							{
								role: "user",
								content: `retained-row-${index}:` + "x".repeat(4000),
								timestamp: index,
							},
						],
					},
				},
				context,
			);
			await submitted.wait(context);
		}
	}
	async summaryFixture() {
		return JSON.stringify(await this.ctx.storage.get("fixture:summary-input"));
	}
	async headFixture() {
		return JSON.stringify(await this.ctx.storage.get("pi-protected-head:v1"));
	}
	async failureMessages() {
		const context = {
			abortSignal: undefined,
			value: () => undefined,
			toString: () => "debug",
		};
		return JSON.stringify(
			(await (await this.nativeConversation()).context(context)).messages
				.filter((message) => message.role === "assistant")
				.map((message) => ({
					stopReason: message.stopReason,
					error: message.errorMessage,
				})),
		);
	}
	async legacyHistoryJson() {
		return JSON.stringify(await this.historyMessages());
	}
	// Literal pinned SDK DDL: setup precedes the measured passive preservation window.
	async seedSdkPreservation() {
		this.ctx.storage.sql.exec(
			"\n        CREATE TABLE IF NOT EXISTS cf_agents_fibers (\n          fiber_id TEXT PRIMARY KEY,\n          idempotency_key TEXT UNIQUE,\n          name TEXT NOT NULL,\n          status TEXT NOT NULL,\n          snapshot TEXT,\n          metadata_json TEXT,\n          error_message TEXT,\n          created_at INTEGER NOT NULL,\n          started_at INTEGER,\n          completed_at INTEGER\n        )\n      ",
		);
		this.ctx.storage.sql.exec(
			"\n        CREATE TABLE IF NOT EXISTS cf_agents_workflows (\n          id TEXT PRIMARY KEY NOT NULL,\n          workflow_id TEXT NOT NULL UNIQUE,\n          workflow_name TEXT NOT NULL,\n          status TEXT NOT NULL CHECK(status IN (\n            'queued', 'running', 'paused', 'errored',\n            'terminated', 'complete', 'waiting',\n            'waitingForPause', 'unknown'\n          )),\n          metadata TEXT,\n          error_name TEXT,\n          error_message TEXT,\n          created_at INTEGER NOT NULL DEFAULT (unixepoch()),\n          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),\n          completed_at INTEGER\n        )\n      ",
		);
		this.ctx.storage.sql.exec(
			"\n      CREATE TABLE IF NOT EXISTS cf_agents_context_blocks (\n        label TEXT PRIMARY KEY,\n        content TEXT NOT NULL,\n        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP\n      )\n    ",
		);
		this.ctx.storage.sql.exec(
			"\n      CREATE TABLE IF NOT EXISTS cf_agents_chat_progress (\n        key TEXT PRIMARY KEY,\n        retired INTEGER NOT NULL,\n        legacy INTEGER NOT NULL DEFAULT 0\n      ) WITHOUT ROWID\n    ",
		);
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS cf_agents_routed_agents (\n      route TEXT NOT NULL,\n      id TEXT NOT NULL,\n      agent_name TEXT NOT NULL,\n      status TEXT NOT NULL CHECK (status IN ('active', 'deleting')),\n      metadata TEXT NOT NULL,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL,\n      seq INTEGER NOT NULL DEFAULT 0,\n      PRIMARY KEY (route, id)\n    ) WITHOUT ROWID",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_fibers(fiber_id,name,status,snapshot,metadata_json,created_at) VALUES('retained','original','waiting','PRIVATE_FIBER','PRIVATE_METADATA',1)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status,metadata) VALUES('retained','original-provider-id','original','waiting','PRIVATE_WORKFLOW')",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_context_blocks(label,content) VALUES('original','PRIVATE_CONTEXT')",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_chat_progress VALUES('chat',3,2)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_routed_agents(route,id,agent_name,metadata,status,seq,created_at,updated_at) VALUES('original','retained','unwoken-original','PRIVATE_ROUTE','deleting',1,1,1)",
		);
		// Retained queue schema fields are consumed by the pinned SDK migration reader; capture must not invoke it.
		this.ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_queues(id TEXT PRIMARY KEY,callback TEXT,payload TEXT,retry_options TEXT,created_at INTEGER)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_queues VALUES('retained','callback','PRIVATE_QUEUE','PRIVATE_RETRY',1)",
		);

		this.ctx.storage.sql.exec(
			"\n      CREATE TABLE IF NOT EXISTS cf_agents_jobs (\n        id TEXT PRIMARY KEY NOT NULL,\n        capability TEXT NOT NULL,\n        fn TEXT NOT NULL,\n        time INTEGER NOT NULL,\n        payload TEXT,\n        retry_options TEXT,\n        singleflight INTEGER NOT NULL DEFAULT 0,\n        hung_timeout_seconds INTEGER,\n        exclusive INTEGER NOT NULL DEFAULT 0,\n        recovery_loop INTEGER NOT NULL DEFAULT 0,\n        running INTEGER NOT NULL DEFAULT 0,\n        execution_started_at INTEGER,\n        created_at INTEGER NOT NULL DEFAULT (unixepoch())\n      ) WITHOUT ROWID",
		);
		this.ctx.storage.sql.exec(
			"\n      CREATE TABLE IF NOT EXISTS cf_agents_task_runs (\n        run_id TEXT PRIMARY KEY,\n        definition TEXT NOT NULL,\n        input TEXT,\n        state TEXT NOT NULL CHECK (state IN (\n          'pending', 'running', 'waiting',\n          'completed', 'failed', 'cancelled'\n        )),\n        result TEXT,\n        error_name TEXT,\n        error_message TEXT,\n        status_message TEXT,\n        metadata TEXT,\n        idempotency_key TEXT UNIQUE,\n        retain INTEGER NOT NULL DEFAULT 1,\n        attempt INTEGER NOT NULL DEFAULT 0,\n        generation TEXT,\n        next_at INTEGER,\n        wait_reason TEXT,\n        cancel_requested INTEGER NOT NULL DEFAULT 0,\n        cancel_reason TEXT,\n        created_at INTEGER NOT NULL,\n        started_at INTEGER,\n        updated_at INTEGER NOT NULL,\n        settled_at INTEGER\n      ) WITHOUT ROWID",
		);
		this.ctx.storage.sql.exec(
			"\n      CREATE TABLE IF NOT EXISTS cf_agents_task_steps (\n        run_id TEXT NOT NULL,\n        step_name TEXT NOT NULL,\n        kind TEXT NOT NULL CHECK (kind IN ('do', 'sleep')),\n        state TEXT NOT NULL CHECK (state IN (\n          'running', 'waiting', 'completed', 'failed'\n        )),\n        result TEXT,\n        error_name TEXT,\n        error_message TEXT,\n        attempt INTEGER NOT NULL DEFAULT 0,\n        next_at INTEGER,\n        created_at INTEGER NOT NULL,\n        started_at INTEGER,\n        updated_at INTEGER NOT NULL,\n        completed_at INTEGER,\n        PRIMARY KEY (run_id, step_name)\n      ) WITHOUT ROWID",
		);
		this.ctx.storage.sql.exec(
			"\n      CREATE TABLE IF NOT EXISTS cf_agents_streams (\n        stream_id TEXT PRIMARY KEY,\n        state TEXT NOT NULL CHECK (state IN (\n          'streaming', 'completed', 'errored'\n        )),\n        tag TEXT,\n        metadata TEXT,\n        error_message TEXT,\n        chunk_count INTEGER NOT NULL DEFAULT 0,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        closed_at INTEGER\n      )",
		);
		this.ctx.storage.sql.exec(
			"\n      CREATE TABLE IF NOT EXISTS cf_agents_stream_blocks (\n        stream_id TEXT NOT NULL,\n        block INTEGER NOT NULL,\n        seq_from INTEGER NOT NULL,\n        seq_to INTEGER NOT NULL,\n        body TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        PRIMARY KEY (stream_id, block)\n      ) WITHOUT ROWID",
		);
		this.ctx.storage.sql.exec(
			"\n    CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (\n      id TEXT PRIMARY KEY NOT NULL,\n      name TEXT NOT NULL,\n      server_url TEXT NOT NULL,\n      callback_url TEXT NOT NULL,\n      client_id TEXT,\n      auth_url TEXT,\n      server_options TEXT\n    )\n  ",
		);

		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_jobs(id,capability,fn,time,payload,retry_options,running,recovery_loop,exclusive,hung_timeout_seconds) VALUES('retained','fixture','callback',1,?, ?,1,1,1,60)",
			JSON.stringify({ token: "PRIVATE_JOB" }),
			JSON.stringify({ maxAttempts: 3 }),
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_task_runs(run_id,definition,state,idempotency_key,generation,created_at,updated_at) VALUES('retained','fixture','waiting','original-idempotency','original-generation',1,1)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_task_steps(run_id,step_name,kind,state,created_at,updated_at,result) VALUES('retained','step','do','completed',1,1,?)",
			"PRIVATE_STEP",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_streams(stream_id,state,error_message,created_at,updated_at) VALUES('retained','errored','PRIVATE_ERROR',1,1)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_stream_blocks VALUES('retained',0,0,1,?,1,1)",
			"PRIVATE_STREAM" + "🌒".repeat(350000),
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_mcp_servers(id,name,server_url,callback_url,server_options) VALUES('retained','original','https://example.invalid','https://example.invalid/callback',?)",
			JSON.stringify({ headers: { Authorization: "PRIVATE_TOKEN" } }),
		);
		for (let i = 0; i < 4; i++)
			this.ctx.storage.kv.put("/oauth/client/server/" + i, {
				private: "PRIVATE_OAUTH",
				data: new Uint8Array(250000).fill(i),
			});
		this.ctx.storage.kv.put("future-undefined", undefined);
		return { selectedRows: 6 };
	}

	async seedSessionPreservation(bulk = true) {
		const { TediSessionRepo } =
			await import("@tedix/tedi-session/session-repo");
		const repo = new TediSessionRepo({
			sql: <T>(
				strings: TemplateStringsArray,
				...values: (string | number | boolean | null)[]
			) =>
				this.ctx.storage.sql
					.exec(
						strings.join("?"),
						...values.map((v) => (typeof v === "boolean" ? Number(v) : v)),
					)
					.toArray() as T[],
			readDurable: async () => ({ entries: [], compaction: null }),
		});
		repo.appendTurn(
			{
				sessionKey: "retained",
				role: "user",
				content: "PRIVATE_ROOT_CONTEXT",
				ts: 1,
			},
			"original:1",
		);
		repo.appendTurn(
			{
				sessionKey: "retained",
				role: "assistant",
				content: "PRIVATE_MODEL_CONTEXT",
				ts: 2,
				modelIdentity: { provider: "fixture", model: "original-model" },
			},
			"original:2",
		);
		for (let i = 0; bulk && i < 8; i++)
			repo.appendTurn(
				{
					sessionKey: "bulk",
					role: "user",
					content: "PRIVATE_BULK" + "x".repeat(1000000),
					ts: 100 + i,
				},
				"bulk:" + i,
			);
		const branch = repo.getBranch("retained");
		repo.appendCompaction("retained", {
			summary: "PRIVATE_COMPACTION",
			firstKeptEntryId: branch[1]!.id,
			tokensBefore: 100,
		});
		if (!bulk)
			this.ctx.storage.sql.exec(
				"UPDATE session_entries SET ts=3 WHERE session_key='retained' AND type='compaction'",
			);
		const session = this.legacySessions.session("preservation");
		await session.importMessage(
			{
				id: "root",
				role: "user",
				parts: [{ type: "text", text: "PRIVATE_RETAINED_ROOT" }],
			},
			{ parentId: null, createdAt: 1 },
		);
		await session.importMessage(
			{
				id: "inactive",
				role: "assistant",
				parts: [
					{ type: "text", text: "PRIVATE_INACTIVE_BRANCH" },
					...(!bulk
						? [
								{ type: "reasoning", text: "PRIVATE_REASONING" },
								{
									type: "dynamic-tool",
									toolCallId: "original-owned-tool",
									toolName: "legacy_read",
									input: { path: "PRIVATE_PATH" },
									state: "output-available",
									output: { result: "PRIVATE_RESULT" },
								},
							]
						: []),
				],
			},
			{ parentId: "root", createdAt: 2 },
		);
		await session.importMessage(
			{
				id: "active",
				role: "assistant",
				parts: [{ type: "text", text: "PRIVATE_ACTIVE_BRANCH" }],
			},
			{ parentId: "root", createdAt: 3 },
		);
		const originalCompact = await session.addCompaction(
			"PRIVATE_LEGACY_COMPACTION",
			"root",
			"active",
		);
		if (!bulk)
			await session.importMessage(
				{
					id: `compaction_${originalCompact.id}`,
					role: "assistant",
					parts: [{ type: "text", text: "PRIVATE_HIDDEN" }],
				},
				{ parentId: "active", createdAt: 4 },
			);
		await session.appendMessage({
			id: "attachment",
			role: "user",
			parts: [
				{
					type: "file",
					mediaType: "application/octet-stream",
					url:
						"data:application/octet-stream;base64," +
						Buffer.alloc(bulk ? 1200000 : 1700000, 251).toString("base64"),
				},
			],
		});
		let newestCompact:
			| Awaited<ReturnType<typeof session.addCompaction>>
			| undefined;
		if (!bulk)
			newestCompact = await session.addCompaction(
				"PRIVATE_NEWEST_OVERLAY",
				"root",
				"attachment",
			);
		await session.appendMessage({
			id: "large",
			role: "user",
			parts: [
				{
					type: "text",
					text: "PRIVATE_CHUNK" + "x".repeat(bulk ? 1100000 : 1700000),
				},
			],
		});

		// A terminal hidden sibling must not manufacture a third branch. The
		// SDK's latest visible row falls back to its original visible parent.
		if (newestCompact)
			await session.importMessage(
				{
					id: `compaction_${newestCompact.id}`,
					role: "assistant",
					parts: [{ type: "text", text: "PRIVATE_TERMINAL_HIDDEN" }],
				},
				{ parentId: "root", createdAt: 5 },
			);

		const golden: Record<string, unknown[]> = {};
		for (const leafId of ["inactive", "large"]) {
			golden[leafId] = [];
			for await (const message of session.history({ leafId }))
				golden[leafId]!.push(message);
		}
		return {
			rootEntries: repo.getBranch("retained").length,
			golden: JSON.stringify(golden),
			latestVisibleId: (await session.getLatestLeaf())?.id ?? null,
			branches: (await session.getBranches("root")).map((m) => m.id),
		};
	}

	async seedLegacyHistory() {
		this.setState({
			...this.state,
			aigMetadata: {
				source: "fixture",
				orgId: "fixture-org",
				tediId: "fixture-tedi",
			},
		});
		const body = JSON.stringify({
			kind: "base64",
			data: "aGVsbG8=",
			mediaType: "image/png",
			fileName: "private.png",
		});
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(body),
		);
		const sha = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const key = `__runtime/workflow-images/fixture-tedi/legacy-run/${sha}.json`;
		await this.env.TEDI_STORAGE.put(key, body);
		const privateUrl = `tedix-r2://workflow-image/${encodeURIComponent(key)}?sha256=${sha}`;
		await this.legacySessions.session().appendMessage({
			id: "legacy-user",
			role: "user",
			parts: [
				{ type: "text", text: "retained legacy context" },
				{
					type: "file",
					mediaType: "image/png",
					url: "https://images.example.test/original.png",
				},
				{
					type: "file",
					mediaType: "image/png",
					filename: "private.png",
					url: privateUrl,
				},
			],
		});
		await this.legacySessions.session().appendMessage({
			id: "legacy-answer",
			role: "assistant",
			parts: [
				{ type: "text", text: "retained legacy answer" },
				{
					type: "dynamic-tool",
					toolCallId: "legacy-owned-tool",
					toolName: "legacy_read",
					input: { path: "/kept" },
					state: "output-available",
					output: { ok: true },
				},
			],
		});
	}
	async seedLegacyPending() {
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS cf_think_submissions(submission_id TEXT PRIMARY KEY,status TEXT,result_status TEXT)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_think_submissions(submission_id,status,result_status) VALUES(?,?,?)",
			"legacy-pending",
			"running",
			null,
		);
	}
	async setup(mode: ConversationStats["mode"]) {
		await this.ctx.storage.put("fixture:stats", {
			...(await this.stats()),
			mode,
		});
	}
	async recoveryFixture() {
		return JSON.stringify({
			budgets: Array.from(
				(
					await this.ctx.storage.list({ prefix: "pi-cold-resume-budget:v1:" })
				).values(),
			),
			blocked: this.state.recoveryBlockedRunId ?? null,
		});
	}
	async inspectFixture() {
		return JSON.stringify({
			stats: await this.stats(),
			state: this.state,
			pending:
				(await this.ctx.storage.get("pi-facet-pending-submission")) ?? null,
		});
	}
	configuration(
		runId: string,
		approval = false,
		maxSteps: number | null = null,
	): ConversationTurnConfiguration {
		return {
			system: "Fixture system",
			modelRef: null,
			adaptiveRouting: null,
			aigMetadata: {
				source: "fixture",
				orgId: "fixture-org",
				tediId: "fixture-tedi",
			},
			sessionKey: "fixture-session",
			runId,
			maxSteps,
			toolDescriptors:
				approval || this.state.toolDescriptors.length > 0
					? [
							{
								name: "fixture_effect",
								description: "Durable test effect",
								inputSchema: {
									type: "object",
									properties: {},
									additionalProperties: false,
								},
								needsApproval: approval,
							},
						]
					: [],
		};
	}
	async turn(
		id: string,
		input: {
			approval?: boolean;
			maxSteps?: number;
			freshHistory?: boolean;
		} = {},
	) {
		return this.runConfiguredConversationTurn({
			text: `input ${id}`,
			durableSubmissionId: id,
			freshHistory: input.freshHistory,
			configuration: this.configuration(
				id,
				input.approval,
				input.maxSteps ?? null,
			),
		});
	}
	async streamTurn(id: string, approval = false) {
		return this.streamConfiguredConversationTurn({
			text: `input ${id}`,
			durableSubmissionId: id,
			configuration: this.configuration(id, approval),
		});
	}
	async regenerate(originalId: string, newId: string) {
		return this.runConfiguredConversationTurn({
			text: `input ${originalId}`,
			durableSubmissionId: newId,
			regenerationOf: originalId,
			originalUiMessage: {
				id: `ui:${originalId}`,
				role: "user",
				parts: [{ type: "text", text: `authored ${originalId}` }],
			},
			configuration: this.configuration(newId),
		});
	}
	async enableFacetTool() {
		this.setState({
			...this.state,
			toolDescriptors: [
				{
					name: "fixture_effect",
					description: "Durable test effect",
					inputSchema: {
						type: "object",
						properties: {},
						additionalProperties: false,
					},
				},
			],
		});
	}
	async cancelFixture() {
		await this.ctx.storage.put("fixture:stats", {
			...(await this.stats()),
			cancelled: true,
		});
		await this.cancelPiTurn();
	}
}

import {
	JudgeSessionFacet,
	type JudgeParentPort,
} from "../../src/judge-session-facet";
import {
	SynthesisSessionFacet,
	type SynthesisParentPort,
} from "../../src/synthesis-session-facet";
export interface ToolFreeStats {
	requests: number;
	reservations: string[];
	receipts: string[];
	toolChoices: unknown[];
	tools: unknown[];
	prompts: unknown[];
}
async function toolFreeStats(
	storage: DurableObjectStorage,
): Promise<ToolFreeStats> {
	return (
		(await storage.get<ToolFreeStats>("tool-free:stats")) ?? {
			requests: 0,
			reservations: [],
			receipts: [],
			toolChoices: [],
			tools: [],
			prompts: [],
		}
	);
}
const toolFreeLimits = {
	dailyMessageLimit: -1,
	dailyTokenLimit: -1,
	operatorMessageReserve: 0,
	operatorTokenReserve: 0,
	governedLearningMessageReserve: 0,
	governedLearningTokenReserve: 0,
};
function toolFreeParent(
	storage: DurableObjectStorage,
	budget: DoInferenceBudgetStore,
): JudgeParentPort {
	return {
		assertChatTurnActive: async (runId) => {
			if (await storage.get("tool-free:cancel:" + runId))
				throw new Error("tool-free authority cancelled");
			if (!runId) throw new Error("tool-free run missing");
			budget.admit(runId, toolFreeLimits, 1);
		},
		reservePiStep: async (input) => {
			const stats = await toolFreeStats(storage);
			if (!stats.reservations.includes(input.stepId))
				stats.reservations.push(input.stepId);
			await storage.put("tool-free:stats", stats);
			return budget.reserveStep(
				input.runId,
				input.stepId,
				input.estimatedTokens,
				toolFreeLimits,
			);
		},
		recordPiStep: async (input) => {
			const stats = await toolFreeStats(storage);
			if (!stats.receipts.includes(input.stepId))
				stats.receipts.push(input.stepId);
			await storage.put("tool-free:stats", stats);
			return budget.recordStep(
				input.runId,
				input.stepId,
				input.actualTokens,
				toolFreeLimits,
			);
		},
	};
}
function toolFreeModel(
	storage: DurableObjectStorage,
	modelId: string,
): LanguageModelV3 {
	return {
		specificationVersion: "v3",
		provider: "fixture",
		modelId,
		supportedUrls: {},
		doGenerate: async () => {
			throw new Error("stream only");
		},
		doStream: async (options) => {
			const stats = await toolFreeStats(storage);
			stats.requests++;
			stats.toolChoices.push(options.toolChoice ?? null);
			stats.tools.push(options.tools ?? null);
			stats.prompts.push(JSON.parse(JSON.stringify(options.prompt)) as unknown);
			await storage.put("tool-free:stats", stats);
			const latest = options.prompt
				.filter((message) => message.role === "user")
				.at(-1);
			const input =
				latest && typeof latest.content !== "string"
					? latest.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("")
					: "";
			return {
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						controller.enqueue({
							type: "response-metadata",
							id: "response:" + input,
						});
						controller.enqueue({ type: "text-start", id: "answer" });
						controller.enqueue({
							type: "text-delta",
							id: "answer",
							delta: modelId + ":" + input,
						});
						controller.enqueue({ type: "text-end", id: "answer" });
						controller.enqueue({
							type: "finish",
							finishReason: { unified: "stop", raw: "stop" },
							usage: {
								inputTokens: {
									total: 3,
									noCache: 3,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 2, text: 2, reasoning: 0 },
							},
						});
						controller.close();
					},
				}),
			};
		},
	};
}
export class PiJudgeFixture extends JudgeSessionFacet {
	protected override async facetAdmissionCustody(
		_runId: string,
		_sessionKey: string,
	): Promise<import("../../src/pi-agent").FacetAdmissionResponse> {
		return { enabled: false as const };
	}
	protected async parent(): Promise<JudgeParentPort> {
		return toolFreeParent(this.ctx.storage, new DoInferenceBudgetStore(this));
	}
	protected selected() {
		return {
			model: toolFreeModel(this.ctx.storage, "judge-model"),
			identity: { provider: "workers-ai" as const, model: "@cf/judge-model" },
		};
	}
	async turn(runId: string, text = runId) {
		await this.configureJudgeTurn({
			runId,
			sessionKey: "fixture",
			system: "Blind judge fixture",
			aigMetadata: { orgId: "tool-free-org", tediId: "tool-free-tedi" },
		});
		return await this.runJudgeTurn({ text });
	}
	async alteredInput(runId: string, text: string) {
		try {
			await this.turn(runId, text);
			return "unexpected success";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
	async inspectToolFree() {
		const conversation = await this.nativeConversation();
		return JSON.stringify({
			stats: await toolFreeStats(this.ctx.storage),
			conversationId: conversation.id,
			history: await this.historyMessages(),
		});
	}
}
export class PiSynthesisFixture extends SynthesisSessionFacet {
	protected override async facetAdmissionCustody(
		_runId: string,
		_sessionKey: string,
	): Promise<import("../../src/pi-agent").FacetAdmissionResponse> {
		return { enabled: false as const };
	}
	protected async parent(): Promise<SynthesisParentPort> {
		return toolFreeParent(this.ctx.storage, new DoInferenceBudgetStore(this));
	}
	protected selected() {
		return {
			model: toolFreeModel(this.ctx.storage, "synthesis-model"),
			identity: {
				provider: "workers-ai" as const,
				model: "@cf/synthesis-model",
			},
		};
	}
	async turn(runId: string, text = runId) {
		await this.configureSynthesisTurn({
			runId,
			sessionKey: "fixture",
			system: "Tool-free synthesis fixture",
			modelRef: "workers-ai/@cf/synthesis-model",
			aigMetadata: { orgId: "tool-free-org", tediId: "tool-free-tedi" },
		});
		return await this.runSynthesisTurn({ text });
	}
	async alteredInput(runId: string, text: string) {
		try {
			await this.turn(runId, text);
			return "unexpected success";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
	async inspectToolFree() {
		const conversation = await this.nativeConversation();
		return JSON.stringify({
			stats: await toolFreeStats(this.ctx.storage),
			conversationId: conversation.id,
			history: await this.historyMessages(),
		});
	}
}

import {
	RuntimeAdmissionDO,
	readStoredRuntimeAdmission,
} from "../../src/runtime-admission-do";
import type { FacetAdmissionResponse } from "../../src/pi-agent";
export class ConversationFacet extends PiConversationFixture {
	protected override selectModelForTurn() {
		const selected = super.selectModelForTurn();
		const stream = selected.model.doStream.bind(selected.model);
		return {
			...selected,
			model: {
				...selected.model,
				doStream: async (options: Parameters<typeof stream>[0]) => {
					const guard = this.facetBeforeDispatch();
					const origin = readPrivateInferenceOrigin(guard);
					this.ctx.storage.kv.put("fixture:private-origin", origin);
					const mutation = this.ctx.storage.kv.get<string>(
						"fixture:origin-mutation",
					);
					const originalState = structuredClone(this.state);
					const keys = ["pi-admitted-operation:v1", "cf_agents_facet_name"];
					const originals = keys.map(
						(key) => [key, this.ctx.storage.kv.get(key)] as const,
					);
					const originalAdmission = this.ctx.storage.sql
						.exec<{ record: string }>(
							"SELECT record FROM runtime_admission WHERE id=1",
						)
						.toArray()[0]?.record;
					const originalInput =
						origin?.kind === "accepted_native"
							? this.ctx.storage.sql
									.exec<{ input: string }>(
										"SELECT input FROM runtime_admission_identities WHERE run_id=?",
										origin.selected.accepted.runId,
									)
									.toArray()[0]?.input
							: undefined;
					if (mutation === "configuration")
						this.setState({ ...this.state, system: "changed after capture" });
					if (mutation === "journal")
						this.ctx.storage.kv.put("pi-admitted-operation:v1", {
							runId: "changed",
							operationId: "changed",
							sessionKey: "changed",
						});
					if (mutation === "input" && origin?.kind === "accepted_native")
						this.ctx.storage.sql.exec(
							"UPDATE runtime_admission_identities SET input=? WHERE run_id=?",
							"{}",
							origin.selected.accepted.runId,
						);
					if (mutation === "path")
						this.ctx.storage.kv.put("cf_agents_facet_name", "changed");
					if (mutation === "owner")
						this.setState({
							...this.state,
							aigMetadata: { orgId: "changed", tediId: "changed" },
						});
					if (mutation === "generation" && originalAdmission)
						this.ctx.storage.sql.exec(
							"UPDATE runtime_admission SET record=? WHERE id=1",
							JSON.stringify({
								...JSON.parse(originalAdmission),
								generation: 99,
							}),
						);
					if (mutation) {
						try {
							assertProviderDispatchReady(guard);
							this.ctx.storage.kv.put("fixture:origin-denial", {
								denied: false,
							});
						} catch (error) {
							const failure = error as {
								name: string;
								phase: string;
								providerRequestSent: boolean;
							};
							this.ctx.storage.kv.put("fixture:origin-denial", {
								denied: true,
								name: failure.name,
								phase: failure.phase,
								providerRequestSent: failure.providerRequestSent,
								scriptedSendsBefore: 0,
							});
						}
						this.setState(originalState);
						if (originalAdmission)
							this.ctx.storage.sql.exec(
								"UPDATE runtime_admission SET record=? WHERE id=1",
								originalAdmission,
							);
						for (const [key, value] of originals) {
							if (value === undefined) this.ctx.storage.kv.delete(key);
							else this.ctx.storage.kv.put(key, value);
						}
						if (
							originalInput !== undefined &&
							origin?.kind === "accepted_native"
						)
							this.ctx.storage.sql.exec(
								"UPDATE runtime_admission_identities SET input=? WHERE run_id=?",
								originalInput,
								origin.selected.accepted.runId,
							);
					}
					assertProviderDispatchReady(guard);
					return stream(options);
				},
			},
		};
	}
	async setOriginMutation(mutation: string) {
		this.ctx.storage.kv.put("fixture:origin-mutation", mutation);
	}
	async privateOriginProbe() {
		return {
			origin: this.ctx.storage.kv.get<RuntimeInferenceOrigin>(
				"fixture:private-origin",
			),
			denial: this.ctx.storage.kv.get("fixture:origin-denial"),
			stats: JSON.parse(await this.inspectFixture()).stats,
		};
	}

	async scheduleNativeTurn(runId: string, time: number) {
		await this.lifecycle.jobs.push({
			id: "wake-turn",
			fn: "wake-turn",
			time,
			payload: { runId },
		});
	}
	async scheduleNativeProbe(time: number) {
		await this.lifecycle.jobs.push({
			id: "wake-probe",
			fn: "wake-probe",
			time,
			payload: {},
		});
	}
	async onJob({ job }: import("agents/lifecycle").LifecycleJobContext) {
		if (job.fn === "wake-probe") {
			await this.pendingToolApprovals();
			await this.ctx.storage.put("native-approval-wake", true);
			return;
		}
		if (job.fn === "wake-witness") {
			await this.ctx.storage.put("native-followup-witness", job.id);
			return;
		}
		if (job.fn !== "wake-turn") return super.onJob({ job, attempt: 1 });
		await this.turn((job.payload as { runId: string }).runId);
		await this.lifecycle.jobs.push({
			id: "wake-followup",
			fn: "wake-witness",
			time: Date.now() + 60000,
			payload: {},
		});
		await this.ctx.storage.put("native-wake-witness", job.id);
	}
	protected override async facetAdmissionCustody(
		runId: string,
		sessionKey: string,
	): Promise<FacetAdmissionResponse> {
		const parent = (await Agent.prototype.parentAgent.call(
			this,
			PiAdmissionParentFixture,
		)) as unknown as PiAdmissionParentFixture;
		return parent.getFacetAdmissionCustody({
			className: "ConversationFacet",
			name: this.ctx.storage.kv.get<string>("cf_agents_facet_name")!,
			objectId: this.ctx.id.toString(),
			runId,
			sessionKey,
		});
	}
	async quarantineAdmission() {
		const adapter = new RuntimeAdmissionDO(this.ctx.storage, {
			tediId: "fixture-tedi",
			orgId: "fixture-org",
			objectId: this.ctx.id.toString(),
		});
		adapter.gate.quarantine({
			operationId: crypto.randomUUID(),
			expectedGeneration: adapter.read()!.generation,
			reason: "native fixture fence",
		});
	}
}
export class PiAdmissionParentFixture extends Agent {
	protected override async onBeforeFacetLifecycleAlarm() {
		if (this.admission().read()?.state !== "active")
			throw new Error("fixture root alarm admission denied");
	}
	private existingChild() {
		const row = this.ctx.storage.sql
			.exec<{ identity_name: string }>(
				"SELECT identity_name FROM cf_agents_sub_agents WHERE class='ConversationFacet' AND name='admitted'",
			)
			.toArray()[0];
		if (!row) throw new Error("missing existing child");
		const exports = this.ctx.exports as unknown as {
			ConversationFacet: DurableObjectClass;
			PiAdmissionParentFixture: DurableObjectNamespace;
		};
		return this.ctx.facets.get<ConversationFacet>(
			"ConversationFacet\0admitted",
			() => ({
				class: exports.ConversationFacet,
				id: exports.PiAdmissionParentFixture.idFromName(row.identity_name),
			}),
		);
	}
	async beginNativeApproval(runId: string) {
		await this.admission().beginAcceptedTurn({
			runId,
			sessionKey: "fixture-session",
			principalId: "fixture-principal",
			input: { text: `input ${runId}` },
			expectedGeneration: this.admission().read()!.generation,
		});
		const child = this.existingChild();
		await child.setup("tool");
		this.ctx.waitUntil(
			child
				.turn(runId, { approval: true })
				.then(async () => {
					await this.ctx.storage.put("native-approval-finished", true);
				})
				.catch(async (error: unknown) => {
					await this.ctx.storage.put(
						"native-approval-interrupted",
						String(error),
					);
				}),
		);
	}
	async nativeApprovals() {
		return this.existingChild().pendingToolApprovals();
	}
	async approveNative(approvalId: string) {
		return this.existingChild().resolveToolApproval({
			approvalId,
			approved: true,
		});
	}
	async scheduleNativeProbe(time: number) {
		await this.existingChild().scheduleNativeProbe(time);
		return this.alarmAddress();
	}
	async scheduleNativeTurn(runId: string, time: number) {
		await this.admission().beginAcceptedTurn({
			runId,
			sessionKey: "fixture-session",
			principalId: "fixture-principal",
			input: { text: `input ${runId}` },
			expectedGeneration: this.admission().read()!.generation,
		});
		await this.existingChild().scheduleNativeTurn(runId, time);
		return this.alarmAddress();
	}
	async alarmAddress() {
		const row = this.ctx.storage.sql
			.exec<{ identity_name: string }>(
				"SELECT identity_name FROM cf_agents_sub_agents WHERE class='ConversationFacet' AND name='admitted'",
			)
			.toArray()[0];
		if (!row) throw new Error("missing existing child");
		return {
			ownerPath: [
				...this.selfPath,
				{ className: "ConversationFacet", name: "admitted" },
			],
			identityName: row.identity_name,
		};
	}
	private admission() {
		return new RuntimeAdmissionDO(this.ctx.storage, {
			tediId: "fixture-tedi",
			orgId: "fixture-org",
			objectId: this.ctx.id.toString(),
		});
	}
	async admittedTurn(runId: string) {
		const adapter = this.admission();
		if (!adapter.read()) {
			this.setState({ tediId: "fixture-tedi", orgId: "fixture-org" });
			adapter.gate.initialize({
				operationId: "fixture-bootstrap",
				state: "active",
				evidence: await adapter.prepareEvidence("initialize"),
			});
		}
		await adapter.beginAcceptedTurn({
			runId,
			sessionKey: "fixture-session",
			principalId: "fixture-principal",
			input: { text: `input ${runId}` },
			expectedGeneration: adapter.read()!.generation,
		});
		return (await this.dynamicAgents.get(ConversationFacet, "admitted")).turn(
			runId,
		);
	}
	async setOriginMutation(mutation: string) {
		await (
			await this.dynamicAgents.get(ConversationFacet, "admitted")
		).setOriginMutation(mutation);
	}
	async privateOriginProbe() {
		return this.existingChild().privateOriginProbe();
	}
	async admittedInspect() {
		return this.existingChild().inspectFixture();
	}
	async quarantineChild() {
		return (
			await this.dynamicAgents.get(ConversationFacet, "admitted")
		).quarantineAdmission();
	}
	async quarantineParent() {
		const a = this.admission();
		a.gate.quarantine({
			operationId: crypto.randomUUID(),
			expectedGeneration: a.read()!.generation,
			reason: "fixture parent fence",
		});
	}
	async getFacetAdmissionCustody(input: {
		className: string;
		name: string;
		objectId: string;
		runId: string;
		sessionKey: string;
	}): Promise<FacetAdmissionResponse> {
		const adapter = this.admission();
		const accepted = await adapter.assertAcceptedTurn({
			runId: input.runId,
			sessionKey: input.sessionKey,
			principalId: "fixture-principal",
		});
		const row = this.ctx.storage.sql
			.exec<{ identity_name: string }>(
				"SELECT identity_name FROM cf_agents_sub_agents WHERE class=? AND name=?",
				input.className,
				input.name,
			)
			.toArray()[0];
		const ns = (
			this.ctx.exports as unknown as {
				PiAdmissionParentFixture: DurableObjectNamespace;
			}
		).PiAdmissionParentFixture;
		if (
			input.className !== "ConversationFacet" ||
			!row ||
			ns.idFromName(row.identity_name).toString() !== input.objectId
		)
			throw new Error("unregistered child custody");
		return {
			root: {
				owner: adapter.owner,
				objectName: this.name,
				className: "AgentTediDO",
				path: [],
				generation: accepted.generation,
				accepted,
			},
			enabled: true,
			owner: {
				tediId: "fixture-tedi",
				orgId: "fixture-org",
				objectId: input.objectId,
			},
			parentGeneration: adapter.read()!.generation,
			principalId: "fixture-principal",
			custody: {
				parentPath: [...this.selfPath],
				facetName: input.name,
				identityName: row.identity_name,
				objectId: input.objectId,
			},
		};
	}
}
