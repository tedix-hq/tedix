/**
 * `env.REASON` — pure contract half: identity, budget, and the platform grant.
 *
 * Split from `reason.ts` for the same reason `evidence-core.ts` is split from
 * `evidence.ts`: the bridge itself imports `cloudflare:workers`, which cannot
 * load under the plain node test runner, and the rules worth pinning (what a
 * manifest is allowed to grant, what identity a retry presents) are all pure.
 *
 * See `reason.ts` for why the primitive exists and what it deliberately is not.
 */

import { WORKFLOW_SYNTH_SESSION_PREFIX } from "@tedix/api-contract/utils/runtime-identity";
import type { CapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import type { McpBridgeProps } from "./mcp-bridge";
import * as z from "zod";
import type { WorkflowMcpCallContext } from "./workflow-identity";

/** The lean synthesis turn is reached through the same tool as the judge. */
export const REASON_NAMESPACE = "tedi";
export const REASON_METHOD = "run_tedi_turn";

/**
 * Capability manifest the PLATFORM uses to reach the lean synthesis turn.
 *
 * Deliberately not the skill's manifest — same argument as
 * `PLATFORM_EVIDENCE_MANIFEST`: a workflow declares that it wants to REASON,
 * not that it may call `tedi.run_tedi_turn`. Routing it through the skill's own
 * manifest would hand every reasoning workflow a general tedi-messaging
 * capability it never asked for, which is a strictly larger grant than the
 * feature needs.
 */
export const PLATFORM_REASON_MANIFEST = {
	mcp: { [REASON_NAMESPACE]: [REASON_METHOD] },
	network: false,
	rationale: { mode: "off" },
	expectedAnnotations: { destructive: false, readOnly: false },
	grounding: { required: false, minCausalScore: 1, enforce: "warn" },
	schedule: null,
	reliability: null,
	// The grant is the MCP method above. This manifest is the PLATFORM's own
	// dispatch envelope, not a re-entrant reasoning grant.
	reason: { enabled: false, maxCalls: null },
} satisfies CapabilityManifest;

/**
 * Hard ceiling on reasoner calls per run, regardless of what the manifest asks
 * for. A manifest may lower this; nothing can raise it. The engine retries
 * steps, so an unbounded fan-out inside a retried step multiplies.
 */
export const REASON_MAX_CALLS_CEILING = 64;
/** Default when a manifest enables reasoning without naming a budget. */
export const REASON_DEFAULT_MAX_CALLS = 8;

/** Prompt/reply bounds. Sealed copies are clipped to keep artifacts bounded. */
const REASON_PROMPT_MAX_CHARS = 60_000;
export const REASON_PROMPT_SEAL_CHARS = 4_000;
export const REASON_REPLY_SEAL_CHARS = 8_000;
/** Caller-supplied fan-out key: identity only, so keep it short and inert. */
const REASON_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;

const WorkflowContextSchema = z
	.object({
		stepName: z.string().optional(),
		stepCount: z.number().optional(),
		stepType: z.string().optional(),
		attempt: z.number().optional(),
		phase: z.string().optional(),
		ordinal: z.number().optional(),
	})
	.passthrough();

export const AskRequestSchema = z.object({
	/** The entire question. Lean turns carry their whole input in the prompt. */
	prompt: z.string().min(1).max(REASON_PROMPT_MAX_CHARS),
	/**
	 * Fan-out identity. Distinct keys are the only way to get independent
	 * samples: they produce distinct session keys, hence distinct facets, hence
	 * genuinely parallel and mutually blind reasoners. Reusing a key inside one
	 * step is a deliberate dedupe, not a second sample.
	 */
	key: z.string().regex(REASON_KEY_RE).optional(),
	/** Optional framing. The tedi's own persona still applies underneath. */
	system: z.string().max(8_000).optional(),
	workflow: WorkflowContextSchema.optional(),
});

export interface ReasonBridgeEnv {
	DB: D1Database;
	SKILL_ARTIFACTS: R2Bucket;
	MCP_SERVICE: Fetcher;
}

export interface ReasonBridgeProps {
	runId: string;
	skillId: string;
	/** MCP routing/identity for the platform-owned synthesis call. */
	mcp: McpBridgeProps;
	/** Manifest-derived ceiling, already clamped by the runner. */
	maxCalls: number;
}

export interface ReasonAskResult {
	/** Echoes the fan-out key so `Promise.all` results stay identifiable. */
	key: string;
	text: string;
	modelIdentity: { provider: string; model: string } | null;
	/** True when the model returned nothing usable — never throws for that. */
	empty: boolean;
}

/**
 * Derive the per-call fan-out identity.
 *
 * The step coordinates come from the ENGINE (the runner applies them last, so
 * tenant args cannot shadow them), and the attempt is deliberately EXCLUDED —
 * matching the `env.MCP` idempotency doctrine, so a durable retry of the same
 * logical call presents the same identity instead of silently re-billing. A
 * caller that wants a fresh sample passes a different `key`; that is the whole
 * contract, and it is why `key` rather than `attempt` carries fan-out identity.
 */
export function callIdentity(
	runId: string,
	key: string,
	workflow: WorkflowMcpCallContext | undefined,
): string {
	const step = workflow?.stepName ?? "step";
	const count = workflow?.stepCount ?? 0;
	const phase = workflow?.phase ?? "do";
	return `${runId}:${phase}:${step}:${count}:${key}`;
}

/**
 * The session key one reasoner call runs under.
 *
 * The lean prefix is load-bearing, not cosmetic: a tedi runtime routes it to a
 * per-session `SynthesisSessionFacet` — tool-free, no accumulated context in,
 * nothing learned out. Distinct suffixes are therefore distinct child objects,
 * which is what makes `Promise.all` over N asks genuinely parallel instead of
 * a queue on one tedi.
 */
export function buildReasonSessionKey(identity: string): string {
	return `${WORKFLOW_SYNTH_SESSION_PREFIX}${identity}`;
}

/**
 * Resolve the manifest's declared reasoning budget.
 *
 * Absent or disabled means the primitive is unavailable — the proxy then throws
 * `REASON_NOT_DECLARED`, matching how an undeclared `env.MCP` namespace fails.
 * Enabling it without a number takes the conservative default rather than the
 * ceiling, and nothing a manifest says can exceed the platform ceiling: the
 * engine retries steps, so an unbounded fan-out inside a retried step
 * multiplies into a real cost incident.
 */
export function resolveReasonBudget(capabilities: unknown): {
	enabled: boolean;
	maxCalls: number;
} {
	const manifest = (capabilities ?? {}) as Record<string, unknown>;
	const reason = manifest.reason;
	if (reason === undefined || reason === null || reason === false) {
		return { enabled: false, maxCalls: 0 };
	}
	if (reason === true) {
		return { enabled: true, maxCalls: REASON_DEFAULT_MAX_CALLS };
	}
	if (typeof reason !== "object") return { enabled: false, maxCalls: 0 };
	const record = reason as Record<string, unknown>;
	if (record.enabled === false) return { enabled: false, maxCalls: 0 };
	const declared = record.maxCalls;
	const maxCalls =
		typeof declared === "number" && Number.isFinite(declared) && declared > 0
			? Math.min(Math.floor(declared), REASON_MAX_CALLS_CEILING)
			: REASON_DEFAULT_MAX_CALLS;
	return { enabled: true, maxCalls };
}
