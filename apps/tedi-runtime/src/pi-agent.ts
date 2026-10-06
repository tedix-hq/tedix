import {
	privateInferenceOriginGuard,
	inferenceOriginHash,
	type NativeRootProof,
} from "./runtime-inference-origin";
import { HistoricalExecutionGuard } from "./historical-execution-guard";
import type { FiberContext, StartFiberOptions, StartFiberResult } from "agents";
import type { ConfiguredConversationTurn } from "./conversation-facet";
import { workflowImageUri } from "./workflow-image-handoff";
import { finalReportInstruction } from "./facet-turn-stop";
import {
	RuntimeAdmissionDO,
	readStoredRuntimeAdmission,
	type FacetAdmissionCustody,
} from "./runtime-admission-do";
import { RawCutoverDO } from "./pi-cutover-maintenance-do";
import type { AdmissionOwner } from "./runtime-admission";
export type FacetAdmissionResponse =
	| { enabled: false; root?: NativeRootProof; custody?: FacetAdmissionCustody }
	| {
			enabled: true;
			root?: NativeRootProof;
			owner: AdmissionOwner;
			parentGeneration: number;
			principalId: string;
			custody: FacetAdmissionCustody;
	  };
class AdmittedPiHarness extends PiHarness {
	constructor(
		options: ConstructorParameters<typeof PiHarness>[0],
		private readonly defer: () => boolean,
	) {
		super(options);
	}
	override async onStart(context: Parameters<PiHarness["onStart"]>[0]) {
		if (this.defer()) return;
		await super.onStart(context);
	}
}
import { projectPiRecovery } from "./pi-recovery-diagnostic";
import { TediRuntimeRecoveryQuerySchema } from "@tedix/api-contract/schemas/tedi";
import type {
	AssistantMessage,
	ImageContent,
	JsonObject,
	Message,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
/**
 * Native Pi/Agents base. No Think cognition, no AI SDK loop.
 * Application subclasses register native extensions and a governed Models bridge.
 * Deliberately does not pretend Think's beforeStep/TurnConfig hooks are Pi hooks.
 */
import { Agent } from "agents";
import {
	assertLegacyThinkTasksSettled,
	assertLegacyThinkReceiptsSettled,
} from "./pi-parent-services";
import {
	Sessions,
	type SessionMessage,
	type SessionMessagePart,
} from "agents/sessions";
import { PiHarness } from "agents/harness/pi";
import {
	Harness,
	createRegistry,
	watchEvents,
	type AgentEvent,
	type UserInput,
	type AgentChange,
	type Conversation,
	type EntryId,
	type EntryRecord,
	type Extension,
	type HarnessSettings,
	type Registry,
} from "@earendil-works/pi-durable";
import type {
	ChatOptions,
	PiApplicationProjection,
	PiContext,
	PiSubmissionInspection,
} from "./pi-types";

function admissionJson(value: unknown): string | undefined {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
				)
			: item,
	);
}

const BACKGROUND: PiContext = {
	abortSignal: undefined,
	value: () => undefined,
	toString: () => "tedix-pi-background",
};

/** Read-only old Sessions are used solely for idempotent passive migration. */
export abstract class PiAgent<Env extends Cloudflare.Env, State> extends Agent<
	Env,
	State
> {
	protected readonly legacySessions = new Sessions();
	protected readonly piRegistry: Registry = createRegistry();
	private projectionReady?: PiApplicationProjection;
	private imported?: Promise<void>;
	private messageCache: SessionMessage[] = [];
	private readonly uiDisplays = new Map<number, SessionMessage>();
	protected abstract projection(): PiApplicationProjection;
	protected abstract piExtension(): Extension | Promise<Extension>;
	protected abstract piConfiguration(): AgentChange | Promise<AgentChange>;
	/** Settings must remain stable for one admitted turn; subclasses own that gate. */
	protected piSettings(): HarnessSettings {
		return {};
	}

	readonly piHarness = new AdmittedPiHarness(
		{
			harness: async ({ storage, context }) => {
				await this.assertFacetRuntimeDispatch();
				this.projectionReady = this.projection();
				this.piRegistry.install(await this.piExtension());
				return Harness.open(
					storage,
					{
						models: this.projectionReady.models(),
						registry: this.piRegistry,
						settings: this.piSettings(),
						onReport: (error) => console.error("[tedi.pi.extension]", error),
					},
					context,
				);
			},
		},
		() => this.deferFacetPiStartup(),
	);
	readonly session = new PiApplicationSession(this);

	constructor(ctx: DurableObjectState, env: Env) {
		const admission = readStoredRuntimeAdmission(
			ctx.storage,
			ctx.id.toString(),
		);
		if (admission && admission.state !== "active")
			return new RawCutoverDO(ctx, env) as unknown as PiAgent<Env, State>;
		const historical = new HistoricalExecutionGuard(
			ctx.storage,
			ctx.id.toString(),
		);
		if (historical.requiresRawStartup())
			return new RawCutoverDO(ctx, env) as unknown as PiAgent<Env, State>;
		assertLegacyThinkTasksSettled(ctx.storage);
		super(ctx, historical.environment(env));
		// Legacy storage goes first. PiHarness's onStart supplies durable wake/recovery.
		this.lifecycle.use(this.legacySessions).use(this.piHarness);
	}

	private historicalExecution(): HistoricalExecutionGuard {
		return new HistoricalExecutionGuard(
			this.ctx.storage,
			this.ctx.id.toString(),
		);
	}
	override async startFiber(
		name: string,
		fn: (ctx: FiberContext) => Promise<void>,
		options?: StartFiberOptions,
	): Promise<StartFiberResult> {
		const guard = this.historicalExecution();
		guard.startFiber(options?.fiberId, options?.idempotencyKey);
		return super.startFiber(
			name,
			guard.fiber(fn, options?.idempotencyKey),
			options,
		);
	}
	override runFiber<T>(
		name: string,
		fn: (ctx: FiberContext) => Promise<T>,
	): Promise<T> {
		return super.runFiber(name, this.historicalExecution().fiber(fn));
	}
	protected override async onBeforeFacetLifecycleAlarm(context: {
		action: "set" | "get" | "delete" | "wake";
		ownerPath: Array<{ className: string; name: string }>;
		identityName: string;
		time?: number;
	}): Promise<void> {
		const admission = readStoredRuntimeAdmission(
			this.ctx.storage,
			this.ctx.id.toString(),
		);
		if (admission && context.action !== "get" && admission.state !== "active")
			throw new Error("Facet lifecycle dispatch denied by original admission");
	}
	protected facetAdmissionClassName(): string | null {
		return null;
	}
	protected async facetAdmissionCustody(
		runId: string,
		sessionKey: string,
	): Promise<FacetAdmissionResponse> {
		const { AgentTediDO } = await import("./do");
		const parent = (await this.parentAgent(AgentTediDO)) as unknown as {
			getFacetAdmissionCustody(input: {
				className: string;
				name: string;
				objectId: string;
				runId: string;
				sessionKey: string;
			}): Promise<FacetAdmissionResponse>;
		};
		const name = this.ctx.storage.kv.get<unknown>("cf_agents_facet_name");
		if (typeof name !== "string" || !name)
			throw new Error("Facet admission has no stored registered identity");
		return parent.getFacetAdmissionCustody({
			className: this.facetAdmissionClassName()!,
			name,
			objectId: this.ctx.id.toString(),
			runId,
			sessionKey,
		});
	}
	private deferFacetPiStartup(): boolean {
		if (this.facetAdmissionClassName() === null) return false;
		const admission = readStoredRuntimeAdmission(
			this.ctx.storage,
			this.ctx.id.toString(),
		);
		if (!admission) return this.isNewEmptyFacet();
		const binding = this.ctx.storage.kv.get<{ operationId: string }>(
			"pi-admitted-operation:v1",
		);
		if (!binding) return false;
		const claim = new RuntimeAdmissionDO(
			this.ctx.storage,
			admission.owner,
		).gate.claim(binding.operationId);
		if (claim?.status !== "completed") return false;
		for (const { name } of this.ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table'",
			)
			.toArray()) {
			if (
				name === "pi_tasks" &&
				this.ctx.storage.sql
					.exec<{ n: number }>(
						"SELECT COUNT(*) AS n FROM pi_tasks WHERE status!='terminal'",
					)
					.toArray()[0]!.n
			)
				return false;
			if (
				name === "pi_submissions" &&
				this.ctx.storage.sql
					.exec<{ n: number }>(
						"SELECT COUNT(*) AS n FROM pi_submissions WHERE status NOT IN ('done','unanswered')",
					)
					.toArray()[0]!.n
			)
				return false;
		}
		return true;
	}
	private isNewEmptyFacet(): boolean {
		const tables = this.ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table'",
			)
			.toArray();
		for (const { name } of tables)
			if (
				name === "cf_agents_session_messages" ||
				name === "cf_agents_session_config" ||
				/^pi_(entries|conversations|tasks|submissions)$/.test(name)
			) {
				if (
					this.ctx.storage.sql
						.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`)
						.toArray()[0]!.n > 0
				)
					return false;
			}
		for (const [key] of this.ctx.storage.kv.list())
			if (
				key === "pi-facet-pending-submission" ||
				key === "facet-pending-submission" ||
				key.startsWith("think-accounting:") ||
				key.startsWith("pi-accounting:")
			)
				return false;
		return true;
	}
	private admissionAdapter?: RuntimeAdmissionDO;
	private admissionCustody?: FacetAdmissionCustody;
	private admissionRun?: {
		runId: string;
		operationId: string;
		sessionKey: string;
		parentGeneration: number;
		principalId: string;
	};
	/** Local wire authority only. Parent custody remains an awaited pre-dispatch check. */
	protected facetBeforeDispatch(): () => void {
		// Catalog selection also constructs adapters before a turn has been admitted.
		// Such an adapter may describe a model, but its wire must still refuse.
		try {
			return this.captureFacetBeforeDispatch();
		} catch (error) {
			return () => {
				throw error;
			};
		}
	}
	protected normalizedFacetWireConfiguration(
		configuration: Record<string, unknown>,
	): Record<string, unknown> {
		return configuration;
	}
	private inferenceRoot: NativeRootProof | undefined;
	private captureFacetBeforeDispatch(): () => void {
		const storage = this.ctx.storage,
			objectId = this.ctx.id.toString();
		const selected = readStoredRuntimeAdmission(storage, objectId);
		const journal = storage.kv.get<{
			runId: string;
			operationId: string;
			sessionKey: string;
		}>("pi-admitted-operation:v1");
		const journalPin = admissionJson(journal);
		const markers = () =>
			admissionJson([
				storage.kv.get("cf_agents_is_facet"),
				storage.kv.get("cf_agents_facet_name"),
				storage.kv.get("cf_agents_parent_path"),
				this.name,
			]);
		const markerPin = markers();
		if (selected || this.inferenceRoot) {
			const custody = this.admissionCustody;
			if (
				!custody ||
				custody.objectId !== objectId ||
				storage.kv.get("cf_agents_is_facet") !== true ||
				storage.kv.get("cf_agents_facet_name") !== custody.facetName ||
				admissionJson(storage.kv.get("cf_agents_parent_path")) !==
					admissionJson(custody.parentPath) ||
				this.name !== custody.facetName ||
				this.lifecycle.name !== custody.identityName
			)
				throw new Error("Facet wire lacks verified local facet custody");
		}
		const adapter = selected
			? new RuntimeAdmissionDO(storage, selected.owner)
			: null;
		if (
			adapter &&
			(!journal ||
				!journal.runId ||
				!journal.operationId ||
				!journal.sessionKey)
		)
			throw new Error("Facet wire has no original operation journal");
		const bindingPin = admissionJson(this.admissionRun);
		const accepted = adapter?.assertAcceptedTurnSync({
			runId: journal!.operationId,
		});
		const sourceRow = accepted
			? storage.sql
					.exec<{ input: string }>(
						"SELECT input FROM runtime_admission_identities WHERE run_id=?",
						accepted.runId,
					)
					.toArray()[0]
			: null;
		const source = sourceRow
			? (JSON.parse(sourceRow.input) as {
					parentRunId: string;
					parentGeneration: number;
					durableSubmissionId: string;
					configuration: Record<string, unknown>;
				})
			: null;
		if (
			accepted &&
			(!this.admissionRun ||
				this.admissionRun.operationId !== accepted.runId ||
				this.admissionRun.principalId !== accepted.principalId ||
				this.admissionRun.sessionKey !== accepted.sessionKey ||
				!source ||
				source.parentGeneration !== this.admissionRun.parentGeneration ||
				source.parentRunId !== this.admissionRun.runId ||
				source.parentRunId !== journal!.runId ||
				source.durableSubmissionId !== journal!.operationId ||
				accepted.sessionKey !== journal!.sessionKey ||
				!Number.isSafeInteger(source.parentGeneration) ||
				source.parentGeneration < 1 ||
				!source.configuration ||
				source.configuration.runId !== journal!.runId ||
				source.configuration.sessionKey !== journal!.sessionKey)
		)
			throw new Error("Facet wire original input and journal disagree");
		// Configuration defaults are normalized by the owning facet. Pin their actual
		// configured representation, while the accepted full input retains its original hash.
		if (
			source &&
			this.facetAdmissionClassName() === "SynthesisSessionFacet" &&
			!Object.hasOwn(source.configuration, "modelRef")
		)
			throw new Error("Synthesis wire original input has no model pin");
		const normalized = source
			? this.normalizedFacetWireConfiguration(source.configuration)
			: null;
		const keys = new Set([
			...Object.keys(normalized ?? {}),
			"runId",
			"sessionKey",
			"aigMetadata",
			"system",
			"modelRef",
			"observerModelRef",
			"observerDeployment",
			"adaptiveRouting",
			"generation",
			"maxOutputTokens",
			"reasoning",
			"maxSteps",
			"stableSystemPrefix",
			"promptCacheKey",
			"toolDescriptors",
			"turnMetadata",
		]);
		const configuration = (state: unknown) => {
			if (!state || typeof state !== "object" || Array.isArray(state))
				throw new Error("Facet wire configuration missing");
			const value = state as Record<string, unknown>;
			return admissionJson(
				Object.fromEntries([...keys].map((key) => [key, value[key]])),
			);
		};
		const configPin = configuration(this.state);
		if (
			normalized &&
			Object.entries(normalized).some(
				([key, value]) =>
					admissionJson((this.state as Record<string, unknown>)[key]) !==
					admissionJson(value),
			)
		)
			throw new Error("Facet wire state differs from accepted configuration");
		const rootPin = admissionJson(this.inferenceRoot);
		const recheck = () => {
			if (admissionJson(this.inferenceRoot) !== rootPin)
				throw new Error("Facet wire original root assertion changed");
			const current = readStoredRuntimeAdmission(storage, objectId);
			if (Boolean(current) !== Boolean(selected))
				throw new Error("Facet wire admission selection changed");
			if (
				markers() !== markerPin ||
				admissionJson(this.admissionRun) !== bindingPin ||
				admissionJson(storage.kv.get("pi-admitted-operation:v1")) !== journalPin
			)
				throw new Error("Facet wire original custody changed");
			const persisted = storage.sql
				.exec<{ state: string }>(
					"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
				)
				.toArray()[0];
			if (
				configuration(this.state) !== configPin ||
				!persisted ||
				configuration(JSON.parse(persisted.state)) !== configPin
			)
				throw new Error("Facet wire configuration changed");
			if (accepted && current) {
				if (
					admissionJson(current.owner) !== admissionJson(accepted.owner) ||
					storage.kv.get("cf_agents_is_facet") !== true
				)
					throw new Error("Facet wire owner changed");
				const state = this.state as {
					aigMetadata?: { orgId?: string; tediId?: string };
					runId?: string;
					sessionKey?: string;
				};
				if (
					state.aigMetadata?.orgId !== accepted.owner.orgId ||
					state.aigMetadata?.tediId !== accepted.owner.tediId ||
					state.runId !== source!.parentRunId ||
					state.sessionKey !== accepted.sessionKey
				)
					throw new Error("Facet wire tenant or run changed");
				adapter!.assertAcceptedTurnSync({
					runId: accepted.runId,
					expected: accepted,
				});
			}
			const guard = this.historicalExecution();
			guard.assertRun(accepted?.runId);
			if (journal?.runId && journal.runId !== accepted?.runId)
				guard.assertRun(journal.runId);
		};
		const root = this.inferenceRoot;
		// Test/non-parent hosts without original root evidence remain uncaptured, not fabricated.
		if (!root) return recheck;
		const metadata = (
			this.state as {
				aigMetadata?: { orgId?: unknown; tediId?: unknown } | null;
			}
		).aigMetadata;
		if (
			metadata &&
			(metadata.orgId !== root.owner.orgId ||
				metadata.tediId !== root.owner.tediId)
		)
			throw new Error("Facet configured tenant differs from original root");
		const facetName = storage.kv.get<string>("cf_agents_facet_name");
		const parentPath = storage.kv.get<
			Array<{ className: string; name: string }>
		>("cf_agents_parent_path");
		if (
			!facetName ||
			!Array.isArray(parentPath) ||
			!this.facetAdmissionClassName()
		)
			throw new Error("Facet origin lacks native path");
		const selectedOrigin = {
			generation: accepted?.generation ?? 0,
			owner: { orgId: root.owner.orgId, tediId: root.owner.tediId, objectId },
			className: this.facetAdmissionClassName()!,
			identityName: this.lifecycle.name,
			facetName,
			path: [
				...parentPath,
				{ className: this.facetAdmissionClassName()!, name: facetName },
			],
		};
		if (accepted) {
			if (!root.accepted || !source)
				throw new Error("Facet accepted origin lacks original root claim");
			return privateInferenceOriginGuard(
				{
					kind: "accepted_native",
					root: { ...root, accepted: root.accepted },
					selected: { ...selectedOrigin, accepted },
					operation: {
						parentRunId: source.parentRunId,
						operationId: accepted.runId,
						sessionKey: accepted.sessionKey,
						parentGeneration: source.parentGeneration,
					},
					configurationHash: inferenceOriginHash(normalized),
				},
				recheck,
				sourceRow!.input,
			);
		}
		if (root.accepted)
			throw new Error("Unselected facet cannot assert accepted root");
		return privateInferenceOriginGuard(
			{
				kind: "unselected_native",
				root,
				selected: selectedOrigin,
				configurationHash: inferenceOriginHash(configuration(this.state)),
			},
			recheck,
		);
	}
	protected async prepareFacetRuntimeAdmission(input: {
		runId: string;
		sessionKey: string;
		configuration: unknown;
	}): Promise<boolean> {
		if (this.facetAdmissionClassName() === null) return false;
		const response = await this.facetAdmissionCustody(
			input.runId,
			input.sessionKey,
		);
		this.inferenceRoot = response.root
			? structuredClone(response.root)
			: undefined;
		if (response?.enabled === false) {
			if (response.root && !response.custody)
				throw new Error("Unselected facet lacks native custody");
			this.admissionCustody = response.custody
				? structuredClone(response.custody)
				: undefined;
			if (readStoredRuntimeAdmission(this.ctx.storage, this.ctx.id.toString()))
				throw new Error("Admitted facet cannot revert to unselected rollout");
			return false;
		}
		if (
			!response ||
			response.enabled !== true ||
			response.owner.objectId !== this.ctx.id.toString() ||
			!Number.isSafeInteger(response.parentGeneration) ||
			response.parentGeneration < 1 ||
			typeof response.principalId !== "string" ||
			!response.principalId
		)
			throw new Error("Facet admission custody invalid");
		const configurationOwner = input.configuration as {
			aigMetadata?: { tediId?: string; orgId?: string };
		};
		if (
			configurationOwner.aigMetadata?.tediId !== response.owner.tediId ||
			configurationOwner.aigMetadata?.orgId !== response.owner.orgId
		)
			throw new Error("Facet configuration tenant changed");
		if (!input.runId || !input.sessionKey)
			throw new Error("Facet configuration has no accepted run/session");
		const adapter = new RuntimeAdmissionDO(
			this.ctx.storage,
			response.owner,
			response.custody,
		);
		if (!adapter.read()) {
			if (!this.isNewEmptyFacet())
				throw new Error(
					"Existing facet requires explicit state cutover before activation",
				);
			const cfg = input.configuration as {
				aigMetadata?: { tediId?: string; orgId?: string };
			};
			if (
				cfg.aigMetadata?.tediId !== response.owner.tediId ||
				cfg.aigMetadata?.orgId !== response.owner.orgId
			)
				throw new Error("Facet configuration tenant changed");
			this.setState({ ...this.state, ...(input.configuration as object) });
			adapter.gate.initialize({
				operationId: "native-empty-facet-bootstrap",
				state: "active",
				evidence: await adapter.prepareEvidence("initialize"),
			});
		}
		if (adapter.read()?.state !== "active")
			throw new Error("Facet admission inactive");
		const previous = this.ctx.storage.kv.get<{ operationId: string }>(
			"pi-admitted-operation:v1",
		);
		if (previous) {
			const claim = adapter.gate.claim(previous.operationId);
			if (!claim) throw new Error("Facet operation custody missing");
			if (claim.status !== "completed") {
				const record = this.ctx.storage.sql
					.exec<{ input: string }>(
						"SELECT input FROM runtime_admission_identities WHERE run_id=?",
						previous.operationId,
					)
					.toArray()[0];
				if (
					!record ||
					admissionJson(JSON.parse(record.input).configuration) !==
						admissionJson(input.configuration)
				)
					throw new Error("Unresolved facet configuration cannot change");
			}
		}
		this.admissionCustody = structuredClone(response.custody);
		this.admissionAdapter = adapter;
		this.admissionRun = {
			runId: input.runId,
			operationId:
				this.ctx.storage.kv.get<{ operationId: string }>(
					"pi-admitted-operation:v1",
				)?.operationId ?? input.runId,
			sessionKey: input.sessionKey,
			parentGeneration: response.parentGeneration,
			principalId: response.principalId,
		};
		return true;
	}
	protected async acceptFacetRuntimeTurn(input: {
		runId: string;
		sessionKey: string;
		configuration: unknown;
		input: unknown;
		operationId: string;
	}): Promise<boolean> {
		const storedAdmission = readStoredRuntimeAdmission(
			this.ctx.storage,
			this.ctx.id.toString(),
		);
		const prior = this.ctx.storage.kv.get<{
			runId: string;
			operationId: string;
		}>("pi-admitted-operation:v1");
		if (storedAdmission && prior && prior.operationId !== input.operationId) {
			const old = new RuntimeAdmissionDO(
				this.ctx.storage,
				storedAdmission.owner,
			).gate.claim(prior.operationId);
			if (!old || old.status !== "completed")
				throw new Error("Prior facet operation remains unresolved");
		}
		if (!(await this.prepareFacetRuntimeAdmission(input))) return false;
		const adapter = this.admissionAdapter!,
			binding = this.admissionRun!;
		const admitted = await adapter.beginAcceptedTurn({
			runId: input.operationId,
			sessionKey: input.sessionKey,
			principalId: binding.principalId,
			input: JSON.parse(
				JSON.stringify({
					parentGeneration: binding.parentGeneration,
					parentRunId: input.runId,
					durableSubmissionId: input.operationId,
					configuration: input.configuration,
					turn: input.input,
				}),
			),
			expectedGeneration: adapter.read()!.generation,
		});
		this.admissionRun!.operationId = input.operationId;
		this.ctx.storage.kv.put("pi-admitted-operation:v1", {
			runId: input.runId,
			operationId: input.operationId,
			sessionKey: input.sessionKey,
		});
		if (admitted.claim.status !== "completed")
			await this.assertFacetRuntimeDispatch();
		return true;
	}
	protected async assertFacetRuntimeDispatch(): Promise<void> {
		if (this.facetAdmissionClassName() === null) return;
		const state = this.state as {
			runId?: string | null;
			sessionKey?: string | null;
		};
		const saved = this.ctx.storage.kv.get<{
			runId: string;
			operationId: string;
			sessionKey: string;
		}>("pi-admitted-operation:v1");
		const runId = this.admissionRun?.runId ?? saved?.runId ?? state.runId,
			sessionKey =
				this.admissionRun?.sessionKey ?? saved?.sessionKey ?? state.sessionKey;
		const initialResponse = await this.facetAdmissionCustody(
			runId ?? "",
			sessionKey ?? "",
		);
		if (initialResponse?.enabled === false) {
			if (readStoredRuntimeAdmission(this.ctx.storage, this.ctx.id.toString()))
				throw new Error("Admitted facet cannot revert to unselected rollout");
			return;
		}
		if (!runId || !sessionKey)
			throw new Error("Facet runtime dispatch has no accepted run/session");
		if (!this.admissionAdapter)
			await this.prepareFacetRuntimeAdmission({
				runId,
				sessionKey,
				configuration: saved?.operationId
					? JSON.parse(
							this.ctx.storage.sql
								.exec<{ input: string }>(
									"SELECT input FROM runtime_admission_identities WHERE run_id=?",
									saved.operationId,
								)
								.toArray()[0]?.input ?? "null",
						)?.configuration
					: this.state,
			});
		if (!this.admissionAdapter) return;
		const response = await this.facetAdmissionCustody(runId, sessionKey);
		if (!response || response.enabled !== true)
			throw new Error("Admitted facet lost parent custody");
		if (admissionJson(response.root) !== admissionJson(this.inferenceRoot))
			throw new Error("Facet original root custody changed");
		const operationId = this.admissionRun?.operationId ?? saved?.operationId;
		if (!operationId) throw new Error("Facet native operation custody missing");
		await this.admissionAdapter.assertAcceptedTurn({
			runId: operationId,
			sessionKey,
			principalId: response.principalId,
		});
		const accepted =
			await this.admissionAdapter.lookupAcceptedTurn(operationId);
		const raw = this.ctx.storage.sql
			.exec<{ input: string }>(
				"SELECT input FROM runtime_admission_identities WHERE run_id=?",
				operationId,
			)
			.toArray()[0];
		const persisted = raw
			? (JSON.parse(raw.input) as {
					parentGeneration?: number;
					parentRunId?: string;
				})
			: null;
		if (
			!persisted ||
			persisted.parentGeneration !== response.parentGeneration ||
			persisted.parentRunId !== runId ||
			accepted.owner.tediId !== response.owner.tediId ||
			accepted.owner.orgId !== response.owner.orgId
		)
			throw new Error("Facet parent generation or owner changed");
		this.admissionCustody = structuredClone(response.custody);
	}
	protected facetReceiptOperation(): string | undefined {
		return (
			this.admissionRun?.operationId ??
			this.ctx.storage.kv.get<{ operationId: string }>(
				"pi-admitted-operation:v1",
			)?.operationId
		);
	}
	protected async assertFacetOriginalReceipt(
		runId: string,
		originalOperationId?: string,
	): Promise<void> {
		if (this.facetAdmissionClassName() === null) return;
		if (!this.admissionAdapter) {
			const stored = readStoredRuntimeAdmission(
				this.ctx.storage,
				this.ctx.id.toString(),
			);
			if (!stored) return;
			throw new Error("Original facet receipt custody unavailable");
		}
		const saved = this.ctx.storage.kv.get<{
			runId: string;
			operationId: string;
		}>("pi-admitted-operation:v1");
		const operationId =
			originalOperationId ??
			(saved?.runId === runId ? saved.operationId : runId);
		await this.admissionAdapter.assertOriginalClaim({ runId: operationId });
	}
	protected async completeFacetRuntimeTurn(
		runId: string,
		sourceId: string,
		receipt: unknown,
	): Promise<void> {
		if (!this.admissionAdapter) return;
		const accepted = await this.admissionAdapter.lookupAcceptedTurn(sourceId);
		await this.admissionAdapter.recordTerminalReceipt(sourceId, {
			sourceId,
			receipt,
		});
		const claim = {
			turnId: sourceId,
			requestHash: accepted.requestHash,
			generation: accepted.generation,
			submissionId: sourceId,
		};
		this.admissionAdapter.gate.completeTurn({
			...claim,
			evidence: await this.admissionAdapter.prepareEvidence("complete", claim),
		});
	}

	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === "/__admin/pi-state-cutover") {
			const admin = (await import("./pi-cutover-admin")) as unknown as {
				operateStoredCutover(input: {
					ctx: DurableObjectState;
					env: Cloudflare.Env;
					request: Request;
				}): Promise<Response>;
			};
			if (typeof admin.operateStoredCutover !== "function")
				throw new Error("Passive cutover operator unavailable");
			return admin.operateStoredCutover({
				ctx: this.ctx,
				env: this.env,
				request,
			});
		}
		return super.fetch(request);
	}
	get messages(): SessionMessage[] {
		return this.messageCache;
	}
	protected get appProjection(): PiApplicationProjection {
		return (this.projectionReady ??= this.projection());
	}

	/** All new/recovered cognition remains owned by PiHarness's native task graph. */
	async nativePiSession() {
		return this.piHarness.session(
			String(
				(await this.ctx.storage.get<number>("pi-active-conversation-id:v1")) ??
					1,
			),
		);
	}

	/** Native inspection is read-only; waking this existing Agent still runs its normal lifecycle. */
	async inspectRecovery(sessionKey: string, operationId?: string) {
		TediRuntimeRecoveryQuerySchema.parse({ sessionKey, operationId });
		if ((this.state as { sessionKey?: unknown }).sessionKey !== sessionKey)
			throw new Error("pi_recovery_session_mismatch");
		let conversationId =
			(await this.ctx.storage.get<number>("pi-active-conversation-id:v1")) ?? 1;
		if (operationId !== undefined) {
			const owner = await this.ctx.storage.get<number>(
				`pi-operation-conversation:${operationId}`,
			);
			if (owner === undefined)
				throw new Error("pi_recovery_operation_unavailable");
			conversationId = owner;
		}
		const pi = await this.piHarness.pi();
		if (
			!(await pi.conversation(
				conversationId as Parameters<typeof pi.conversation>[0],
				BACKGROUND,
			))
		)
			throw new Error("pi_recovery_conversation_unavailable");
		const operation =
			operationId === undefined
				? undefined
				: await (
						await this.piHarness.storage()
					).submissionByRequest(
						conversationId as Parameters<typeof pi.conversation>[0],
						operationId,
						BACKGROUND,
					);
		if (
			operationId !== undefined &&
			(!operation ||
				operation.requestId !== operationId ||
				operation.conversationId !== conversationId)
		)
			throw new Error("pi_recovery_operation_mismatch");
		return projectPiRecovery({
			sessionKey,
			conversationId,
			inspection: await pi.inspect(BACKGROUND),
			operation,
		});
	}

	async nativeEvents() {
		return watchEvents(
			await this.piHarness.pi(),
			(await this.nativeConversation()).id,
			BACKGROUND,
		);
	}

	async nativeConversation(): Promise<Conversation> {
		const pi = await this.piHarness.pi();
		const id =
			(await this.ctx.storage.get<number>("pi-active-conversation-id:v1")) ?? 1;
		const conversation = await pi.conversation(
			id as Parameters<typeof pi.conversation>[0],
			BACKGROUND,
		);
		if (!conversation) throw new Error("Pi root conversation missing");
		return conversation;
	}

	/**
	 * Import old active-branch rows as passive entries, never as user submissions.
	 * Each old row has a stable request id. Pi dedup handles crash between import
	 * and marker. Original tables remain readable until retention is decided.
	 */
	async importLegacyHistory(): Promise<void> {
		if (readStoredRuntimeAdmission(this.ctx.storage, this.ctx.id.toString())) {
			await this.refreshMessages();
			return;
		}
		return (this.imported ??= this.performLegacyImport().catch((error) => {
			this.imported = undefined;
			throw error;
		}));
	}
	private async performLegacyImport(): Promise<void> {
		await assertLegacyThinkReceiptsSettled(this.ctx.storage);
		if (await this.ctx.storage.get<boolean>("pi:legacy-imported:v1")) {
			await this.refreshMessages();
			return;
		}
		await this.assertLegacySubmissionsSettled();
		const conversation = await this.nativeConversation();
		if ((await conversation.context(BACKGROUND)).entries.length !== 0) {
			// Unmarked Pi data is only acceptable when it consists of this migration.
			// Mixing unrelated Pi data and legacy history could splice conversations.
			const entries = (await conversation.context(BACKGROUND)).entries;
			if (entries.some((entry) => entry.kind !== "tedix.legacy-message")) {
				throw new Error(
					"Unmarked Pi transcript contains non-migration entries",
				);
			}
		}
		for await (const message of this.legacySessions.session().history()) {
			const model = await this.appProjection.legacy(message);
			if (!model?.length)
				throw new Error(
					`Legacy message has no preserved model projection: ${message.id}`,
				);
			const admitted = await conversation.submit(
				{
					type: "write",
					requestId: `tedix:legacy:v1:${message.id}`,
					entry: {
						kind: "tedix.legacy-message",
						model,
						data: { originalId: message.id, originalRole: message.role },
					},
				},
				BACKGROUND,
			);
			const settled = await admitted.wait(BACKGROUND);
			if (settled.status !== "done")
				throw new Error(`Legacy import failed: ${message.id}`);
			if (settled.type !== "write")
				throw new Error("Passive legacy import returned cognitive input");
			await this.ctx.storage.put(`pi-ui-entry:${settled.entry}`, message);
			this.uiDisplays.set(settled.entry, message);
		}
		await this.ctx.storage.put("pi:legacy-imported:v1", true);
		await this.refreshMessages();
	}

	private async assertLegacySubmissionsSettled(): Promise<void> {
		const tables = [
			...this.ctx.storage.sql.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_think_submissions'",
			),
		];
		if (tables.length !== 0) {
			const unsettled = [
				...this.ctx.storage.sql.exec<{ submission_id: string }>(
					"SELECT submission_id FROM cf_think_submissions WHERE status NOT IN ('completed','aborted','skipped','error') LIMIT 1",
				),
			];
			if (unsettled.length !== 0)
				throw new Error(
					"Pending Think submission prevents Pi transcript migration",
				);
		}
		if (await this.ctx.storage.get("facet-pending-submission")) {
			throw new Error(
				"Pending Think facet receipt requires reconciliation before Pi migration",
			);
		}
	}

	async forkForRegeneration(operationId: string): Promise<void> {
		const pi = await this.piHarness.pi();
		const sourceId = await this.ctx.storage.get<number>(
			`pi-operation-conversation:${operationId}`,
		);
		if (sourceId === undefined)
			throw new Error(
				"Regeneration original operation has no native conversation owner",
			);
		const source = await pi.conversation(
			sourceId as Parameters<typeof pi.conversation>[0],
			BACKGROUND,
		);
		if (!source) throw new Error("Regeneration original conversation missing");
		const original = await (
			await this.piHarness.storage()
		).submissionByRequest(source.id, operationId, BACKGROUND);
		if (!original || original.type !== "input" || original.status !== "done")
			throw new Error(
				"Regeneration requires an exact completed input submission",
			);
		const entries = await source.entries(
			{ maxEntryId: original.entry },
			2,
			undefined,
			BACKGROUND,
		);
		const previous = entries.items.find((entry) => entry.id < original.entry);
		const branch = previous
			? await source.fork(
					previous.id,
					{ ownership: { kind: "ownerless" } },
					BACKGROUND,
				)
			: await pi.createConversation(
					{ ownership: { kind: "ownerless" } },
					BACKGROUND,
				);
		await this.ctx.storage.put("pi-active-conversation-id:v1", branch.id);
		await this.onPiMessagesCleared();
		await this.refreshMessages();
	}
	async registerOriginalUiMessage(
		operationId: string,
		message: SessionMessage,
	): Promise<void> {
		if (message.role !== "user")
			throw new Error("Original UI display must be a user message");
		const key = `pi-ui-operation:${operationId}`;
		const prior = await this.ctx.storage.get<SessionMessage>(key);
		if (prior && JSON.stringify(prior) !== JSON.stringify(message))
			throw new Error("Original UI message changed for admitted operation");
		if (!prior) await this.ctx.storage.put(key, message);
	}
	async retainSubmissionDisplay(operationId: string): Promise<void> {
		const original = await this.ctx.storage.get<SessionMessage>(
			`pi-ui-operation:${operationId}`,
		);
		if (!original) return;
		const stored = await (
			await this.piHarness.storage()
		).submissionByRequest(
			(await this.nativeConversation()).id,
			operationId,
			BACKGROUND,
		);
		if (!stored || stored.type !== "input" || stored.entry === undefined)
			return;
		await this.ctx.storage.put(`pi-ui-entry:${stored.entry}`, original);
		this.uiDisplays.set(stored.entry, original);
	}
	projectDisplayMessage(entry: EntryRecord): SessionMessage | null {
		return this.uiDisplays.get(entry.id) ?? entrySessionMessage(entry);
	}
	async clearHistory(): Promise<void> {
		await this.session.clearMessages();
	}

	async historyMessages(): Promise<SessionMessage[]> {
		await this.importLegacyHistory();
		await this.refreshMessages();
		return [...this.messageCache];
	}

	async refreshMessages(): Promise<void> {
		const entries = await (await this.nativePiSession()).messages();
		for (const entry of entries) {
			const display = await this.ctx.storage.get<SessionMessage>(
				`pi-ui-entry:${entry.id}`,
			);
			if (display) this.uiDisplays.set(entry.id, display);
		}
		const results = new Map<string, ToolResultMessage>();
		for (const entry of entries)
			for (const message of entry.model ?? [])
				if (message.role === "toolResult")
					results.set(message.toolCallId, message);
		this.messageCache = entries.flatMap((entry) => {
			const message = this.appProjection.message(entry);
			if (!message) return [];
			if (this.uiDisplays.has(entry.id)) return [message];
			return [
				{
					...message,
					parts: message.parts.map((part) => {
						const result = part.toolCallId
							? results.get(part.toolCallId)
							: undefined;
						return result
							? {
									...part,
									state: result.isError ? "output-error" : "output-available",
									output: result.content,
								}
							: part;
					}),
				},
			];
		});
	}

	/** Call under the existing facet's configuration gate, before submit. */
	async configurePiTurn(): Promise<void> {
		await this.importLegacyHistory();
		if (!(await this.waitUntilStable({ timeout: 30_000 }))) {
			throw new Error(
				"Pi conversation has unfinished work; configuration denied",
			);
		}
		this.piRegistry.install(await this.piExtension());
		await (
			await this.nativeConversation()
		).configure(await this.piConfiguration(), BACKGROUND);
	}

	private async assertConfiguredSubmission(
		operationId: string,
		message: SessionMessage,
	): Promise<void> {
		if (!this.admissionAdapter) return;
		const binding = this.ctx.storage.kv.get<{ operationId: string }>(
			"pi-admitted-operation:v1",
		);
		if (!binding) throw new Error("Native input has no accepted operation");
		const accepted = await this.admissionAdapter.lookupAcceptedTurn(
			binding.operationId,
		);
		const row = this.ctx.storage.sql
			.exec<{ input: string }>(
				"SELECT input FROM runtime_admission_identities WHERE run_id=?",
				binding.operationId,
			)
			.toArray()[0];
		if (!row) throw new Error("Native input has no immutable accepted payload");
		const source = JSON.parse(row.input) as {
			parentRunId: string;
			configuration: ConfiguredConversationTurn["configuration"];
			turn: ConfiguredConversationTurn;
		};
		const pending = await this.ctx.storage.get<{
			submissionId: string;
			configuration: ConfiguredConversationTurn["configuration"];
			turnInput: Pick<
				ConfiguredConversationTurn,
				"text" | "images" | "imageRefs"
			>;
		}>("pi-facet-pending-submission");
		const equal = (a: unknown, b: unknown) =>
			admissionJson(a) === admissionJson(b);
		if (
			!pending ||
			pending.submissionId !== binding.operationId ||
			pending.configuration.runId !== source.parentRunId ||
			pending.configuration.sessionKey !== accepted.sessionKey ||
			!equal(pending.configuration, source.configuration) ||
			![source.turn.text, source.turn.firstTurnText].includes(
				pending.turnInput.text,
			) ||
			!equal(pending.turnInput.images, source.turn.images) ||
			!equal(pending.turnInput.imageRefs, source.turn.imageRefs)
		)
			throw new Error("Native input changed accepted configuration or payload");
		let parts: SessionMessagePart[];
		if (operationId === binding.operationId) {
			parts = [
				{ type: "text", text: pending.turnInput.text },
				...(pending.turnInput.images ?? []).map((image) => ({
					type: "file" as const,
					mediaType: image.mediaType,
					filename: image.fileName,
					url:
						image.kind === "url"
							? image.data
							: `data:${image.mediaType};base64,${image.data}`,
				})),
				...(pending.turnInput.imageRefs ?? []).map((ref) => ({
					type: "file" as const,
					mediaType: ref.mediaType,
					filename: ref.fileName,
					url: workflowImageUri(ref),
				})),
			];
		} else if (operationId === `${binding.operationId}:final-report`) {
			const stop = (
				this.state as { finalReportStop?: { reason: string } | null }
			).finalReportStop;
			if (!stop?.reason)
				throw new Error("Native final report has no owned stop");
			parts = [{ type: "text", text: finalReportInstruction(stop.reason) }];
		} else
			throw new Error("Native submission is outside the accepted operation");
		if (
			message.id !== `${operationId}:user` ||
			message.role !== "user" ||
			!equal(message.parts, parts)
		)
			throw new Error("Native submitted message changed accepted input");
	}

	async submitMessages(
		messages: readonly SessionMessage[],
		options: ChatOptions & { submissionId?: string } = {},
	): Promise<{ submissionId: string }> {
		await this.assertFacetRuntimeDispatch();
		await assertLegacyThinkReceiptsSettled(this.ctx.storage);
		// Existing durable facet callers submit exactly one user row per operation.
		if (messages.length !== 1 || messages[0]?.role !== "user") {
			throw new Error("Pi submission requires exactly one user message");
		}
		const operationId =
			options.submissionId ?? options.requestId ?? messages[0].id;
		await this.assertConfiguredSubmission(operationId, messages[0]);
		await this.importLegacyHistory();
		await this.ctx.storage.put(
			`pi-operation-conversation:${operationId}`,
			(await this.nativeConversation()).id,
		);
		const receipt = await (
			await this.nativePiSession()
		).submit(await this.appProjection.input(messages[0]), { operationId });
		return { submissionId: receipt.operationId };
	}

	async waitForSubmission(
		submissionId: string,
	): Promise<PiSubmissionInspection> {
		// PiHarness wait validates session ownership; it never selects latest answer.
		const terminal = await (await this.nativePiSession()).wait(submissionId);
		await this.retainSubmissionDisplay(submissionId);
		await this.refreshMessages();
		const storage = await this.piHarness.storage();
		const conversation = await this.nativeConversation();
		const stored = await storage.submissionByRequest(
			conversation.id,
			submissionId,
			BACKGROUND,
		);
		if (terminal.status !== "done") {
			return {
				submissionId,
				status: "failed",
				error:
					stored && "detail" in stored && typeof stored.detail === "string"
						? stored.detail
						: terminal.reason,
			};
		}
		if (
			!stored ||
			stored.status !== "done" ||
			stored.type !== "input" ||
			stored.answer === undefined
		) {
			throw new Error("Settled Pi input has no owned assistant entry");
		}
		const answer = await this.entryById(stored.answer);
		const message = answer && this.appProjection.message(answer);
		if (!message || message.role !== "assistant")
			throw new Error("Pi answer is not an assistant entry");
		return { submissionId, status: "completed", messageId: message.id };
	}

	async cancelPiTurn(): Promise<void> {
		await (await this.nativePiSession()).abort();
	}
	async waitUntilStable(options: { timeout: number }): Promise<boolean> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), options.timeout);
		try {
			await (
				await this.nativeConversation()
			).waitForIdle({
				...BACKGROUND,
				abortSignal: controller.signal,
			});
			return true;
		} catch (error) {
			if (controller.signal.aborted) return false;
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
	async entryById(id: EntryId): Promise<EntryRecord | undefined> {
		const page = await (
			await this.nativeConversation()
		).entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND);
		return page.items[0];
	}
	async onPiMessagesCleared(): Promise<void> {}
}

/** Passive transcript facade, backed by Pi entries rather than a second writer. */
export class PiApplicationSession {
	constructor(
		private readonly agent: Pick<
			PiAgent<Cloudflare.Env, unknown>,
			| "refreshMessages"
			| "messages"
			| "importLegacyHistory"
			| "waitUntilStable"
			| "piHarness"
			| "onPiMessagesCleared"
			| "nativePiSession"
		>,
	) {}
	async getMessage(id: string): Promise<SessionMessage | null> {
		await this.agent.refreshMessages();
		return this.agent.messages.find((message) => message.id === id) ?? null;
	}
	async clearMessages(): Promise<void> {
		await this.agent.importLegacyHistory();
		if (!(await this.agent.waitUntilStable({ timeout: 30_000 })))
			throw new Error("Cannot reset active Pi conversation");
		await (await this.agent.nativePiSession()).reset();
		await this.agent.onPiMessagesCleared();
		await this.agent.refreshMessages();
	}
}

function jsonObject(input: unknown): JsonObject {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Legacy tool arguments are not an object");
	// Round-trip rejects cycles, bigint, and values that cannot enter Pi's durable state.
	const encoded = JSON.stringify(input);
	if (!encoded) throw new Error("Legacy tool arguments are not JSON");
	return JSON.parse(encoded) as JsonObject;
}
function text(input: unknown): string {
	if (typeof input === "string") return input;
	const encoded = JSON.stringify(input);
	if (encoded === undefined)
		throw new Error("Legacy tool result has no serializable value");
	return encoded;
}
function image(part: SessionMessagePart): ImageContent {
	if (!part.url || !part.mediaType?.startsWith("image/"))
		throw new Error("Unsupported legacy file media type");
	const separator = part.url.indexOf(",");
	if (
		!part.url.startsWith("data:") ||
		separator < 0 ||
		!part.url.slice(0, separator).endsWith(";base64")
	) {
		throw new Error("Legacy image requires materialized base64 data URL");
	}
	return {
		type: "image",
		mimeType: part.mediaType,
		data: part.url.slice(separator + 1),
	};
}
/** Context-only imported usage, never sent to accounting. Original metadata stays in legacy storage. */
const importedUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function timestamp(message: SessionMessage): number {
	return message.createdAt?.getTime() ?? 0;
}
export function sessionUserInput(message: string | SessionMessage): UserInput {
	if (typeof message === "string") return message;
	if (message.role !== "user")
		throw new Error("Pi input projection requires a user message");
	const result: (TextContent | ImageContent)[] = [];
	for (const part of message.parts) {
		if (part.type === "text" && typeof part.text === "string")
			result.push({ type: "text", text: part.text });
		else if (part.type === "file") result.push(image(part));
		else if (part.type !== "step-start")
			throw new Error(`Unsupported user part: ${part.type}`);
	}
	if (!result.length) throw new Error("User message has no model input");
	return result;
}

/** Passive import. Tool results are contributed after their owning assistant call. */
export function legacySessionMessages(
	message: SessionMessage,
): readonly Message[] {
	const at = timestamp(message);
	if (message.role === "user")
		return [
			{ role: "user", content: sessionUserInput(message), timestamp: at },
		];
	if (message.role === "system") {
		if (message.parts.some((part) => part.type !== "text"))
			throw new Error("Unsupported legacy system part");
		return [
			{
				role: "system",
				content: message.parts.map((part) => part.text ?? "").join("\n"),
				timestamp: at,
			},
		];
	}
	if (message.role !== "assistant")
		throw new Error(`Unsupported legacy role: ${message.role}`);
	const content: AssistantMessage["content"] = [];
	const outputs: ToolResultMessage[] = [];
	for (const part of message.parts) {
		if (part.type === "step-start") continue;
		if (part.type === "text" && typeof part.text === "string")
			content.push({ type: "text", text: part.text });
		else if (part.type === "reasoning")
			content.push({
				type: "thinking",
				thinking: part.text ?? part.reasoning ?? "",
			});
		else if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
			const name =
				part.toolName ??
				(part.type.startsWith("tool-") ? part.type.slice(5) : undefined);
			if (!name || !part.toolCallId)
				throw new Error("Legacy tool part has no stable call identity");
			if (part.state !== "output-available" && part.state !== "output-error") {
				throw new Error(
					`Unsettled legacy tool prevents Pi import: ${part.toolCallId}`,
				);
			}
			content.push({
				type: "toolCall",
				id: part.toolCallId,
				name,
				arguments: jsonObject(part.input),
			});
			outputs.push({
				role: "toolResult",
				toolCallId: part.toolCallId,
				toolName: name,
				content: [{ type: "text", text: text(part.output ?? part.result) }],
				isError: part.state === "output-error",
				timestamp: at,
			});
		} else throw new Error(`Unsupported legacy assistant part: ${part.type}`);
	}
	// An empty legacy turn (e.g. only step markers from a failed reply) carries
	// nothing for the model; failing here would lock the conversation forever.
	if (!content.length) return [];
	return [
		{
			role: "assistant",
			content,
			api: "tedix",
			provider: "tedix",
			model: "legacy-context",
			usage: importedUsage,
			stopReason: outputs.length ? "toolUse" : "stop",
			timestamp: at,
		},
		...outputs,
	];
}

export function entrySessionMessage(entry: EntryRecord): SessionMessage | null {
	const messages = entry.model;
	if (!messages?.length) return null;
	const original =
		entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
			? entry.data.originalId
			: undefined;
	const id = typeof original === "string" ? original : String(entry.id);
	const parts: SessionMessagePart[] = [];
	const first = messages[0];
	if (!first) return null;
	if (first.role === "system")
		return {
			id,
			role: "system",
			parts: [
				{
					type: "text",
					text:
						typeof first.content === "string"
							? first.content
							: first.content.map((part) => part.text).join(""),
				},
			],
			createdAt: new Date(first.timestamp),
		};
	if (first.role === "user") {
		const content =
			typeof first.content === "string"
				? [{ type: "text" as const, text: first.content }]
				: first.content;
		for (const part of content)
			parts.push(
				part.type === "text"
					? { type: "text", text: part.text }
					: {
							type: "file",
							mediaType: part.mimeType,
							url: `data:${part.mimeType};base64,${part.data}`,
						},
			);
		return { id, role: "user", parts, createdAt: new Date(first.timestamp) };
	}
	if (first.role === "toolResult") return null; // already attached to its assistant tool part below when available
	for (const part of first.content) {
		if (part.type === "text") parts.push({ type: "text", text: part.text });
		else if (part.type === "thinking")
			parts.push({ type: "reasoning", text: part.thinking });
		else {
			const result = messages.find(
				(message): message is ToolResultMessage =>
					message.role === "toolResult" && message.toolCallId === part.id,
			);
			parts.push({
				type: "dynamic-tool",
				toolName: part.name,
				toolCallId: part.id,
				input: part.arguments,
				state: result
					? result.isError
						? "output-error"
						: "output-available"
					: "input-available",
				...(result ? { output: result.content } : {}),
			});
		}
	}
	return { id, role: "assistant", parts, createdAt: new Date(first.timestamp) };
}

/** UI SDK transport frames; native terminal receipt remains the sole completion authority. */
export function piEventFrames(
	event: AgentEvent,
): readonly Record<string, unknown>[] {
	switch (event.type) {
		case "message_start":
			return event.message.role === "assistant" ? [{ type: "start-step" }] : [];
		case "message_update":
			return event.changes.flatMap<Record<string, unknown>>((change) => {
				const id = "contentIndex" in change ? String(change.contentIndex) : "";
				if (change.type === "text_start") return [{ type: "text-start", id }];
				if (change.type === "text_delta")
					return [{ type: "text-delta", id, delta: change.delta }];
				if (change.type === "thinking_start")
					return [{ type: "reasoning-start", id }];
				if (change.type === "thinking_delta")
					return [{ type: "reasoning-delta", id, delta: change.delta }];
				if (
					change.type === "toolcall_start" &&
					change.block.type === "toolCall"
				)
					return [
						{
							type: "tool-input-start",
							toolCallId: change.block.id,
							toolName: change.block.name,
						},
					];
				// Tool argument deltas are structured paths; serializing them as ordinary
				// JSON input text would invent a different argument stream. Emit finalized call below.
				return [];
			});
		case "tool_execution_start":
			return [
				{
					type: "tool-input-available",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					input: event.args,
				},
			];
		case "tool_execution_end":
			return event.entry
				? [
						{
							type: "tool-output-available",
							toolCallId: event.toolCallId,
							output: event.entry.model,
						},
					]
				: [];
		case "task_failed":
			return [{ type: "error", errorText: event.message }];
		default:
			return [];
	}
}

/** One observer owns one projection so retained snapshots do not duplicate deltas. */
export function createPiEventProjection(
	display: (entry: EntryRecord) => SessionMessage | null = entrySessionMessage,
): (event: AgentEvent) => readonly Record<string, unknown>[] {
	let messageId = 0;
	const blocks = new Map<
		number,
		{ type: "text" | "thinking"; text: string; ended: boolean }
	>();
	const calls = new Set<string>();
	const projectBlock = (
		index: number,
		block: AssistantMessage["content"][number],
		end = false,
	): Record<string, unknown>[] => {
		if (block.type === "toolCall") {
			if (calls.has(block.id)) return [];
			calls.add(block.id);
			return [
				{
					type: "tool-input-available",
					toolCallId: block.id,
					toolName: block.name,
					input: block.arguments,
				},
			];
		}
		const type = block.type;
		const value = type === "text" ? block.text : block.thinking;
		const prior = blocks.get(index);
		const id = `${messageId}:${index}`;
		const frames: Record<string, unknown>[] = [];
		if (!prior)
			frames.push({
				type: type === "text" ? "text-start" : "reasoning-start",
				id,
			});
		if (prior && !value.startsWith(prior.text))
			throw new Error("Native Pi snapshot rewrote an emitted content block");
		const delta = value.slice(prior?.text.length ?? 0);
		if (delta)
			frames.push({
				type: type === "text" ? "text-delta" : "reasoning-delta",
				id,
				delta,
			});
		if (end && !prior?.ended)
			frames.push({ type: type === "text" ? "text-end" : "reasoning-end", id });
		blocks.set(index, { type, text: value, ended: end || !!prior?.ended });
		return frames;
	};
	return (event) => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			messageId++;
			blocks.clear();
			return [{ type: "start-step" }];
		}
		if (event.type === "snapshot") {
			const partial = event.generation?.message;
			const partialMessage: SessionMessage | undefined = partial
				? {
						id: `pi-generation:${partial.timestamp}:${event.generation?.attempt ?? 0}`,
						role: "assistant",
						createdAt: new Date(partial.timestamp),
						parts: partial.content.map((block) =>
							block.type === "text"
								? { type: "text", text: block.text }
								: block.type === "thinking"
									? { type: "reasoning", text: block.thinking }
									: {
											type: "dynamic-tool",
											toolName: block.name,
											toolCallId: block.id,
											input: block.arguments,
											state: "input-available",
										},
						),
					}
				: undefined;
			const frames: Record<string, unknown>[] = [
				{
					type: "data-pi-snapshot",
					data: {
						messages: event.entries.map(display).filter(Boolean),
						...(partialMessage ? { partialMessage } : {}),
						tools: event.tools.map((tool) => ({
							toolCallId: tool.callId,
							toolName: tool.name,
							status: tool.status,
							...(tool.output === undefined ? {} : { output: tool.output }),
						})),
					},
				},
			];
			if (partial)
				partial.content.forEach((block, index) =>
					frames.push(...projectBlock(index, block)),
				);
			return frames;
		}
		if (event.type === "message_update") {
			const frames: Record<string, unknown>[] = [];
			for (const change of event.changes) {
				if (change.type === "message")
					change.message.content.forEach((block, index) =>
						frames.push(...projectBlock(index, block)),
					);
				else if (
					change.type === "block" ||
					change.type === "text_start" ||
					change.type === "thinking_start"
				)
					frames.push(...projectBlock(change.contentIndex, change.block));
				else if (
					change.type === "text_delta" ||
					change.type === "thinking_delta"
				) {
					const prior = blocks.get(change.contentIndex);
					const type = change.type === "text_delta" ? "text" : "thinking";
					frames.push(
						...projectBlock(
							change.contentIndex,
							type === "text"
								? { type: "text", text: (prior?.text ?? "") + change.delta }
								: {
										type: "thinking",
										thinking: (prior?.text ?? "") + change.delta,
									},
						),
					);
				} else if (change.type === "toolcall_start")
					frames.push(...piEventFrames({ ...event, changes: [change] }));
			}
			return frames;
		}
		if (event.type === "message_end") {
			const frames: Record<string, unknown>[] = [];
			for (const message of event.entry.model ?? [])
				if (message.role === "assistant")
					message.content.forEach((block, index) =>
						frames.push(...projectBlock(index, block, true)),
					);
			frames.push({ type: "finish-step" });
			return frames;
		}
		return piEventFrames(event);
	};
}

/** URL/private image contribution retained as an app-owned native context token.
 * The governed SDK bridge expands it without Worker network fetches. Pi's image
 * base64 field never carries a URL. Descriptors survive future turns/eviction. */
export class PiImageBridge {
	constructor(
		private readonly storage: Pick<DurableObjectStorage, "get" | "put">,
		private readonly bucket: Pick<R2Bucket, "get">,
		private readonly owner: () => { tediId: string; orgId: string },
	) {}
	private ownership(): { tediId: string; orgId: string } {
		const owner = this.owner();
		if (!owner.tediId || !owner.orgId)
			throw new Error("Pi image projection has no authenticated owner");
		return owner;
	}
	async project(
		message: string | SessionMessage,
		options: { legacy?: boolean } = {},
	): Promise<string | SessionMessage> {
		if (typeof message === "string") {
			if (message.includes("[tedix-image:"))
				throw new Error("Reserved native image token in caller input");
			return message;
		}
		const parts: SessionMessagePart[] = [];
		for (let index = 0; index < message.parts.length; index++) {
			const part = message.parts[index]!;
			if (part.type === "text" && part.text?.includes("[tedix-image:"))
				throw new Error("Reserved native image token in caller input");
			if (part.type !== "file" || !part.url || part.url.startsWith("data:")) {
				parts.push(part);
				continue;
			}
			if (message.role !== "user" || !part.mediaType?.startsWith("image/"))
				throw new Error("Unsupported native URL media contribution");
			const owner = this.ownership();
			const parsed = new URL(part.url);
			if (
				!["https:", "http:", "tedix-r2:"].includes(parsed.protocol) ||
				part.url.length > 8192 ||
				parsed.username ||
				parsed.password
			)
				throw new Error("Invalid native image URL");
			const descriptor = {
				...owner,
				legacy: options.legacy === true,
				messageId: message.id,
				partIndex: index,
				url: part.url,
				mediaType: part.mediaType,
				filename: part.filename ?? "",
			};
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(JSON.stringify(descriptor)),
			);
			const token = Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
			const key = `pi-image-projection:v1:${token}`;
			const existing = await this.storage.get<typeof descriptor>(key);
			if (existing && JSON.stringify(existing) !== JSON.stringify(descriptor))
				throw new Error("Native image descriptor conflict");
			if (!existing) await this.storage.put(key, descriptor);
			parts.push({ type: "text", text: `[tedix-image:${token}]` });
		}
		return { ...message, parts };
	}
	async expand(
		prompt: import("@ai-sdk/provider").LanguageModelV2Prompt,
		currentImageUrls?: readonly string[],
	): Promise<void> {
		const current = new Set(currentImageUrls ?? []);
		const latestUser = prompt.findLastIndex(
			(message) => message.role === "user",
		);
		for (const [messageIndex, message] of prompt.entries()) {
			if (message.role !== "user") continue;
			for (let index = 0; index < message.content.length; index++) {
				const part = message.content[index];
				if (part?.type !== "text") continue;
				const match = /^\[tedix-image:([a-f0-9]{64})\]$/.exec(part.text);
				if (!match) continue;
				const descriptor = await this.storage.get<{
					tediId: string;
					orgId: string;
					messageId: string;
					partIndex: number;
					url: string;
					mediaType: string;
					filename: string;
					legacy?: boolean;
				}>(`pi-image-projection:v1:${match[1]}`);
				const owner = this.ownership();
				if (
					!descriptor ||
					descriptor.tediId !== owner.tediId ||
					descriptor.orgId !== owner.orgId
				)
					throw new Error("Native image descriptor ownership mismatch");
				const url = new URL(descriptor.url);
				// Native workflow attachments are scoped to the current admitted turn.
				// Passive legacy contributions retain their original model media semantics.
				if (
					currentImageUrls !== undefined &&
					url.protocol === "tedix-r2:" &&
					descriptor.legacy !== true
				) {
					const name = descriptor.filename || "image";
					if (!current.has(descriptor.url)) {
						message.content[index] = {
							type: "text",
							text: `[image from an earlier turn: ${name}; not attached to this turn]`,
						};
						continue;
					}
					if (messageIndex !== latestUser) {
						message.content[index] = {
							type: "text",
							text: `[same attached image: ${name}]`,
						};
						continue;
					}
				}
				let data: Uint8Array | URL = url;
				if (url.protocol === "tedix-r2:") {
					if (url.hostname !== "workflow-image")
						throw new Error("Unknown private image capability");
					const key = decodeURIComponent(url.pathname.slice(1));
					const sha256 = url.searchParams.get("sha256");
					const prefix = `__runtime/workflow-images/${encodeURIComponent(owner.tediId)}/`;
					if (
						!key.startsWith(prefix) ||
						!sha256 ||
						!/^[a-f0-9]{64}$/.test(sha256)
					)
						throw new Error(
							"workflow_image_invalid: Foreign private image capability",
						);
					const suffix = key.slice(prefix.length),
						slash = suffix.indexOf("/");
					if (slash < 1 || suffix.slice(slash + 1) !== `${sha256}.json`)
						throw new Error("Malformed private image capability");
					const runId = decodeURIComponent(suffix.slice(0, slash));
					if (encodeURIComponent(runId) !== suffix.slice(0, slash))
						throw new Error("Noncanonical private image owner");
					const object = await this.bucket.get(key);
					if (
						!object ||
						object.size > Math.ceil((5 * 1024 * 1024) / 3) * 4 + 2048
					)
						throw new Error(
							"workflow_image_missing: Private image missing or oversized",
						);
					const body = await object.text();
					const actual = Array.from(
						new Uint8Array(
							await crypto.subtle.digest(
								"SHA-256",
								new TextEncoder().encode(body),
							),
						),
						(byte) => byte.toString(16).padStart(2, "0"),
					).join("");
					if (actual !== sha256)
						throw new Error("Private image integrity mismatch");
					const image = JSON.parse(body) as {
						kind: string;
						data: string;
						mediaType: string;
						fileName: string;
					};
					if (
						image.mediaType !== descriptor.mediaType ||
						typeof image.fileName !== "string" ||
						image.fileName.length > 512 ||
						typeof image.data !== "string" ||
						![
							"image/png",
							"image/jpeg",
							"image/jpg",
							"image/webp",
							"image/gif",
						].includes(image.mediaType)
					)
						throw new Error("Private image metadata mismatch");
					if (descriptor.filename && descriptor.filename !== image.fileName)
						throw new Error("Private image filename mismatch");
					if (image.kind === "base64") {
						if (
							!image.data ||
							image.data.length % 4 ||
							!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ||
							image.data.length > Math.ceil((5 * 1024 * 1024) / 3) * 4
						)
							throw new Error("Invalid private image bytes");
						data = Uint8Array.from(atob(image.data), (char) =>
							char.charCodeAt(0),
						);
						if (data.byteLength > 5 * 1024 * 1024)
							throw new Error("Private image exceeds byte allowance");
					} else if (image.kind === "url") {
						data = new URL(image.data);
						if (
							!["https:", "http:"].includes(data.protocol) ||
							image.data.length > 8192 ||
							data.username ||
							data.password
						)
							throw new Error("Invalid private image URL payload");
					} else throw new Error("Invalid private image encoding");
				} else if (
					!["https:", "http:"].includes(url.protocol) ||
					url.username ||
					url.password
				)
					throw new Error("Invalid projected image URL");
				message.content[index] = {
					type: "file",
					mediaType: descriptor.mediaType,
					data,
				};
			}
		}
	}
}
