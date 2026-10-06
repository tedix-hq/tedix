/**
 * `env.REASON` — ephemeral, parallel-safe reasoning inside a workflow step.
 *
 * Why this exists. A skill workflow's only LLM primitive was
 * `env.MCP.<tedi>.run_tedi_turn` — a full tedi turn. That is the right call
 * when the workflow wants its tedi's accumulated judgment, but it is the wrong
 * shape for fan-out. One greedy judgment pass varies from run to run on
 * identical input, and the answer to that is sampling and voting, which needs
 * N independent asks the workflow could not cheaply make.
 *
 * What it is. A thin, capability-gated, sealed wrapper over the lean
 * workflow-synthesis turn the platform already ships. Every call mints a
 * distinct session key under `WORKFLOW_SYNTH_SESSION_PREFIX`, which a tedi
 * runtime resolves to a `SynthesisSessionFacet`: a tool-free native Pi child
 * Durable Object, one per synthesis turn, that injects no accumulated context
 * and does not learn from the turn. Because the facet is keyed by session,
 * distinct keys are distinct child objects — so `Promise.all` over N reasoner
 * calls genuinely runs N of them instead of serializing on the parent tedi, and
 * none of the throwaway turns land in that tedi's memory.
 *
 * What it is not. It is not a second model path and holds no vendor
 * credential: like the entailment judge in `evidence.ts`, it dispatches through
 * `callMcpTool` and therefore inherits the capability check, the tool-call
 * receipt, and the idempotency identity. It is also not a grounding primitive.
 * A reasoner returns text; only `env.EVIDENCE.verify()`/`score()` can decide
 * whether a claim is supported, and those re-read host-sealed records. Reason
 * freely, then let the existing gate judge — a fan-out of confident reasoners
 * is not evidence, and nothing here lets a workflow author `verified: true`.
 *
 * Budget is a safety property. Unbounded LLM fan-out inside a durable step that
 * the engine will happily retry can exhaust a tedi's daily inference budget.
 * So a workflow must declare `capabilities.reason` and the
 * bridge enforces a hard per-run call ceiling that tenant code cannot raise.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { recordArtifactOnceForRun } from "./artifact-immutability";
import { logSkillRuntimeWarning } from "./control-log";
import { callMcpTool } from "./mcp-bridge";
import {
	AskRequestSchema,
	buildReasonSessionKey,
	callIdentity,
	REASON_DEFAULT_MAX_CALLS,
	REASON_MAX_CALLS_CEILING,
	REASON_METHOD,
	REASON_NAMESPACE,
	REASON_PROMPT_SEAL_CHARS,
	REASON_REPLY_SEAL_CHARS,
	type ReasonAskResult,
	type ReasonBridgeEnv,
	type ReasonBridgeProps,
} from "./reason-core";
import type { WorkflowMcpCallContext } from "./workflow-identity";

function extractAssistantText(result: unknown): string {
	const payload = (result ?? {}) as Record<string, unknown>;
	const inner = (payload.result ?? payload) as Record<string, unknown>;
	const assistant = (inner.assistant ?? {}) as Record<string, unknown>;
	for (const candidate of [
		assistant.content,
		inner.text,
		inner.reply,
		payload.text,
	]) {
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}
	return "";
}

function extractModelIdentity(
	result: unknown,
): { provider: string; model: string } | null {
	const payload = (result ?? {}) as Record<string, unknown>;
	const inner = (payload.result ?? payload) as Record<string, unknown>;
	const identity = (inner.modelIdentity ?? payload.modelIdentity) as
		| Record<string, unknown>
		| undefined;
	if (!identity) return null;
	const provider = identity.provider;
	const model = identity.model;
	if (typeof provider !== "string" || typeof model !== "string") return null;
	return { provider, model };
}

export class ReasonBridge extends WorkerEntrypoint<
	ReasonBridgeEnv,
	ReasonBridgeProps
> {
	/** Reasoner calls already spent by this bridge instance. */
	private calls = 0;

	/**
	 * Ask one independent, memory-free reasoner.
	 *
	 * Never throws for an unhelpful model: an empty or failed reply comes back
	 * as `{ empty: true }` so a fan-out of K reasoners degrades to K-1 votes
	 * instead of failing the whole durable step. Budget and validation errors DO
	 * throw — those are contract violations the author must see.
	 */
	async ask(payload: unknown): Promise<ReasonAskResult> {
		const parsed = AskRequestSchema.safeParse(payload);
		if (!parsed.success) {
			throw new Error(
				`REASON_INVALID_REQUEST: ${JSON.stringify(parsed.error.issues)}`,
			);
		}
		const { runId, maxCalls } = this.ctx.props;
		const budget = Math.min(
			Number.isFinite(maxCalls) ? maxCalls : REASON_DEFAULT_MAX_CALLS,
			REASON_MAX_CALLS_CEILING,
		);
		if (this.calls >= budget) {
			// Loud and non-retryable in spirit: silently degrading a fan-out to
			// fewer voters would change the meaning of a consensus verdict without
			// anyone noticing.
			throw new Error(
				`REASON_BUDGET_EXHAUSTED: this run declared capabilities.reason.maxCalls=${budget} and has used all of it`,
			);
		}
		const ordinal = this.calls++;
		// The runner applies the engine's step coordinates last on every call, so
		// their absence means this was reached outside the dispatch shim rather
		// than that the step is anonymous. Fail loudly instead of synthesizing a
		// context — a fabricated one would produce a bogus idempotency identity.
		const workflow = parsed.data.workflow as WorkflowMcpCallContext | undefined;
		if (!workflow) {
			throw new Error(
				"REASON_CALL_CONTEXT_INVALID: env.REASON requires a valid durable step context",
			);
		}
		const key = parsed.data.key ?? `r${ordinal}`;
		const identity = callIdentity(runId, key, workflow);
		const promptHash = await sha256Hex(parsed.data.prompt);

		// One session per call, under the lean prefix. The tedi runtime routes
		// this to a per-session SynthesisSessionFacet: no accumulated context in,
		// nothing learned out, and distinct keys are distinct child objects.
		const sessionKey = buildReasonSessionKey(identity);

		let raw = "";
		let modelIdentity: { provider: string; model: string } | null = null;
		let failure: string | null = null;
		try {
			const result = await callMcpTool(this.env, this.ctx.props.mcp, {
				namespace: REASON_NAMESPACE,
				method: REASON_METHOD,
				args: {
					session_key: sessionKey,
					text: parsed.data.prompt,
					client_request_id: `reason:${identity}:${promptHash.slice(0, 16)}`,
					...(parsed.data.system ? { system: parsed.data.system } : {}),
				},
				workflow,
			});
			raw = extractAssistantText(result);
			modelIdentity = extractModelIdentity(result);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}

		// Seal every exchange. A reasoning pass nobody can inspect is another
		// assertion — the same argument the judge exchanges are sealed under.
		await this.seal({
			path: `reason/${ordinal}-${key}-${promptHash.slice(0, 12)}.json`,
			value: {
				key,
				ordinal,
				sessionKey,
				promptHash,
				promptChars: parsed.data.prompt.length,
				prompt: parsed.data.prompt.slice(0, REASON_PROMPT_SEAL_CHARS),
				promptTruncated: parsed.data.prompt.length > REASON_PROMPT_SEAL_CHARS,
				...(parsed.data.system ? { system: parsed.data.system } : {}),
				modelIdentity,
				reply: raw.slice(0, REASON_REPLY_SEAL_CHARS),
				replyChars: raw.length,
				replyTruncated: raw.length > REASON_REPLY_SEAL_CHARS,
				...(failure ? { error: failure.slice(0, 1_000) } : {}),
			},
		});

		return {
			key,
			text: raw,
			modelIdentity,
			empty: raw.trim().length === 0,
		};
	}

	private async seal(input: {
		path: string;
		value: Record<string, unknown>;
	}): Promise<void> {
		try {
			await recordArtifactOnceForRun(
				this.env.DB,
				this.ctx.props.runId,
				{
					path: input.path,
					value: input.value,
					outcome: input.value.error ? "failure" : "success",
				},
				this.env.SKILL_ARTIFACTS,
			);
		} catch (error) {
			// Sealing is evidence, not control flow: a failed seal must not fail
			// the reasoning step it was recording.
			logSkillRuntimeWarning("reason.exchange_seal_failed", {
				runId: this.ctx.props.runId,
				caught: error,
			});
		}
	}
}
