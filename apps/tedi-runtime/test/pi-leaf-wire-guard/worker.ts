import { verifyRuntimeInferenceOrigin } from "@tedix/auth/runtime-inference-origin";
import { createHash } from "node:crypto";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { GuardParent } from "../historical-execution-guard/worker";
import { RuntimeAdmission } from "../../src/runtime-admission";
import { RuntimeAdmissionDO } from "../../src/runtime-admission-do";
import { HistoricalLiabilityCustody } from "../../src/historical-liability-custody";
import { ConversationFacet as NativeConversation } from "../../src/conversation-facet";
import { JudgeSessionFacet as NativeJudge } from "../../src/judge-session-facet";
import { SynthesisSessionFacet as NativeSynthesis } from "../../src/synthesis-session-facet";
import type { PiAgent } from "../../src/pi-agent";
export {
	GuardProbe,
	GuardWorkflow,
} from "../historical-execution-guard/worker";
export { RawCutoverDO } from "../../src/pi-cutover-maintenance-do";
type Kind = "conversation" | "judge" | "synthesis";
type Leaf = PiAgent<Cloudflare.Env, unknown> & {
	state: Record<string, unknown>;
	setState(state: unknown): void;
};
interface Ports {
	billing(request: Request): Promise<Response>;
	wire(request: Request): Promise<Response>;
}
const ports = new Map<string, Ports>();
function fixtureEnvironment(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
): Cloudflare.Env {
	const descriptors: Record<string, PropertyDescriptor> =
		Object.getOwnPropertyDescriptors(env);
	const vars = {
		AZURE_OPENAI_RESOURCE: "fixture",
		AZURE_OPENAI_API_VERSION: "test",
		AZURE_CHAT_DEPLOYMENT: "gpt-5.6-terra",
		AZURE_OBSERVER_DEPLOYMENT: "gpt-5.6-terra",
		TEDI_JUDGE_MODEL_REF: "azure-openai/gpt-5.6-terra",
		AI_GATEWAY_ACCOUNT_ID: "account",
		AI_GATEWAY_LLM_ID: "gateway",
		AI_GATEWAY_BINDING_PROVIDERS: "azure-openai",
		TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
	};
	for (const [key, value] of Object.entries(vars))
		descriptors[key] = { value, configurable: true, enumerable: true };
	descriptors.API_SERVICE = {
		value: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const p = ports.get(ctx.id.toString());
				if (!p) throw new Error("fixture billing absent");
				return p.billing(new Request(input, init));
			},
		},
		configurable: true,
		enumerable: true,
	};
	descriptors.AI = {
		value: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const p = ports.get(ctx.id.toString());
				if (!p) throw new Error("fixture wire absent");
				return p.wire(new Request(input, init));
			},
		},
		configurable: true,
		enumerable: true,
	};
	return Object.defineProperties(
		Object.create(Object.getPrototypeOf(env)),
		descriptors,
	) as Cloudflare.Env;
}
interface FixtureAccess {
	acceptFacetRuntimeTurn(input: {
		runId: string;
		sessionKey: string;
		configuration: unknown;
		input: unknown;
		operationId: string;
	}): Promise<boolean>;
	normalizedFacetWireConfiguration(
		input: Record<string, unknown>,
	): Record<string, unknown>;
	selectModelForTurn?(): { model: LanguageModel };
	selected?(): { model: LanguageModel };
	facetBeforeDispatch(): () => void;
	assertFacetRuntimeDispatch(): Promise<void>;
	summarizeCompaction?(
		messages: { role: "user"; content: string }[],
		context: unknown,
	): Promise<unknown>;
}
async function prepare(agent: Leaf, runId: string, kind: Kind, legacy = false) {
	const configuration: Record<string, unknown> = {
		runId,
		sessionKey: "original-session",
		system: "original-system",
		modelRef: "azure-openai/gpt-5.6-terra",
		observerModelRef: "azure-openai/gpt-5.6-terra",
		aigMetadata: { orgId: "native-org", tediId: "native-tedi" },
		maxSteps: 10,
		toolDescriptors: [],
	};
	if (legacy && kind === "synthesis") delete configuration.modelRef;
	const access = agent as unknown as FixtureAccess;
	await access.acceptFacetRuntimeTurn({
		runId,
		sessionKey: "original-session",
		operationId: `operation:${runId}`,
		configuration,
		input: { text: "original-private" },
	});
	agent.setState({
		...agent.state,
		...access.normalizedFacetWireConfiguration(configuration),
	});
	return { operationId: `operation:${runId}`, configuration };
}
const admissionResponse = () =>
	Response.json({
		json: {
			allowed: true,
			settlementMode: "disabled",
			attributionVersion: 3,
			executionId: "12345678-1234-4123-8123-123456789abc",
			sendBefore: "2099-01-01T00:00:00.000Z",
			reservationId: null,
			expiresAt: null,
			estimatedChargeMicros: null,
		},
	});
async function scenario(
	agent: Leaf,
	ctx: DurableObjectState,
	change: string,
	kind: Kind,
	compaction = false,
) {
	const access = agent as unknown as FixtureAccess;
	await access.assertFacetRuntimeDispatch();
	const journal = ctx.storage.kv.get<{
		runId: string;
		operationId: string;
		sessionKey: string;
	}>("pi-admitted-operation:v1") ?? {
		runId: String(agent.state.runId),
		operationId: "unselected-no-claim",
		sessionKey: "original-session",
	};
	const owner = {
		objectId: ctx.id.toString(),
		orgId: "native-org",
		tediId: "native-tedi",
	};
	const adapter = new RuntimeAdmissionDO(ctx.storage, owner);
	const accepted = adapter.read()
		? await adapter.lookupAcceptedTurn(journal.operationId)
		: null;
	const unknown = {
		reservationId: "original-reservation",
		measured: null,
		outcome: "unknown",
	};
	ctx.storage.kv.put("pi-accounting:original", unknown);
	const rewriteIdentity = () => {
		const canonical = (value: unknown): string => {
			if (Array.isArray(value))
				return "[" + value.map(canonical).join(",") + "]";
			if (value && typeof value === "object")
				return (
					"{" +
					Object.keys(value)
						.sort()
						.map(
							(key) =>
								JSON.stringify(key) +
								":" +
								canonical((value as Record<string, unknown>)[key]),
						)
						.join(",") +
					"}"
				);
			return JSON.stringify(value);
		};
		const { requestHash: _previous, ...fields } = accepted!;
		const changed = {
			...fields,
			principalId: "coherently-changed-principal",
		};
		const requestHash = createHash("sha256")
			.update(canonical(changed))
			.digest("hex");
		ctx.storage.sql.exec(
			"UPDATE runtime_admission_identities SET record=? WHERE run_id=?",
			canonical({ ...changed, requestHash }),
			journal.operationId,
		);
		ctx.storage.sql.exec(
			"UPDATE runtime_admission_turns SET record=? WHERE id=?",
			JSON.stringify({
				...adapter.gate.claim(journal.operationId)!,
				requestHash,
			}),
			journal.operationId,
		);
		// The new tuple is internally consistent; only the captured original pin must refuse it.
		adapter.assertAcceptedTurnSync({ runId: journal.operationId });
	};
	if (change === "preFactoryIdentity") rewriteIdentity();
	if (change === "preFactoryModel")
		agent.setState({ ...agent.state, modelRef: "azure-openai/gpt-6.1-sol" });
	if (change === "preFactoryMarkers")
		ctx.storage.kv.put("cf_agents_parent_path", []);
	if (change === "preFactory")
		agent.setState({ ...agent.state, system: "changed-before-factory" });
	let entered!: () => void,
		release!: () => void,
		sends = 0,
		bills = 0;
	const started = new Promise<void>((r) => (entered = r)),
		barrier = new Promise<void>((r) => (release = r));
	const executions: string[] = [];
	const signedTokens: string[] = [];
	const signedOrigins: {
		kind: string;
		rootRun: string | null;
		selectedRun: string | null;
		rootGeneration: number;
		selectedGeneration: number;
	}[] = [];
	const originalNow = Date.now,
		originalTime = originalNow();
	if (change === "logicalRetry") Date.now = () => originalTime;
	ports.set(ctx.id.toString(), {
		billing: async (request) => {
			const envelope = (await request.json()) as Record<string, unknown>;
			const { originToken, ...projection } =
				(envelope.json as Record<string, unknown> | undefined) ?? envelope;
			const origin = await verifyRuntimeInferenceOrigin({
				secret: "guard-native-token",
				request: projection,
				token: originToken as string,
			});
			signedTokens.push(originToken as string);
			signedOrigins.push({
				kind: origin.kind,
				rootRun:
					origin.kind === "accepted_native" ? origin.root.accepted.runId : null,
				selectedRun:
					origin.kind === "accepted_native"
						? origin.selected.accepted.runId
						: null,
				rootGeneration: origin.root.generation,
				selectedGeneration: origin.selected.generation,
			});
			if (
				origin.kind === "accepted_native" &&
				projection.runId !== origin.root.accepted.runId
			)
				throw new Error("fixture root projection mismatch");

			bills++;
			entered();
			if (
				!["retry", "positive", "logicalRetry", "retryDistinct"].includes(change)
			)
				await barrier;
			const response = (await admissionResponse().json()) as {
				json: { executionId: string };
			};
			response.json.executionId = crypto.randomUUID();
			executions.push(response.json.executionId);
			return Response.json(response);
		},
		wire: async (request) => {
			const serialized =
				JSON.stringify([...request.headers]) + (await request.text());
			if (
				serialized.includes("originToken") ||
				serialized.includes("configurationHash") ||
				signedTokens.some((token) => serialized.includes(token))
			)
				throw new Error("Private origin leaked into provider wire");
			sends++;
			if (change === "logicalRetry") Date.now = () => originalTime + 600_001;
			if (change === "retry")
				adapter.gate.quarantine({
					operationId: "retry-stop",
					expectedGeneration: 1,
					reason: "test-only retry stop",
				});
			return new Response("fixture-provider-unknown", { status: 503 });
		},
	});
	const controller = new AbortController();
	let pending: Promise<unknown>;
	if (compaction) {
		// TEST-only business collaborators: no fabricated provider usage or financial grant.
		Object.defineProperty(agent, "accounting", {
			value: {
				begin: async () => {},
				prepareStep: async () => 1,
				captureProviderAttempt: async () => ({
					runId: journal.runId,
					stepNumber: 1,
				}),
				recordProviderUsage: async () => {},
			},
		});
		pending = access.summarizeCompaction!(
			[{ role: "user", content: "original" }],
			{
				abortSignal: undefined,
				value: () => undefined,
				toString: () => "native-fixture",
			},
		);
	} else {
		const selected =
			kind === "conversation"
				? access.selectModelForTurn!()
				: access.selected!();
		pending = generateText({
			model: selected.model,
			prompt: "fixture",
			abortSignal: controller.signal,
			maxRetries: ["retry", "logicalRetry", "retryDistinct"].includes(change)
				? 1
				: 0,
		});
	}
	const result = pending.then(
		() => ({ error: null }),
		(error) => ({
			error: {
				name: error.name,
				phase: error.phase,
				lastPhase: error.lastError?.phase,
				message: error.message,
				cause: (() => {
					let value = error;
					while (value.cause instanceof Error) value = value.cause;
					return value.message;
				})(),
			},
		}),
	);
	if (
		!change.startsWith("preFactory") &&
		!["retry", "positive", "logicalRetry", "retryDistinct"].includes(change)
	) {
		await Promise.race([
			started,
			result.then((v) => {
				throw new Error("fixture did not reach billing: " + JSON.stringify(v));
			}),
		]);
		if (change === "abort") controller.abort();
		if (change === "selected")
			new RuntimeAdmission(ctx.storage, owner, () => ({
				owner,
				digest: "a".repeat(64),
				complete: true,
				unknown: 0,
				nonterminal: 0,
			})).initialize({
				operationId: "test-only-selection",
				state: "quarantined",
				evidence: "a".repeat(64),
			});
		if (change === "coherentIdentity") rewriteIdentity();
		if (change === "quarantine")
			adapter.gate.quarantine({
				operationId: "stop",
				expectedGeneration: 1,
				reason: "test-only stop",
			});
		if (change === "held" || change === "generation")
			ctx.storage.sql.exec(
				"UPDATE runtime_admission SET record=? WHERE id=1",
				JSON.stringify({
					...adapter.read()!,
					...(change === "held" ? { state: "held" } : { generation: 2 }),
				}),
			);
		if (change === "owner")
			agent.setState({
				...agent.state,
				aigMetadata: { orgId: "wrong", tediId: "native-tedi" },
			});
		if (change === "storedOwner")
			ctx.storage.sql.exec(
				"UPDATE cf_agents_state SET state=? WHERE id='cf_state_row_id'",
				JSON.stringify({
					...agent.state,
					aigMetadata: { orgId: "wrong", tediId: "native-tedi" },
				}),
			);
		if (change === "configuration")
			agent.setState({ ...agent.state, system: "changed" });
		if (change === "input")
			ctx.storage.sql.exec(
				"UPDATE runtime_admission_identities SET input=? WHERE run_id=?",
				'{"changed":true}',
				journal.operationId,
			);
		if (change === "journal")
			ctx.storage.kv.put("pi-admitted-operation:v1", {
				...journal,
				runId: "other",
			});
		if (change === "claim")
			ctx.storage.sql.exec(
				"DELETE FROM runtime_admission_turns WHERE id=?",
				journal.operationId,
			);
		if (change === "markers")
			ctx.storage.kv.put("cf_agents_facet_name", "wrong");
		if (change === "seal" || change === "operationSeal") {
			const originalAdmission = ctx.storage.sql
				.exec<{ record: string }>(
					"SELECT record FROM runtime_admission WHERE id=1",
				)
				.toArray()[0]!.record;
			adapter.gate.quarantine({
				operationId: "capture-stop",
				expectedGeneration: 1,
				reason: "test-only stop",
			});
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status) VALUES('old','old-provider','CHAT_TURN_WORKFLOW','queued')",
			);
			ctx.storage.kv.put("wfctx:old-provider", {
				runId: change === "operationSeal" ? journal.operationId : journal.runId,
			});
			const store = new HistoricalLiabilityCustody(
					ctx.storage,
					ctx.id.toString(),
				),
				snapshot = store.inspectSnapshot({ expectedGeneration: 2 });
			store.captureSnapshot({
				expectedGeneration: 2,
				expectedSourceHash: snapshot.sourceHash,
			});
			// TEST-only core fault: restore the original still-running claim's epoch so
			// refusal proves the permanent seal independently of quarantine, not a release.
			ctx.storage.sql.exec(
				"UPDATE runtime_admission SET record=? WHERE id=1",
				originalAdmission,
			);
			adapter.assertAcceptedTurnSync({
				runId: journal.operationId,
				expected: accepted!,
			});
		}
		release();
	}
	const outcome = await result;
	Date.now = originalNow;
	return {
		sends,
		bills,
		executions,
		signedOrigins,
		...outcome,
		unknownPreserved:
			JSON.stringify(ctx.storage.kv.get("pi-accounting:original")) ===
			JSON.stringify(unknown),
		receipts: ctx.storage.sql
			.exec(
				"SELECT name FROM sqlite_master WHERE name='runtime_admission_receipts'",
			)
			.toArray().length,
		acceptedRun: accepted?.runId ?? null,
		claimStatus: adapter.read()
			? (adapter.gate.claim(journal.operationId)?.status ?? null)
			: null,
	};
}
export class ConversationFacet extends NativeConversation {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, fixtureEnvironment(ctx, env));
	}
	async prepareFixture(runId: string) {
		return prepare(this as unknown as Leaf, runId, "conversation");
	}
	async scenario(change: string, compaction = false) {
		return scenario(
			this as unknown as Leaf,
			this.ctx,
			change,
			"conversation",
			compaction,
		);
	}
}
export class JudgeSessionFacet extends NativeJudge {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, fixtureEnvironment(ctx, env));
	}
	async prepareFixture(runId: string) {
		return prepare(this as unknown as Leaf, runId, "judge");
	}
	async scenario(change: string) {
		return scenario(this as unknown as Leaf, this.ctx, change, "judge");
	}
}
export class SynthesisSessionFacet extends NativeSynthesis {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, fixtureEnvironment(ctx, env));
	}
	async prepareFixture(runId: string, legacy = false) {
		return prepare(this as unknown as Leaf, runId, "synthesis", legacy);
	}
	async scenario(change: string) {
		return scenario(this as unknown as Leaf, this.ctx, change, "synthesis");
	}
}
/** Actual root custody RPC and registered facet topology; only business startup/authority verifier is test-owned. */
export class AgentTediDO extends GuardParent {
	async setup(kind: Kind, selected = true, legacy = false) {
		this.setState({
			...this.state,
			tediId: "native-tedi",
			orgId: "native-org",
		});
		const owner = {
			objectId: this.ctx.id.toString(),
			orgId: "native-org",
			tediId: "native-tedi",
		};
		if (selected)
			new RuntimeAdmission(this.ctx.storage, owner, () => ({
				owner,
				digest: "a".repeat(64),
				complete: true,
				unknown: 0,
				nonterminal: 0,
			})).initialize({
				operationId: "test-only-independent-release",
				state: "active",
				evidence: "a".repeat(64),
			});
		const runId = crypto.randomUUID();
		if (selected)
			await new RuntimeAdmissionDO(this.ctx.storage, owner).beginAcceptedTurn({
				runId,
				sessionKey: "original-session",
				principalId: "fixture-principal",
				input: { text: "original" },
				expectedGeneration: 1,
			});
		const leaf =
			kind === "conversation"
				? await this.subAgent(ConversationFacet, kind)
				: kind === "judge"
					? await this.subAgent(JudgeSessionFacet, kind)
					: await this.subAgent(SynthesisSessionFacet, kind);
		if (kind === "synthesis")
			await (
				leaf as unknown as {
					prepareFixture(runId: string, legacy: boolean): Promise<unknown>;
				}
			).prepareFixture(runId, legacy);
		else await leaf.prepareFixture(runId);
		return { runId };
	}
	async scenario(kind: Kind, change: string, compaction = false) {
		if (kind === "conversation")
			return (await this.subAgent(ConversationFacet, kind)).scenario(
				change,
				compaction,
			);
		if (kind === "judge")
			return (await this.subAgent(JudgeSessionFacet, kind)).scenario(change);
		return (await this.subAgent(SynthesisSessionFacet, kind)).scenario(change);
	}
}
export default {
	fetch() {
		return new Response("dedicated local leaf wire fixture");
	},
};
