import {
	readPrivateInferenceOrigin,
	type RuntimeInferenceOrigin,
} from "../../src/runtime-inference-origin";
import { assertProviderDispatchReady } from "@tedix/workers-ai/gateway-transport";
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

import { RawCutoverDO as ProductionRawCutoverDO } from "../../src/pi-cutover-maintenance-do";
import { secureEqual } from "@tedix/worker-kit/request-auth";
export class RawCutoverDO extends ProductionRawCutoverDO {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		const db = new Proxy(env.DB, {
			get(target, key, receiver) {
				if (key !== "prepare") {
					const value = Reflect.get(target, key, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return (sql: string) => {
					const statement = env.DB.prepare(sql);
					return new Proxy(statement, {
						get(target, key, receiver) {
							if (key !== "bind") {
								const value = Reflect.get(target, key, receiver);
								return typeof value === "function" ? value.bind(target) : value;
							}
							return (...values: unknown[]) => {
								const bound = statement.bind(...values);
								return new Proxy(bound, {
									get(target, key, receiver) {
										if (key !== "first") {
											const value = Reflect.get(target, key, receiver);
											return typeof value === "function"
												? value.bind(target)
												: value;
										}
										return async () => {
											const row = await bound.first();
											const race = ctx.storage.kv.get<string>(
												"fixture:quarantine-race",
											);
											if (race) {
												ctx.storage.kv.delete("fixture:quarantine-race");
												if (race === "canonical")
													await env.DB.prepare(
														"UPDATE tedis SET isolate_agent_id='changed-at-boundary' WHERE id=?",
													)
														.bind(values[0])
														.run();
												else if (race === "tenant")
													await env.DB.prepare(
														"UPDATE tedis SET organization_id='changed-at-boundary' WHERE id=?",
													)
														.bind(values[0])
														.run();
												else if (race === "epoch") {
													const admission = readStoredRuntimeAdmission(
														ctx.storage,
														ctx.id.toString(),
													)!;
													new RuntimeAdmissionDO(
														ctx.storage,
														admission.owner,
													).gate.quarantine({
														operationId: "fixture-post-await-epoch",
														expectedGeneration: admission.generation,
														reason: "fixture",
													});
												} else if (race === "registry")
													ctx.storage.sql.exec(
														"UPDATE cf_agents_sub_agents SET identity_name='changed-at-boundary' WHERE class='Researcher'",
													);
												else
													ctx.storage.kv.put(
														"cf_agents_facet_name",
														"changed-at-boundary",
													);
											}
											return row;
										};
									},
								});
							};
						},
					});
				};
			},
		});
		super(ctx, { ...env, DB: db });
	}

	async warmQuarantineOriginal(path: string[]): Promise<number> {
		const row = this.ctx.storage.sql
			.exec<{ class: string; name: string; identity_name: string }>(
				"SELECT class,name,identity_name FROM cf_agents_sub_agents WHERE name=?",
				path[0]!,
			)
			.toArray()[0]!;
		const native = this.ctx as DurableObjectState & {
			exports: {
				RawCutoverDO: DurableObjectClass<RawCutoverDO>;
				Researcher: DurableObjectClass<Researcher>;
			};
		};
		const key = `${row.class}\0${row.name}`,
			id = this.env.TEDI_AGENT.idFromName(row.identity_name ?? row.name);
		if (path.length === 1) {
			this.ctx.facets.abort(key, "fixture warm original receiver");
			const original = this.ctx.facets.get<Researcher>(key, () => ({
				class: native.exports.Researcher,
				id,
			}));
			try {
				return await original.quarantineStartCount();
			} finally {
				(original as typeof original & { [Symbol.dispose]?: () => void })[
					Symbol.dispose
				]?.();
			}
		}
		const stub = this.ctx.facets.get<RawCutoverDO>(key, () => ({
			class: native.exports.RawCutoverDO,
			id,
		}));
		try {
			return await stub.warmQuarantineOriginal(path.slice(1));
		} finally {
			(stub as typeof stub & { [Symbol.dispose]?: () => void })[
				Symbol.dispose
			]?.();
		}
	}

	async quarantineWitness(
		path: string[],
		mutation?: { kind: string; value: unknown },
	): Promise<string> {
		if (path.length) {
			const row = this.ctx.storage.sql
				.exec<{ class: string; name: string; identity_name: string }>(
					"SELECT class,name,identity_name FROM cf_agents_sub_agents WHERE name=?",
					path[0]!,
				)
				.toArray()[0]!;
			const native = this.ctx as DurableObjectState & {
				exports: { RawCutoverDO: DurableObjectClass<RawCutoverDO> };
			};
			const stub = this.ctx.facets.get<RawCutoverDO>(
				`${row.class}\0${row.name}`,
				() => ({
					class: native.exports.RawCutoverDO,
					id: this.env.TEDI_AGENT.idFromName(row.identity_name ?? row.name),
				}),
			);
			try {
				return await stub.quarantineWitness(path.slice(1), mutation);
			} finally {
				(stub as typeof stub & { [Symbol.dispose]?: () => void })[
					Symbol.dispose
				]?.();
			}
		}
		if (mutation) {
			if (mutation.kind === "admission_state") {
				const record = readStoredRuntimeAdmission(
					this.ctx.storage,
					this.ctx.id.toString(),
				)!;
				this.ctx.storage.sql.exec(
					"UPDATE runtime_admission SET record=? WHERE id=1",
					JSON.stringify({ ...record, state: mutation.value }),
				);
			} else if (mutation.kind === "archive_corrupt")
				this.ctx.storage.sql.exec(
					"UPDATE historical_custody_parts SET chunk_hash= ? WHERE kind='source' AND part=0",
					"f".repeat(64),
				);
			else if (mutation.kind === "registry")
				this.ctx.storage.sql.exec(String(mutation.value));
			else if (mutation.kind === "registry_restore") {
				const original = mutation.value as {
					name: string;
					identityName: string;
				};
				this.ctx.storage.sql.exec(
					"UPDATE cf_agents_sub_agents SET identity_name=? WHERE name=?",
					original.identityName,
					original.name,
				);
			} else if (mutation.kind === "tenant")
				this.ctx.storage.sql.exec(
					"UPDATE cf_agents_state SET state=? WHERE id='cf_state_row_id'",
					JSON.stringify(mutation.value),
				);
			else if (mutation.kind === "epoch")
				new RuntimeAdmissionDO(
					this.ctx.storage,
					mutation.value as import("../../src/runtime-admission").AdmissionOwner,
				).gate.initialize({
					operationId: "fixture-changed-epoch",
					state: "quarantined",
					reason: "fixture",
				});
			else this.ctx.storage.kv.put(mutation.kind, mutation.value);
		}
		const selected = Object.fromEntries(
			[
				"assistant_messages",
				"assistant_compactions",
				"assistant_sessions",
				"assistant_fts",
				"cf_agents_workflows",
				"cf_agents_fibers",
				"cf_agents_sub_agents",
			].map((table) => [
				table,
				(this.ctx.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE name=?", table)
					.toArray().length
					? this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray()
					: []
				).map((row) =>
					Object.fromEntries(
						Object.entries(row).map(([key, value]) => [
							key,
							value instanceof ArrayBuffer
								? Array.from(new Uint8Array(value))
								: value,
						]),
					),
				),
			]),
		);
		const archive = [
			"historical_custody_snapshot",
			"historical_custody_parts",
			"historical_liability_refs",
			"historical_replay_seals",
		].map((table) => ({
			table,
			count: this.ctx.storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE type='table' AND name=?",
					table,
				)
				.toArray().length
				? this.ctx.storage.sql
						.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)
						.toArray()[0]!.n
				: 0,
		}));
		return JSON.stringify({
			selected,
			archive,
			accounting: this.ctx.storage.kv.get("think-accounting:original"),
			state: this.ctx.storage.sql
				.exec("SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'")
				.toArray(),
			facetName: this.ctx.storage.kv.get("cf_agents_facet_name"),
			parentPath: this.ctx.storage.kv.get("cf_agents_parent_path"),
			fact: this.ctx.storage.kv.get("quarantine-original-fact"),
			starts: this.ctx.storage.kv.get("research-starts"),
			sql: this.ctx.storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_original_facts'",
				)
				.toArray().length
				? this.ctx.storage.sql
						.exec("SELECT * FROM assistant_original_facts")
						.toArray()
				: [],
			admission: readStoredRuntimeAdmission(
				this.ctx.storage,
				this.ctx.id.toString(),
			),
		});
	}
}
const CUTOVER_TOKEN = "cutover-native-fixture-token";
async function cutoverToken(token: string) {
	if (!(await secureEqual(token, CUTOVER_TOKEN)))
		throw new Error("unauthorized");
}
export class PiCutoverOriginalFacetFixture extends Agent {
	async custodySeed(token: string) {
		await cutoverToken(token);
		await this.ctx.storage.put("custody-proof", {
			epoch: 7,
			owner: "original",
		});
		return this.custodySnapshot(token);
	}
	async custodySetAlarm(token: string, alarm: number) {
		await cutoverToken(token);
		await this.ctx.storage.setAlarm(alarm);
	}

	async custodySnapshot(token: string) {
		await cutoverToken(token);
		return {
			id: this.ctx.id.toString(),
			name: this.name,
			path: this.parentPath,
			selfPath: this.selfPath,
			witness: await this.ctx.storage.get<{ epoch: number; owner: string }>(
				"custody-proof",
			),
			kv: await this.ctx.storage.get<string>("fixture-witness"),
			starts: await this.ctx.storage.get<number>("fixture-starts"),
			parentPath: await this.ctx.storage.get<
				Array<{ className: string; name: string }>
			>("cf_agents_parent_path"),
			facetName: await this.ctx.storage.get<string>("cf_agents_facet_name"),
			sql: this.ctx.storage.sql
				.exec<{ witness: string }>(
					"SELECT witness FROM cf_agents_session_config",
				)
				.toArray(),
		};
	}

	async onStart() {
		const starts = (await this.ctx.storage.get<number>("fixture-starts")) ?? 0;
		await this.ctx.storage.put("fixture-starts", starts + 1);
	}
	async seed(token: string) {
		await cutoverToken(token);
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS cf_agents_session_config (witness TEXT)",
		);
		if (
			!this.ctx.storage.sql
				.exec("SELECT * FROM cf_agents_session_config")
				.toArray().length
		)
			this.ctx.storage.sql.exec(
				"INSERT INTO cf_agents_session_config VALUES ('preserved-sql')",
			);
		await this.ctx.storage.put("fixture-witness", "preserved-kv");
		await this.ctx.storage.put("pi-image-projection:v1:fixture", {
			tediId: "fixture",
			orgId: "fixture",
			url: "tedix-r2://workflow-image/secret",
		});
		return this.probe(token);
	}
	async probe(token: string) {
		await cutoverToken(token);
		return {
			objectId: this.ctx.id.toString(),
			starts: await this.ctx.storage.get<number>("fixture-starts"),
			kv: await this.ctx.storage.get<string>("fixture-witness"),
			sql: this.ctx.storage.sql
				.exec<{ witness: string }>(
					"SELECT witness FROM cf_agents_session_config",
				)
				.toArray(),
		};
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
			PiCutoverParentFixture,
		)) as unknown as PiCutoverParentFixture;
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
export class PiCutoverParentFixture extends Agent {
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
			PiCutoverParentFixture: DurableObjectNamespace;
		};
		return this.ctx.facets.get<ConversationFacet>(
			"ConversationFacet\0admitted",
			() => ({
				class: exports.ConversationFacet,
				id: exports.PiCutoverParentFixture.idFromName(row.identity_name),
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
				PiCutoverParentFixture: DurableObjectNamespace;
			}
		).PiCutoverParentFixture;
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

	async custodyChangeWitness(token: string) {
		await cutoverToken(token);
		await this.ctx.storage.put("custody-proof", { epoch: 7, owner: "new" });
	}

	async custodySnapshot(token: string) {
		await cutoverToken(token);
		return {
			id: this.ctx.id.toString(),
			name: this.name,
			path: this.parentPath,
			selfPath: this.selfPath,
			witness: await this.ctx.storage.get<{ epoch: number; owner: string }>(
				"custody-proof",
			),
			kv: await this.ctx.storage.get<string>("fixture-witness"),
			starts: await this.ctx.storage.get<number>("fixture-starts"),
			parentPath: await this.ctx.storage.get<
				Array<{ className: string; name: string }>
			>("cf_agents_parent_path"),
			facetName: await this.ctx.storage.get<string>("cf_agents_facet_name"),
			sql: this.ctx.storage.sql
				.exec<{ witness: string }>(
					"SELECT witness FROM cf_agents_session_config",
				)
				.toArray(),
		};
	}

	private async registered(name: string, token: string) {
		await cutoverToken(token);
		const rows = this.ctx.storage.sql
			.exec<{ identity_version: string | null; identity_name: string | null }>(
				"SELECT identity_version,identity_name FROM cf_agents_sub_agents WHERE class=? AND name=?",
				"PiCutoverOriginalFacetFixture",
				name,
			)
			.toArray();
		if (!rows.length) throw new Error("unregistered facet");
		const row = rows[0]!;
		if (row.identity_version !== "path-v2" || !row.identity_name)
			throw new Error("unknown facet identity");
		return row;
	}
	async seed(name: string, token: string) {
		await cutoverToken(token);
		return (
			await this.dynamicAgents.get(PiCutoverOriginalFacetFixture, name)
		).seed(token);
	}
	async original(name: string, token: string) {
		await this.registered(name, token);
		return (
			await this.dynamicAgents.get(PiCutoverOriginalFacetFixture, name)
		).probe(token);
	}
	async raw(
		name: string,
		token: string,
		abort: boolean,
		inventoryToken = token,
	) {
		const row = await this.registered(name, token);
		const key = `PiCutoverOriginalFacetFixture\0${name}`;
		if (abort) this.ctx.facets.abort(key, "explicit fixture maintenance");
		const stub = this.ctx.facets.get<RawCutoverDO>(key, () => ({
			class: (
				this.ctx.exports as unknown as {
					RawCutoverDO: DurableObjectClass<RawCutoverDO>;
				}
			).RawCutoverDO,
			id: (
				this.ctx.exports as unknown as {
					PiCutoverParentFixture: DurableObjectNamespace;
				}
			).PiCutoverParentFixture.idFromName(row.identity_name!),
		}));
		return JSON.stringify(await stub.inventory(inventoryToken));
	}
	async rawRejected(
		name: string,
		token: string,
		abort: boolean,
		inventoryToken = token,
	) {
		try {
			await this.raw(name, token, abort, inventoryToken);
			return "unexpected success";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
	async rawFetch(name: string, token: string, request: Request) {
		const row = await this.registered(name, token);
		const stub = this.ctx.facets.get<RawCutoverDO>(
			`PiCutoverOriginalFacetFixture\0${name}`,
			() => ({
				class: (
					this.ctx.exports as unknown as {
						RawCutoverDO: DurableObjectClass<RawCutoverDO>;
					}
				).RawCutoverDO,
				id: (
					this.ctx.exports as unknown as {
						PiCutoverParentFixture: DurableObjectNamespace;
					}
				).PiCutoverParentFixture.idFromName(row.identity_name!),
			}),
		);
		return stub.fetch(request);
	}
	async restore(name: string, token: string) {
		await this.registered(name, token);
		this.ctx.facets.abort(
			`PiCutoverOriginalFacetFixture\0${name}`,
			"explicit fixture restore",
		);
		return this.original(name, token);
	}
	async identity(name: string, token: string) {
		return this.registered(name, token);
	}
}
export class PiCutoverEarlyReturnFixture extends Agent {
	async recordPiStep(
		_input: import("../../src/pi-turn-accounting").PiStepReceipt,
	): Promise<never> {
		throw new Error("Agent receipt must not run");
	}

	// @ts-expect-error Native JavaScript permits returning another receiver before super.
	// eslint-disable-next-line constructor-super -- This proves the pre-Agent maintenance receiver.
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		// Script a storage mutation after an actual local D1 read; the Raw RPC
		// must reject it without persisting any observation or running Agent startup.
		const db = {
			prepare(sql: string) {
				const statement = env.DB.prepare(sql);
				return {
					bind(...values: unknown[]) {
						const bound = statement.bind(...values);
						return {
							async first<T>() {
								const row = await bound.first<T>();
								const race = ctx.storage.kv.get<{
									kind: string;
									owner: import("../../src/runtime-admission").AdmissionOwner;
									workflowId: string;
								}>("fixture:retained-callback-race");
								if (race) {
									if (race.kind === "epoch") {
										const { RuntimeAdmissionDO } =
											await import("../../src/runtime-admission-do");
										const gate = new RuntimeAdmissionDO(ctx.storage, race.owner)
											.gate;
										gate.quarantine({
											operationId: "fixture-race",
											expectedGeneration: gate.read()!.generation,
											reason: "fixture D1 boundary",
										});
									} else if (race.kind === "row")
										ctx.storage.sql.exec(
											"UPDATE cf_agents_workflows SET metadata='changed at boundary' WHERE workflow_id=?",
											race.workflowId,
										);
									else
										ctx.storage.sql.exec(
											"UPDATE cf_agents_state SET state=? WHERE id='cf_state_row_id'",
											JSON.stringify({ ...race.owner, orgId: "foreign" }),
										);
								}
								return row;
							},
							run: () => bound.run(),
						};
					},
				};
			},
		} as unknown as Cloudflare.Env["DB"];
		return new RawCutoverDO(ctx, {
			...env,
			DB: db,
			TEDI_AGENT: (
				env as unknown as { PI_CUTOVER_EARLY: DurableObjectNamespace }
			).PI_CUTOVER_EARLY as unknown as Cloudflare.Env["TEDI_AGENT"],
		}) as unknown as PiCutoverEarlyReturnFixture;
	}
	async inventory(_token: string): Promise<never> {
		throw new Error("Agent inventory must not run");
	}
	async onStart() {
		throw new Error("Agent lifecycle must not start");
	}
}

// Local fixtures keep exact SDK custody names. No production activation or model calls.
import { TelegramStateAgent } from "../../src/pi-parent-services";
import {
	operateStoredCutover,
	type PassiveCutoverInspection,
} from "../../src/pi-cutover-admin";
export class ThinkMessengerStateAgent extends TelegramStateAgent {
	async inspectionWitness() {
		return JSON.stringify({
			kv: [...(await this.ctx.storage.list())],
			alarm: await this.ctx.storage.getAlarm(),
			sql: this.ctx.storage.sql
				.exec("SELECT * FROM chat_sdk_state_cache")
				.toArray(),
		});
	}
}
export class Researcher extends Agent {
	async quarantineStartCount() {
		return this.ctx.storage.kv.get<number>("research-starts") ?? 0;
	}

	async seedQuarantine(
		owner: { tediId: string; orgId: string },
		nested = false,
	) {
		this.setState({ aigMetadata: owner });
		await this.ctx.storage.put("quarantine-original-fact", {
			status: "UNKNOWN",
			private: "PRIVATE-ORIGINAL-RESEARCH",
		});
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS assistant_original_facts(status TEXT,content TEXT)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO assistant_original_facts VALUES ('running','PRIVATE-ORIGINAL-RESEARCH')",
		);
		// Original legacy tables and unresolved accounting are customer facts, not outcomes.
		this.ctx.storage.sql.exec(
			"CREATE TABLE assistant_messages(id TEXT PRIMARY KEY,session_id TEXT,parent_id TEXT,role TEXT,content BLOB,created_at TEXT)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO assistant_messages VALUES ('original-message','',NULL,'user',?,NULL)",
			new Uint8Array([0, 255, 1, 0]).buffer,
		);
		this.ctx.storage.sql.exec(
			"CREATE TABLE assistant_compactions(id TEXT PRIMARY KEY,session_id TEXT,summary TEXT,from_message_id TEXT,to_message_id TEXT,created_at TEXT)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO assistant_compactions VALUES ('original-compaction','','PRIVATE-ORIGINAL-SUMMARY',NULL,NULL,NULL)",
		);
		this.ctx.storage.sql.exec(
			"CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY,content TEXT)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO assistant_sessions VALUES ('original-session',NULL)",
		);
		this.ctx.storage.sql.exec(
			"CREATE VIRTUAL TABLE assistant_fts USING fts5(content)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO assistant_fts VALUES ('PRIVATE-ORIGINAL-SEARCH')",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status,metadata) VALUES ('original-tracking','original-provider-id','CHAT_TURN_WORKFLOW','queued','PRIVATE-ORIGINAL-METADATA')",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_fibers(fiber_id,idempotency_key,name,status,created_at) VALUES ('original-fiber','original-key','original-task','interrupted',1)",
		);
		this.ctx.storage.kv.put("think-accounting:original", {
			status: "UNKNOWN",
			reservationId: "original-reservation",
			amount: null,
		});
		if (nested)
			await (await this.subAgent(Researcher, "nested")).seedQuarantine(owner);
		return this.ctx.id.toString();
	}

	async onStart() {
		await this.ctx.storage.put(
			"research-starts",
			((await this.ctx.storage.get<number>("research-starts")) ?? 0) + 1,
		);
	}
	async seedInspection() {
		await this.ctx.storage.put("research-secret", "PRIVATE-RESEARCH");
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS research_history (content TEXT)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO research_history VALUES ('PRIVATE-RESEARCH')",
		);
		const state = await this.subAgent(ThinkMessengerStateAgent, "telegram");
		await state.cacheSet("private-key", "PRIVATE-TELEGRAM", 86400000);
		return this.researchSnapshot();
	}
	async researchSnapshot() {
		return JSON.stringify({
			registry: this.ctx.storage.sql
				.exec(
					"SELECT class,name,identity_version,identity_name FROM cf_agents_sub_agents",
				)
				.toArray(),
			kv: [...(await this.ctx.storage.list())],
			alarm: await this.ctx.storage.getAlarm(),
			sql: this.ctx.storage.sql
				.exec("SELECT * FROM research_history")
				.toArray(),
		});
	}
	async telegramWitness() {
		return (
			await this.subAgent(ThinkMessengerStateAgent, "telegram")
		).inspectionWitness();
	}
	async telegramInspection(input: PassiveCutoverInspection) {
		return (
			await this.subAgent(ThinkMessengerStateAgent, "telegram")
		).inspectStoredCutover(input);
	}
}
export class AgentTediDO extends Agent {
	async warmQuarantineOriginal(_path: string[]): Promise<number> {
		throw new Error("Raw fixture only");
	}

	async quarantineWitness(
		_path: string[],
		_mutation?: { kind: string; value: unknown },
	): Promise<string> {
		throw new Error("Raw fixture witness only");
	}

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		if (readStoredRuntimeAdmission(ctx.storage, ctx.id.toString()))
			return new RawCutoverDO(ctx, {
				...env,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([ctx.id.toString()]),
			}) as unknown as AgentTediDO;
		super(ctx, env);
	}
	async seedQuarantine(owner: { tediId: string; orgId: string }) {
		this.env.PI_CUTOVER_KNOWN_PARENT_IDS = JSON.stringify([
			this.ctx.id.toString(),
		]);
		this.setState(owner);
		this.ctx.storage.kv.put("__ps_name", this.name);
		const child = await this.subAgent(Researcher, "research");
		const id = await child.seedQuarantine(owner, true);
		return { root: this.ctx.id.toString(), child: id };
	}

	async seedInspection() {
		this.env.PI_CUTOVER_KNOWN_PARENT_IDS = JSON.stringify([
			this.ctx.id.toString(),
		]);
		await (await this.subAgent(Researcher, "research")).seedInspection();
		return { id: this.ctx.id.toString(), name: this.name };
	}
	async researchSnapshot() {
		return (await this.subAgent(Researcher, "research")).researchSnapshot();
	}
	async telegramWitness() {
		return (await this.subAgent(Researcher, "research")).telegramWitness();
	}
	async telegramInspection(input: PassiveCutoverInspection) {
		return (await this.subAgent(Researcher, "research")).telegramInspection(
			input,
		);
	}
	override async fetch(request: Request) {
		this.env.PI_CUTOVER_KNOWN_PARENT_IDS = JSON.stringify([
			this.ctx.id.toString(),
		]);
		return operateStoredCutover({ ctx: this.ctx, env: this.env, request });
	}
}

// Seeds the original native context before measuring the actual production constructor.
// The existing AgentTediDO export above remains the separate scripted fixture.
import { DurableObject as NativeDurableObject } from "cloudflare:workers";
export class ProductionRootEntryProbe extends NativeDurableObject<Cloudflare.Env> {
	/** Measures the actual production class; this path never seeds the old probe. */
	async qualifyPristine(input: {
		identity?:
			| "missing"
			| "canonical"
			| "alias"
			| "wrong-runtime"
			| "wrong-org"
			| "null-name"
			| "rebound"
			| "duplicate"
			| "malformed-id"
			| "wrong-namespace";
		failure?: "d1" | "after-query";
		impurity?: "kv" | "undefined" | "table" | "view" | "trigger" | "alarm";
		mutation?:
			| "kv"
			| "schema"
			| "name"
			| "alarm"
			| "canonical"
			| "tenant"
			| "config"
			| "path"
			| "facet"
			| "undefined-name";
		measureBeforeStart?: boolean;
		restart?: boolean;
	}) {
		const { AgentTediDO: Production } = await import("../../src/do");
		const { Agent: ActualAgent } = await import("agents");
		const { readStoredRuntimeAdmission } =
			await import("../../src/runtime-admission-do");
		const id = this.ctx.id.toString(),
			name = this.ctx.id.name;
		if (!name)
			throw new Error("Qualification requires a real named native stub");
		const ns = (
			this.env as unknown as { PRODUCTION_ROOT_ENTRY: DurableObjectNamespace }
		).PRODUCTION_ROOT_ENTRY;
		const db = (this.env as unknown as { PRISTINE_PARENT_DB: D1Database })
			.PRISTINE_PARENT_DB;
		const owner = { id: crypto.randomUUID(), orgId: crypto.randomUUID() };
		await db
			.prepare(
				"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
			)
			.run();
		if (input.identity && input.identity !== "missing")
			await db
				.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
				.bind(
					input.identity === "malformed-id" ? "not-a-tedi-uuid" : owner.id,
					input.identity === "wrong-org" ? "not-an-org-uuid" : owner.orgId,
					input.identity === "rebound" ? "logical-slug" : name,
					input.identity === "null-name"
						? null
						: input.identity === "alias"
							? "different-physical-name"
							: name,
					input.identity === "wrong-runtime" ? "removed-runtime" : "agent",
					"active",
				)
				.run();
		if (input.identity === "duplicate")
			await db
				.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
				.bind(
					crypto.randomUUID(),
					crypto.randomUUID(),
					"other-logical-slug",
					name,
					"agent",
					"active",
				)
				.run();
		const encode = (_key: string, value: unknown) => {
			if (value instanceof ArrayBuffer)
				return { type: "ArrayBuffer", bytes: [...new Uint8Array(value)] };
			if (ArrayBuffer.isView(value))
				return {
					type: value.constructor.name,
					bytes: [
						...new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
					],
				};
			if (value === undefined) return { type: "undefined" };
			if (typeof value === "number" && Object.is(value, -0))
				return { type: "-0" };
			return value;
		};
		const facts = () => {
			const schema = this.ctx.storage.sql
				.exec<{ name: string; type: string; sql: string | null }>(
					"SELECT name,type,sql FROM sqlite_master ORDER BY name",
				)
				.toArray();
			return {
				schema,
				tables: schema
					.filter((r) => r.type === "table" && !r.name.startsWith("_cf_"))
					.map((r) => ({
						name: r.name,
						rows: this.ctx.storage.sql
							.exec(`SELECT * FROM "${r.name.replaceAll('"', '""')}"`)
							.toArray(),
					})),
				kv: [...this.ctx.storage.kv.list()],
			};
		};
		const snapshot = async () =>
			JSON.stringify(
				{
					...facts(),
					alarm: await this.ctx.storage.getAlarm(),
					admission: readStoredRuntimeAdmission(this.ctx.storage, id),
				},
				encode,
			);
		const empty = await snapshot();
		if (input.impurity === "kv")
			this.ctx.storage.kv.put("original-private", new Uint8Array([0, 255]));
		if (input.impurity === "undefined")
			this.ctx.storage.kv.put("original-undefined", undefined);
		if (input.impurity === "table" || input.impurity === "trigger")
			this.ctx.storage.sql.exec(
				"CREATE TABLE original_private(id INTEGER PRIMARY KEY,value BLOB)",
			);
		if (input.impurity === "table")
			this.ctx.storage.sql.exec(
				"INSERT INTO original_private VALUES(1,?)",
				new Uint8Array([0, 255]).buffer,
			);
		if (input.impurity === "view")
			this.ctx.storage.sql.exec(
				"CREATE VIEW original_private_view AS SELECT 1 AS value",
			);
		if (input.impurity === "trigger")
			this.ctx.storage.sql.exec(
				"CREATE TRIGGER original_private_trigger AFTER INSERT ON original_private BEGIN UPDATE original_private SET value=X'01' WHERE id=NEW.id; END",
			);
		if (input.impurity === "alarm")
			await this.ctx.storage.setAlarm(Date.now() + 86400_000);
		const before = await snapshot();
		const trace: Array<{ event: string; facts: string }> = [];
		const record = (event: string) =>
			trace.push({ event, facts: JSON.stringify(facts(), encode) });
		let providerReads = 0,
			firstRow: unknown = null,
			queryCount = 0,
			mutated = false,
			measuringIdentity = false;
		let actualInstance: InstanceType<typeof Production> | undefined;
		const queryErrors: unknown[] = [];
		const d1Failure = new Error("qualification-owned-D1-failure");
		const barrierFailure = new Error("qualification-owned-post-query-barrier");
		const wrapStatement = (
			statement: D1PreparedStatement,
		): D1PreparedStatement =>
			new Proxy(statement, {
				get: (target, key) => {
					if (key === "bind")
						return (...values: unknown[]) =>
							wrapStatement(target.bind(...values));
					if (key === "first")
						return async (
							...args: Parameters<D1PreparedStatement["first"]>
						) => {
							queryCount++;
							record("d1:first:enter");
							if (input.failure === "d1") {
								queryErrors.push(d1Failure);
								throw d1Failure;
							}
							const row = await target.first(...args);
							if (queryCount === 1) firstRow = row;
							record("d1:first:resolved");
							if (input.mutation && !mutated) {
								mutated = true;
								if (input.mutation === "kv")
									this.ctx.storage.kv.put("await-private", {
										token: "PRIVATE-race",
									});
								if (input.mutation === "schema")
									this.ctx.storage.sql.exec(
										"CREATE VIEW await_private_view AS SELECT 2 AS value",
									);
								if (input.mutation === "name")
									this.ctx.storage.kv.put("__ps_name", "changed-original-name");
								if (input.mutation === "alarm")
									await this.ctx.storage.setAlarm(Date.now() + 86400_000);
								if (input.mutation === "canonical")
									await db
										.prepare("UPDATE tedis SET isolate_agent_id=? WHERE id=?")
										.bind("changed-canonical", owner.id)
										.run();
								if (input.mutation === "tenant" && actualInstance)
									actualInstance.setState({
										...actualInstance.state,
										orgId: crypto.randomUUID(),
									});
								if (input.mutation === "config" && actualInstance)
									(
										actualInstance as unknown as {
											runtimeConfigCache: { invalidate(): void };
										}
									).runtimeConfigCache.invalidate();
								if (input.mutation === "path")
									this.ctx.storage.kv.put("cf_agents_parent_path", [
										{ className: "AgentTediDO", name: "changed-parent" },
									]);
								if (input.mutation === "facet")
									this.ctx.storage.kv.put("cf_agents_is_facet", true);
								if (input.mutation === "undefined-name")
									this.ctx.storage.kv.put("__ps_name", undefined);
								record("d1:first:mutated");
							}
							if (input.failure === "after-query" && !measuringIdentity) {
								queryErrors.push(barrierFailure);
								throw barrierFailure;
							}
							return row;
						};
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		const runtimeDb = new Proxy(db, {
			get: (target, key) =>
				key === "prepare"
					? (sql: string) => wrapStatement(target.prepare(sql))
					: typeof Reflect.get(target, key) === "function"
						? Reflect.get(target, key).bind(target)
						: Reflect.get(target, key),
		});
		const denied = new Set([
			"AI",
			"BROWSER",
			"API_SERVICE",
			"TEDI_WORKSTATION",
			"CHAT_TURN_WORKFLOW",
			"SKILL_WORKFLOW",
			"ARTIFACTS",
		]);
		const runtimeEnv = new Proxy(
			{
				...this.env,
				DB: runtimeDb,
				TEDI_AGENT:
					input.identity === "wrong-namespace"
						? (this.env as unknown as { PI_STORAGE: DurableObjectNamespace })
								.PI_STORAGE
						: ns,
				PI_CUTOVER_PARENT_IDS: "[]",
				PI_CUTOVER_KNOWN_PARENT_IDS: "[]",
			} as Cloudflare.Env,
			{
				get: (target, key, receiver) => {
					if (typeof key === "string" && denied.has(key)) {
						return new Proxy(
							{},
							{
								get: () => () => {
									providerReads++;
									throw new Error(
										"Qualification forbids provider/service dispatch",
									);
								},
							},
						);
					}
					return Reflect.get(target, key, receiver);
				},
			},
		);
		const originals: Array<{
			target: object;
			key: string;
			descriptor: PropertyDescriptor;
		}> = [];
		let startupError: unknown = null;
		const wrap = (target: object, key: string, event: string) => {
			const descriptor = Object.getOwnPropertyDescriptor(target, key);
			if (!descriptor || typeof descriptor.value !== "function")
				throw new Error(`Pinned SDK instrumentation unavailable: ${key}`);
			originals.push({ target, key, descriptor });
			Object.defineProperty(target, key, {
				...descriptor,
				value: function (this: unknown, ...args: unknown[]) {
					record(`${event}:enter`);
					try {
						const result = Reflect.apply(
							descriptor.value,
							this,
							args,
						) as unknown;
						if (
							result &&
							typeof (result as { then?: unknown }).then === "function"
						)
							return (result as Promise<unknown>).then(
								(value: unknown) => {
									record(`${event}:exit`);
									return value;
								},
								(error: unknown) => {
									if (event === "user:start") startupError = error;
									record(`${event}:reject`);
									throw error;
								},
							);
						record(`${event}:exit`);
						return result;
					} catch (error) {
						if (event === "user:start") startupError = error;
						record(`${event}:reject`);
						throw error;
					}
				},
			});
		};
		try {
			wrap(ActualAgent.prototype, "_checkOrphanedWorkflows", "sdk:workflows");
			wrap(ActualAgent.prototype, "_checkRunFibers", "sdk:fibers");
			wrap(Production.prototype, "onStart", "user:start");
			const instance = new Production(this.ctx, runtimeEnv);
			actualInstance = instance;
			const afterConstructor = await snapshot();
			let directIdentity: unknown = null;
			// Real callers read Agent.state before cold discovery. Preserve that SDK
			// getter initialization separately from the measured helper window.
			if (input.measureBeforeStart) void instance.state;
			const helperBefore = await snapshot();
			if (input.measureBeforeStart) {
				measuringIdentity = true;
				directIdentity = await (
					instance as unknown as { resolveIdentityFromD1(): Promise<unknown> }
				).resolveIdentityFromD1();
				measuringIdentity = false;
			}
			const helperAfter = await snapshot();
			let wrappedStartupRejected = false,
				wrappedStartupErrorType: string | null = null;
			try {
				await instance.onStart();
			} catch (error) {
				wrappedStartupRejected = true;
				wrappedStartupErrorType = error === null ? "null" : typeof error;
			}
			const afterStart = await snapshot();
			let resolvedIdentity: unknown = null;
			if (
				!input.measureBeforeStart &&
				input.identity &&
				input.identity !== "missing" &&
				input.failure !== "d1"
			) {
				measuringIdentity = true;
				resolvedIdentity = await (
					instance as unknown as {
						resolveIdentityFromD1(): Promise<unknown>;
					}
				).resolveIdentityFromD1();
			}
			const persistedBeforeRestart = await snapshot();
			let restarted: { agent: boolean; afterConstructor: string } | null = null;
			if (input.restart) {
				const second = new Production(this.ctx, runtimeEnv);
				restarted = {
					agent: second instanceof ActualAgent,
					afterConstructor: await snapshot(),
				};
			}
			const canonicalAfter = await db
				.prepare(
					"SELECT id,organization_id,isolate_agent_id,runtime_kind FROM tedis WHERE id=?",
				)
				.bind(owner.id)
				.first();
			return JSON.stringify(
				{
					id,
					nativeName: name,
					namespaceId: ns.idFromName(name).toString(),
					owner,
					empty,
					before,
					afterConstructor,
					afterStart,
					persistedBeforeRestart,
					restarted,
					trace,
					providerReads,
					queryCount,
					firstRow,
					resolvedIdentity,
					directIdentity,
					helperBefore,
					helperAfter,
					canonicalAfter,
					mutated,
					wrappedStartupRejected,
					wrappedStartupErrorType,
					startupError:
						startupError instanceof Error ? startupError.message : null,
					exactD1Error: startupError === d1Failure,
					exactBarrierError: startupError === barrierFailure,
					originalQueryErrorRetained: queryErrors.includes(startupError),
					admission: readStoredRuntimeAdmission(this.ctx.storage, id),
					agent: instance instanceof ActualAgent,
				},
				encode,
			);
		} finally {
			for (const { target, key, descriptor } of originals.reverse())
				Object.defineProperty(target, key, descriptor);
		}
	}
	async construct(input: {
		selected: boolean;
		request?: { token?: string; query?: Record<string, string | undefined> };
		legacyPending?: boolean;
		historicalPartial?: boolean;
		postWrongPhysical?: boolean;
		mutation?: "private" | "name";
		admissionState?: "active" | "quarantined";
		custody?: "valid" | "physical" | "canonical" | "owner";
	}) {
		const { AgentTediDO: ProductionAgentTediDO } = await import("../../src/do");
		const { RawCutoverDO: ActualRaw } =
			await import("../../src/pi-cutover-maintenance-do");
		const { Agent: ActualAgent } = await import("agents");
		const id = this.ctx.id.toString();
		this.ctx.storage.sql.exec(
			"CREATE TABLE original_customer(id TEXT PRIMARY KEY,text TEXT,bytes BLOB,future TEXT)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO original_customer VALUES(?,?,?,?)",
			"original",
			"PRIVATE-original",
			new Uint8Array([0, 255, 42]).buffer,
			"future-column",
		);
		this.ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
			JSON.stringify({ token: "PRIVATE-original" }),
		);
		this.ctx.storage.kv.put("cf_agents_is_facet", false);
		this.ctx.storage.kv.put("cf_agents_parent_path", []);
		this.ctx.storage.kv.put("pi-accounting:original", {
			version: 1,
			runId: "original",
			attempts: [],
			fault: input.admissionState ? null : "PRIVATE-fault",
			receiptFault: !input.admissionState,
		});
		if (input.historicalPartial)
			this.ctx.storage.sql.exec(
				"CREATE TABLE historical_replay_seals(original_private TEXT)",
			);
		if (input.legacyPending) {
			this.ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_runs(id TEXT,name TEXT,completed_at TEXT)",
			);
			this.ctx.storage.sql.exec(
				"INSERT INTO cf_agents_runs VALUES('original-run','__cf_internal_chat_turn',NULL)",
			);
		}
		if (input.admissionState) {
			const owner = {
				objectId: id,
				tediId: crypto.randomUUID(),
				orgId: crypto.randomUUID(),
			};
			this.ctx.storage.sql.exec(
				"UPDATE cf_agents_state SET state=?",
				JSON.stringify({
					tediId: owner.tediId,
					orgId: owner.orgId,
					token: "PRIVATE-original",
				}),
			);
			const admission = new RuntimeAdmissionDO(this.ctx.storage, owner);
			admission.gate.initialize({
				operationId: "original-admission",
				state: input.admissionState,
				evidence: await admission.prepareEvidence("initialize"),
			});
		}
		await this.ctx.storage.setAlarm(Date.now() + 86400_000);
		const snapshot = async () => {
			const schema = this.ctx.storage.sql
				.exec<{ name: string; type: string; sql: string }>(
					"SELECT name,type,sql FROM sqlite_master ORDER BY name",
				)
				.toArray();
			const tables = schema
				.filter((r) => r.type === "table" && !r.name.startsWith("_cf_"))
				.map((r) => ({
					name: r.name,
					rows: this.ctx.storage.sql
						.exec(`SELECT * FROM "${r.name.replaceAll('"', '""')}"`)
						.toArray(),
				}));
			return JSON.stringify(
				{
					schema,
					tables,
					kv: [...this.ctx.storage.kv.list()],
					alarm: await this.ctx.storage.getAlarm(),
				},
				(_k, v) =>
					v instanceof ArrayBuffer ? { blob: [...new Uint8Array(v)] } : v,
			);
		};
		const identity = {
			tediId: crypto.randomUUID(),
			orgId: crypto.randomUUID(),
			objectName: this.ctx.id.name ?? "unknown-original",
		};
		let custodyHeader: string | undefined;
		let db = this.env.DB;
		if (input.custody) {
			this.ctx.storage.sql.exec(
				"CREATE TABLE tedis(id TEXT,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
			);
			this.ctx.storage.sql.exec(
				"INSERT INTO tedis VALUES(?,?,?,?,?,?)",
				identity.tediId,
				identity.orgId,
				"original",
				identity.objectName,
				"agent",
				"active",
			);
			this.ctx.storage.sql.exec(
				"UPDATE cf_agents_state SET state=?",
				JSON.stringify({ ...identity, token: "PRIVATE-original" }),
			);
			db = {
				prepare: (sql: string) => ({
					bind: (...values: SqlStorageValue[]) => ({
						first: async () =>
							this.ctx.storage.sql.exec(sql, ...values).toArray()[0] ?? null,
					}),
				}),
			} as unknown as Cloudflare.Env["DB"];
			const rootId =
				input.custody === "physical"
					? (
							this.env as unknown as {
								PRODUCTION_ROOT_ENTRY: DurableObjectNamespace;
							}
						).PRODUCTION_ROOT_ENTRY.idFromName("wrong-physical").toString()
					: id;
			custodyHeader = JSON.stringify({
				rootId,
				...identity,
				orgId: input.custody === "owner" ? crypto.randomUUID() : identity.orgId,
				objectName:
					input.custody === "canonical"
						? "wrong-canonical"
						: identity.objectName,
				parentPath: [],
				current: null,
			});
		}
		const before = await snapshot();
		let providerReads = 0;
		const runtimeEnv = new Proxy(
			{
				...this.env,
				DB: db,
				TEDI_AGENT: (
					this.env as unknown as {
						PRODUCTION_ROOT_ENTRY: DurableObjectNamespace;
					}
				).PRODUCTION_ROOT_ENTRY,
				PI_CUTOVER_PARENT_IDS: JSON.stringify(input.selected ? [id] : []),
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([
					id,
					...(input.custody === "physical"
						? [
								(
									this.env as unknown as {
										PRODUCTION_ROOT_ENTRY: DurableObjectNamespace;
									}
								).PRODUCTION_ROOT_ENTRY.idFromName("wrong-physical").toString(),
							]
						: []),
				]),
			} as Cloudflare.Env,
			{
				get(target, key, receiver) {
					if (key === "AI" || key === "BROWSER" || key === "TEDI_WORKSTATION") {
						providerReads++;
						throw new Error("Provider access forbidden in constructor proof");
					}
					return Reflect.get(target, key, receiver);
				},
			},
		);
		let instance: InstanceType<typeof ProductionAgentTediDO>;
		try {
			instance = new ProductionAgentTediDO(this.ctx, runtimeEnv);
		} catch (error) {
			return {
				id,
				nativeName: this.ctx.id.name ?? null,
				before,
				after: await snapshot(),
				providerReads,
				constructorError: error instanceof Error ? error.message : "unknown",
			};
		}
		const afterConstructor = await snapshot(),
			raw = instance instanceof ActualRaw,
			agent = instance instanceof ActualAgent;
		let status: number | null = null,
			result: unknown = null,
			fetchError: string | null = null;
		let nameError: string | null = null;
		if (agent) {
			try {
				void instance.name;
			} catch (error) {
				nameError = error instanceof Error ? error.message : "unknown";
			}
		}
		let digestMutations = 0;
		if (input.request) {
			const url = new URL("https://fixture/__admin/pi-state-cutover");
			for (const [k, v] of Object.entries(input.request.query ?? {}))
				if (v !== undefined) url.searchParams.set(k, v);
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			if (input.mutation)
				crypto.subtle.digest = async (
					...args: Parameters<SubtleCrypto["digest"]>
				) => {
					const value = await digest(...args);
					if (++digestMutations === 3) {
						if (input.mutation === "name")
							this.ctx.storage.kv.put("__ps_name", "changed-original");
						else
							this.ctx.storage.sql.exec(
								"UPDATE cf_agents_state SET state=?",
								JSON.stringify({ token: "PRIVATE-changed" }),
							);
					}
					return value;
				};
			const pending = instance.fetch(
				new Request(url, {
					...(input.postWrongPhysical
						? {
								method: "POST",
								body: JSON.stringify({
									custody: identity,
									objectId: "a".repeat(64),
									operationId: "wrong-physical-read",
									command: "inspect_capture_size",
									expectedGeneration: 0,
								}),
							}
						: {}),
					headers: {
						"X-Tedix-Admin-Token":
							input.request.token ?? "cutover-native-fixture-token",
						...(custodyHeader
							? { "X-Tedix-Cutover-Inspection-Custody": custodyHeader }
							: {}),
					},
				}),
			);
			try {
				const response = await pending;
				status = response.status;
				const text = await response.text();
				try {
					result = JSON.parse(text);
				} catch {
					result = text;
				}
			} catch (error) {
				fetchError = error instanceof Error ? error.message : "unknown";
			} finally {
				crypto.subtle.digest = digest;
			}
		}
		return {
			id,
			nativeName: this.ctx.id.name ?? null,
			raw,
			agent,
			before,
			afterConstructor,
			after: await snapshot(),
			providerReads,
			status,
			result,
			fetchError,
			nameError,
			digestMutations,
		};
	}
}
