import { generateText } from "ai";
import { selectChatModelForTurn } from "../../src/turn-model-selection";
import { createHash } from "node:crypto";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
	DurableObject,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { AgentTediDO } from "../../src/do";
import { ConversationFacet } from "../../src/conversation-facet";
import { RuntimeAdmission } from "../../src/runtime-admission";
import { HistoricalExecutionGuard } from "../../src/historical-execution-guard";
import { HistoricalLiabilityCustody } from "../../src/historical-liability-custody";
import type { AgentPathStep, FiberRecoveryContext } from "agents";
export class GuardProbe extends DurableObject {
	async increment(key: string) {
		this.ctx.storage.kv.put(
			key,
			(this.ctx.storage.kv.get<number>(key) ?? 0) + 1,
		);
	}
	async count(key: string) {
		return this.ctx.storage.kv.get<number>(key) ?? 0;
	}
}
type Env = Cloudflare.Env & {
	GUARD_PROBE: DurableObjectNamespace<GuardProbe>;
	GUARD_PI: DurableObjectNamespace<GuardPi>;
};
export class GuardWorkflow extends WorkflowEntrypoint<Env, { runId?: string }> {
	async run(event: WorkflowEvent<{ runId?: string }>, step: WorkflowStep) {
		await step.do("native-effect", async () => {
			await this.env.GUARD_PROBE.getByName("global").increment(
				event.instanceId,
			);
			return "effect";
		});
		await step.waitForEvent("native-wait", {
			type: "finish",
			timeout: "1 day",
		});
		return "completed";
	}
}
/** Real Agent constructor/SDK; product D1/Telegram/maintenance startup is deliberately outside this boundary fixture. */
/** Test-only ports: actual production observer/SDK, billing and final wire wrappers remain in use. */
export interface ObserverFixturePorts {
	billing: (body: string) => Promise<Response>;
	wire: () => Promise<Response>;
}
const observerPorts = new Map<string, ObserverFixturePorts>();
export function setObserverFixturePorts(
	ctx: DurableObjectState,
	ports: ObserverFixturePorts,
) {
	observerPorts.set(ctx.id.toString(), ports);
}
export class GuardParent extends AgentTediDO {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, retryFixtureEnvironment(ctx, env));
	}
	async installCompilationFixture(failPlatform = false) {
		const mark = (key: string) =>
			this.ctx.storage.kv.put(
				key,
				(this.ctx.storage.kv.get<number>(key) ?? 0) + 1,
			);
		Object.defineProperty(this, "ensureIdentity", {
			configurable: true,
			value: async () => {
				mark("fixture:compile:identity");
			},
		});
		Object.defineProperty(this, "getPlatformClient", {
			configurable: true,
			value: async () => {
				mark("fixture:compile:platform");
				if (failPlatform)
					throw new Error("scripted compilation platform failure");
				return {
					getDomains: async () => {
						mark("fixture:compile:domains");
						return new Map<string, string>();
					},
					memorySearch: async () => {
						mark("fixture:compile:search");
						return { results: [] };
					},
					getRationaleChain: async () => {
						mark("fixture:compile:rationale");
						return { data: [] };
					},
				};
			},
		});
	}
	async compileFixture(kind: "digest" | "directives", runId: unknown) {
		if (kind === "digest") await this.onCompileBrainDigest(runId as string);
		else await this.onCompileDirectives(runId as string);
	}
	async maintenanceCompilationFixture(
		task: "isolate-brain-digest" | "isolate-directive-compile",
		operation: import("../../src/pi-parent-services").ParentServiceOperation,
	) {
		const root = this as unknown as {
			runMaintenanceEffects(
				task: string,
				operation: import("../../src/pi-parent-services").ParentServiceOperation,
			): Promise<
				import("../../src/pi-parent-services").MaintenanceEffectResult
			>;
		};
		return root.runMaintenanceEffects(task, operation);
	}
	compilationFixtureCounts() {
		return Object.fromEntries(
			["identity", "platform", "domains", "search", "rationale"].map((key) => [
				key,
				this.ctx.storage.kv.get<number>(`fixture:compile:${key}`) ?? 0,
			]),
		);
	}
	async observerFixtureCall(runId?: string, cancellationRunId = runId) {
		(
			this as unknown as { runtimeConfigCache: { modelPolicy: unknown } }
		).runtimeConfigCache.modelPolicy = {
			chatModelRef: null,
			cronModelRef: null,
			observerModelRef: "azure-openai/gpt-5.6-terra",
		};
		const root = this as unknown as {
			getObserverLlmClient(
				id?: string,
				cancellationRunId?: string,
			): {
				chat(p: {
					messages: { role: "user"; content: string }[];
				}): Promise<unknown>;
			};
		};
		return root
			.getObserverLlmClient(runId, cancellationRunId)
			.chat({ messages: [{ role: "user", content: "fixture" }] });
	}
	async observerSdkRetryFixture(runId: string) {
		const root = this as unknown as {
			observerBeforeDispatch(id: string): () => void;
		};
		return generateText({
			model: selectChatModelForTurn(
				this.env,
				{ modelRef: "azure-openai/gpt-5.6-terra" },
				{ orgId: this.state.orgId, tediId: this.state.tediId },
				undefined,
				undefined,
				root.observerBeforeDispatch(runId),
			).model,
			prompt: "fixture",
			maxRetries: 2,
		});
	}
	async armSdkRetry(id: string) {
		this.ctx.storage.kv.put("fixture:retry-armed", id);
	}

	override async onStart() {}
	override async onFiberRecovered(_ctx: FiberRecoveryContext) {
		this.ctx.storage.kv.put(
			"fixture:recovery",
			(this.ctx.storage.kv.get<number>("fixture:recovery") ?? 0) + 1,
		);
		return { status: "error" as const, error: "unexpected recovery" };
	}
	async sdkCreate(id: string) {
		return this.runWorkflow(
			"CHAT_TURN_WORKFLOW",
			{},
			{ id, agentBinding: "TEDI_AGENT" },
		);
	}
	async create(id: string, runId?: string) {
		const instance = await this.env.CHAT_TURN_WORKFLOW.create({
			id,
			params: runId
				? {
						runId,
						sessionKey: "fixture-session",
						userText: "fixture",
						userTs: 1,
						conversationId: "fixture",
						clientRequestId: "fixture",
					}
				: undefined,
		});
		return instance.id;
	}
	async batch(ids: string[]) {
		return (
			await this.env.CHAT_TURN_WORKFLOW.createBatch(ids.map((id) => ({ id })))
		).map((instance) => instance.id);
	}
	async mutate(id: string, method: "restart" | "resume" | "sendEvent") {
		const instance = await this.env.CHAT_TURN_WORKFLOW.get(id);
		if (method === "sendEvent")
			return instance.sendEvent({ type: "finish", payload: {} });
		return instance[method]();
	}
	async nativeHandle(id: string) {
		return this.env.CHAT_TURN_WORKFLOW.get(id);
	}
	async observe(id: string) {
		return (await (await this.env.CHAT_TURN_WORKFLOW.get(id)).status()).status;
	}
	async invokeFiber(id: string, key?: string) {
		const result = await this.startFiber(
			"actual native function",
			async () => {
				this.ctx.storage.kv.put(
					"fixture:effects",
					(this.ctx.storage.kv.get<number>("fixture:effects") ?? 0) + 1,
				);
			},
			{ fiberId: id, idempotencyKey: key, waitForCompletion: true },
		);
		return { status: result.status };
	}
	async invokeRunFiber() {
		return this.runFiber("actual generated ID", async (ctx) => {
			this.ctx.storage.kv.put("fixture:last-id", ctx.id);
			this.ctx.storage.kv.put(
				"fixture:effects",
				(this.ctx.storage.kv.get<number>("fixture:effects") ?? 0) + 1,
			);
			return ctx.id;
		});
	}
	async armRegistrationRace() {
		this.ctx.storage.kv.put("fixture:registration-race", true);
	}
	override async _cf_registerFacetRun(
		path: ReadonlyArray<AgentPathStep>,
		id: string,
	) {
		if (this.ctx.storage.kv.get("fixture:registration-race") === true) {
			const facet = await this.subAgent(GuardPi, "race");
			await facet.captureFromRegistration(id);
		}
		await super._cf_registerFacetRun(path, id);
	}
	async raceFacetFiber() {
		const facet = await this.subAgent(GuardPi, "race");
		return facet.invokeFiber("registration-race-fiber");
	}
}
export class GuardPi extends ConversationFacet {
	/** Business admission/models excluded only after the fixture's explicit verified release.
	 * Production pre-super replay guards, environment, Fiber methods and native Pi lifecycle stay intact. */
	private assertRetirementFixtureRelease(): void {
		const flag = this.ctx.storage.kv.get<{
			generation: number;
			objectId: string;
			snapshotId: string;
			sourceHash: string;
		}>("fixture:verified-retirement-release");
		if (!flag) throw new Error("fixture release absent");
		const owner = {
				objectId: this.ctx.id.toString(),
				tediId: "native-tedi",
				orgId: "native-org",
			},
			current = new RuntimeAdmission(this.ctx.storage, owner, () => {
				throw new Error("unexpected verifier");
			}).read();
		if (
			!current ||
			current.state !== "active" ||
			current.generation !== flag.generation ||
			flag.objectId !== owner.objectId
		)
			throw new Error("fixture release mismatch");
		const summary = new HistoricalLiabilityCustody(
				this.ctx.storage,
				owner.objectId,
			).audit(),
			rows = this.ctx.storage.sql
				.exec<{ receipt: string; receipt_hash: string }>(
					"SELECT receipt,receipt_hash FROM historical_tracking_retirement",
				)
				.toArray();
		if (
			!summary ||
			rows.length !== 1 ||
			summary.snapshotId !== flag.snapshotId ||
			summary.sourceHash !== flag.sourceHash ||
			summary.generation !== flag.generation - 1
		)
			throw new Error("fixture archive mismatch");
		const row = rows[0]!,
			receipt = JSON.parse(row.receipt);
		if (
			createHash("sha256").update(JSON.stringify(receipt)).digest("hex") !==
				row.receipt_hash ||
			receipt.objectId !== owner.objectId ||
			receipt.archiveHash !== flag.snapshotId ||
			receipt.originalSourceHash !== flag.sourceHash ||
			receipt.request.expectedGeneration !== summary.generation
		)
			throw new Error("fixture receipt mismatch");
	}
	protected override async assertFacetRuntimeDispatch(): Promise<void> {
		if (!this.ctx.storage.kv.get("fixture:verified-retirement-release"))
			return super.assertFacetRuntimeDispatch();
		this.assertRetirementFixtureRelease();
	}
	protected override selectModelForTurn() {
		if (!this.ctx.storage.kv.get("fixture:verified-retirement-release"))
			return super.selectModelForTurn();
		this.assertRetirementFixtureRelease();
		const model: LanguageModelV3 = {
			specificationVersion: "v3",
			provider: "test",
			modelId: "no-dispatch",
			supportedUrls: {},
			doGenerate: async () => {
				throw new Error("fixture does not admit model execution");
			},
			doStream: async () => {
				throw new Error("fixture does not admit model execution");
			},
		};
		return {
			model,
			identity: { provider: "workers-ai" as const, model: "@cf/test" },
		};
	}

	async invokeFiber(id: string, key?: string) {
		const result = await this.startFiber(
			"actual Pi function",
			async () => {
				this.ctx.storage.kv.put(
					"fixture:effects",
					(this.ctx.storage.kv.get<number>("fixture:effects") ?? 0) + 1,
				);
			},
			{
				fiberId: id,
				...(key ? { idempotencyKey: key } : {}),
				waitForCompletion: true,
			},
		);
		return { status: result.status };
	}
	async inspectSeal() {
		const effects = this.ctx.storage.kv.get<number>("fixture:effects") ?? 0;
		try {
			new HistoricalExecutionGuard(
				this.ctx.storage,
				this.ctx.id.toString(),
			).startFiber("registration-race-fiber");
			return { effects, sealed: false };
		} catch {
			return { effects, sealed: true };
		}
	}
	async captureFromRegistration(_actualId: string) {
		seedCustody(this.ctx);
		const store = new HistoricalLiabilityCustody(
				this.ctx.storage,
				this.ctx.id.toString(),
			),
			s = store.inspectSnapshot({ expectedGeneration: 1 });
		store.captureSnapshot({
			expectedGeneration: 1,
			expectedSourceHash: s.sourceHash,
		});
	}
	override async onFiberRecovered(_ctx: FiberRecoveryContext) {
		this.ctx.storage.kv.put(
			"fixture:recovery",
			(this.ctx.storage.kv.get<number>("fixture:recovery") ?? 0) + 1,
		);
		return { status: "error" as const, error: "unexpected recovery" };
	}
}
/** Test-only nonactive local custody, not production owner/activation eligibility proof. */
export function seedCustody(ctx: DurableObjectState) {
	const owner = {
		objectId: ctx.id.toString(),
		tediId: "native-tedi",
		orgId: "native-org",
	};
	new RuntimeAdmission(ctx.storage, owner, () => {
		throw new Error("unexpected fixture verifier");
	}).initialize({
		operationId: "native-unknown-custody",
		state: "quarantined",
		reason: "explicit native fixture",
	});
	const state = ctx.storage.sql
		.exec<{ state: string }>(
			"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
		)
		.toArray()[0];
	const existing = state ? JSON.parse(state.state) : {};
	const updated =
		ctx.storage.kv.get("cf_agents_is_facet") === true
			? {
					...existing,
					aigMetadata: { tediId: owner.tediId, orgId: owner.orgId },
				}
			: { ...existing, tediId: owner.tediId, orgId: owner.orgId };
	ctx.storage.sql.exec(
		"INSERT OR REPLACE INTO cf_agents_state(id,state) VALUES ('cf_state_row_id',?)",
		JSON.stringify(updated),
	);
}
export default {
	fetch() {
		return new Response("dedicated historical guard fixture");
	},
};

/** Script only the first native-port failure; Agent.restartWorkflow and its retry loop remain actual pinned SDK. */
function retryFixtureEnvironment(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
): Cloudflare.Env {
	const binding = env.CHAT_TURN_WORKFLOW;
	const scripted = new Proxy(binding, {
		get(target, key) {
			const method = Reflect.get(target, key, target);
			if (key === "get")
				return async (id: string) => {
					const native = await target.get(id);
					return new Proxy(native, {
						get(instance, property) {
							const fn = Reflect.get(instance, property, instance);
							if (property === "restart")
								return async () => {
									if (ctx.storage.kv.get("fixture:retry-armed") === id) {
										ctx.storage.kv.delete("fixture:retry-armed");
										ctx.storage.kv.put("fixture:first-provider-failure", true);
										// Deterministic dispatch barrier: original guard already admitted this first
										// attempt. Persist its seal before rejecting, so the actual SDK retry
										// can never outrun an independently scheduled timer.
										seedCustody(ctx);
										const store = new HistoricalLiabilityCustody(
											ctx.storage,
											ctx.id.toString(),
										);
										const snapshot = store.inspectSnapshot({
											expectedGeneration: 1,
										});
										store.captureSnapshot({
											expectedGeneration: 1,
											expectedSourceHash: snapshot.sourceHash,
										});
										ctx.storage.kv.put("fixture:retry-barrier-sealed", true);
										throw Object.assign(
											new Error("scripted transient provider boundary"),
											{ retryable: true },
										);
									}
									ctx.storage.kv.put(
										"fixture:restart-provider-dispatches",
										(ctx.storage.kv.get<number>(
											"fixture:restart-provider-dispatches",
										) ?? 0) + 1,
									);
									return instance.restart();
								};
							return typeof fn === "function" ? fn.bind(instance) : fn;
						},
					});
				};
			return typeof method === "function" ? method.bind(target) : method;
		},
	});
	return Object.defineProperties(Object.create(Object.getPrototypeOf(env)), {
		...Object.getOwnPropertyDescriptors(env),
		API_SERVICE: {
			configurable: true,
			enumerable: true,
			value: {
				fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
					const ports = observerPorts.get(ctx.id.toString());
					if (!ports) throw new Error("observer fixture ports absent");
					return ports.billing(await new Request(input, init).text());
				},
			},
		},
		AI: {
			configurable: true,
			enumerable: true,
			value: {
				fetch: async () => {
					const ports = observerPorts.get(ctx.id.toString());
					if (!ports) throw new Error("observer fixture ports absent");
					return ports.wire();
				},
			},
		},
		AZURE_OPENAI_RESOURCE: { value: "fixture", configurable: true },
		AZURE_OPENAI_API_VERSION: { value: "test", configurable: true },
		AZURE_CHAT_DEPLOYMENT: { value: "gpt-5.6-terra", configurable: true },
		AI_GATEWAY_ACCOUNT_ID: { value: "account", configurable: true },
		CF_AI_GATEWAY_TOKEN: { value: "fixture-token", configurable: true },
		AI_GATEWAY_LLM_ID: { value: "gateway", configurable: true },
		AI_GATEWAY_BINDING_PROVIDERS: {
			value: "workers-ai,azure-openai",
			configurable: true,
		},
		TEDIX_BILLING_SETTLEMENT_MODE: { value: "disabled", configurable: true },
		CHAT_TURN_WORKFLOW: {
			enumerable: true,
			configurable: true,
			writable: false,
			value: scripted,
		},
	}) as Cloudflare.Env;
}

/** Explicit test-only historical sample; does not qualify production jobs or descendants. */
export function seedRetirementFixture(
	ctx: DurableObjectState,
	runId = "retained-fiber",
	currentState?: unknown,
) {
	if (currentState !== undefined)
		ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO cf_agents_state(id,state) VALUES('cf_state_row_id',?)",
			JSON.stringify(currentState),
		);
	seedCustody(ctx);
	// Fixtures have no business lifecycle capabilities; remove only their setup housekeeping before archival.
	if (
		ctx.storage.sql
			.exec("SELECT name FROM sqlite_master WHERE name='cf_agents_jobs'")
			.toArray().length
	)
		ctx.storage.sql.exec("DELETE FROM cf_agents_jobs");
	ctx.storage.sql.exec(
		"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status) VALUES('retained-row','retained-provider','CHAT_TURN_WORKFLOW','queued')",
	);
	ctx.storage.sql.exec(
		"INSERT INTO cf_agents_fibers(fiber_id,idempotency_key,name,status,created_at) VALUES('retained-fiber','retained-key','retained','interrupted',123)",
	);
	ctx.storage.sql.exec(
		"INSERT INTO cf_agents_runs(id,name,snapshot,created_at) VALUES(?,'retained',?,123)",
		runId,
		JSON.stringify({ private: "unknown-original" }),
	);
	ctx.storage.kv.put("wfctx:retained-provider", {
		runId: "retained-original-run",
	});
	ctx.storage.kv.put("think-accounting:retained", {
		reservationId: "original-reservation",
		reserved: 123,
		measured: null,
		private: new Uint8Array([0, 255]),
	});
	const store = new HistoricalLiabilityCustody(ctx.storage, ctx.id.toString()),
		summary = store.inspectSnapshot({ expectedGeneration: 1 });
	store.captureSnapshot({
		expectedGeneration: 1,
		expectedSourceHash: summary.sourceHash,
	});
	return {
		operationId: "retire",
		expectedGeneration: 1,
		snapshotId: summary.snapshotId,
		sourceHash: summary.sourceHash,
	};
}
/** Positive constructor controls only: independently fabricated fixture authority is never product activation proof. */
export function releaseRetirementFixture(ctx: DurableObjectState) {
	const owner = {
		objectId: ctx.id.toString(),
		tediId: "native-tedi",
		orgId: "native-org",
	};
	const summary = new HistoricalLiabilityCustody(
		ctx.storage,
		owner.objectId,
	).audit();
	if (!summary) throw new Error("fixture archive absent");
	ctx.storage.kv.put("fixture:verified-retirement-release", {
		generation: 2,
		objectId: owner.objectId,
		snapshotId: summary.snapshotId,
		sourceHash: summary.sourceHash,
	});
	new RuntimeAdmission(ctx.storage, owner, () => ({
		owner,
		digest: "a".repeat(64),
		complete: true,
		unknown: 0,
		nonterminal: 0,
	})).release({
		operationId: "test-only-release",
		expectedGeneration: 1,
		evidence: "a".repeat(64),
	});
}
