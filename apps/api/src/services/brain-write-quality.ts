import type { ApiAuthType } from "../rpc/context";

type BrainWriteInput = {
	content: string;
	domain: string;
	confidence?: number;
	priority?: "core" | "active" | "background";
	source?: string | null;
	sourceSessionId?: string | null;
	sourceUrl?: string | null;
	sourceHash: string;
	metadata?: Record<string, unknown> | null;
};

export type BrainWriteSourceKind =
	| "skill-workflow"
	| "heartbeat"
	| "cron"
	| "brain-reflection"
	| "afterTurn"
	| "entity-extraction"
	| "source-backed"
	| "manual"
	| "unknown";

export interface BrainWriteQualityEnvelope {
	version: 1;
	producer: string;
	sourceKind: BrainWriteSourceKind;
	qualityScore: number;
	status: "accepted" | "probation" | "weak";
	gates: {
		hasStructuredSource: boolean;
		hasContentHash: boolean;
		hasTraceableOrigin: boolean;
		hasExpectedUse: boolean;
		hasConfidenceReason: boolean;
		hasSpecificContent: boolean;
	};
	contentHash: string;
	dedupeKey: string;
	confidenceRequested: number;
	confidenceApplied: number;
	priorityApplied: "core" | "active" | "background";
	evaluatedAt: string;
}

/**
 * Auth classes of the memory-write caller — mirrors `BaseContext["authType"]`
 * (apps/api/src/rpc/orpc.ts).
 */
export interface BrainWriteCallerAuth {
	authType?: ApiAuthType;
	/** Tedi id resolved by auth middleware (tedi JWT) — never from the payload. */
	contextTediId?: string | null;
	/** Tedi id forwarded by a trusted service-binding edge (x-tedix-*-tedi-id). */
	forwardedTediId?: string | null;
}

/**
 * Agent-authenticated caller classes: a tedi JWT (or middleware-resolved tedi
 * id), an M2M token, or a service-binding call forwarding a tedi identity.
 * Operators (user JWT) and API keys are NOT agent-authenticated.
 */
export function isAgentAuthenticatedBrainWrite(
	caller: BrainWriteCallerAuth,
): boolean {
	if (caller.contextTediId) return true;
	if (caller.authType === "tedi" || caller.authType === "m2m") return true;
	return (
		caller.authType === "service-binding" && Boolean(caller.forwardedTediId)
	);
}

/**
 * Admission-gate keying. `sourceKind` comes from caller-controlled labels
 * (`source`, `metadata.producer`, …), so an agent could relabel an afterTurn
 * observation as `doc://…` and skip the graph-linkage gate entirely. Keying
 * on the AUTHENTICATED caller class closes that: every agent-authenticated
 * write is enforced regardless of payload labels. Operators/API keys keep the
 * labeled-producer behavior — and afterTurn stays enforced for every caller
 * class (the 99.6%-of-inflow producer).
 */
export function shouldEnforceFactAdmission(
	caller: BrainWriteCallerAuth,
	sourceKind: BrainWriteSourceKind,
): boolean {
	return sourceKind === "afterTurn" || isAgentAuthenticatedBrainWrite(caller);
}

function metadataString(
	metadata: Record<string, unknown> | null | undefined,
	key: string,
): string | null {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function classifySourceKind(
	source: string | null | undefined,
	sourceSessionId: string | null | undefined,
	sourceUrl: string | null | undefined,
	metadata: Record<string, unknown> | null | undefined,
): BrainWriteSourceKind {
	const label =
		`${source ?? ""} ${metadataString(metadata, "producer") ?? ""} ${
			metadataString(metadata, "sourceKind") ?? ""
		}`.toLowerCase();
	if (source?.startsWith("skill://runs/")) return "skill-workflow";
	if (label.includes("heartbeat")) return "heartbeat";
	if (label.includes("cron")) return "cron";
	if (label.includes("brain-reflection") || label.includes("reflection")) {
		return "brain-reflection";
	}
	if (label.includes("entity-extraction") || source?.startsWith("entity://")) {
		return "entity-extraction";
	}
	if (
		label.includes("afterturn") ||
		label.includes("observation") ||
		label.includes("conversation") ||
		sourceSessionId
	) {
		return "afterTurn";
	}
	if (sourceUrl || source?.startsWith("doc://") || source?.startsWith("http")) {
		return "source-backed";
	}
	if (source) return "manual";
	return "unknown";
}

function scoreGates(gates: BrainWriteQualityEnvelope["gates"]): number {
	const weights: Array<[keyof typeof gates, number]> = [
		["hasStructuredSource", 0.18],
		["hasContentHash", 0.18],
		["hasTraceableOrigin", 0.2],
		["hasExpectedUse", 0.16],
		["hasConfidenceReason", 0.14],
		["hasSpecificContent", 0.14],
	];
	return (
		Math.round(
			weights.reduce(
				(sum, [key, weight]) => sum + (gates[key] ? weight : 0),
				0,
			) * 100,
		) / 100
	);
}

function confidenceCeiling(score: number): number {
	if (score >= 0.85) return 0.95;
	if (score >= 0.7) return 0.85;
	if (score >= 0.5) return 0.7;
	return 0.55;
}

export function buildBrainWriteQualityEnvelope(
	input: BrainWriteInput,
	now = new Date().toISOString(),
): BrainWriteQualityEnvelope {
	const sourceKind = classifySourceKind(
		input.source,
		input.sourceSessionId,
		input.sourceUrl,
		input.metadata,
	);
	const producer =
		metadataString(input.metadata, "producer") ??
		metadataString(input.metadata, "sourceKind") ??
		sourceKind;
	const normalizedContent = input.content.trim();
	const expectedUse =
		metadataString(input.metadata, "expectedUse") ??
		metadataString(input.metadata, "usageIntent") ??
		metadataString(input.metadata, "purpose");
	const confidenceReason =
		metadataString(input.metadata, "confidenceReason") ??
		metadataString(input.metadata, "evidenceReason") ??
		metadataString(input.metadata, "reason");
	const hasStructuredSource = Boolean(
		input.source?.includes("://") || input.sourceUrl,
	);
	const hasTraceableOrigin = Boolean(
		input.source ||
		input.sourceSessionId ||
		input.sourceUrl ||
		metadataString(input.metadata, "rationaleId") ||
		metadataString(input.metadata, "workflowRunId"),
	);
	const gates = {
		hasStructuredSource,
		hasContentHash: input.sourceHash.length >= 32,
		hasTraceableOrigin,
		hasExpectedUse: Boolean(expectedUse),
		hasConfidenceReason: Boolean(confidenceReason),
		hasSpecificContent:
			normalizedContent.length >= 24 && /\s/.test(normalizedContent),
	};
	const qualityScore = scoreGates(gates);
	const requestedConfidence = input.confidence ?? 0.8;
	const confidenceApplied =
		Math.round(
			Math.min(requestedConfidence, confidenceCeiling(qualityScore)) * 100,
		) / 100;
	const priorityApplied =
		qualityScore < 0.5
			? "background"
			: input.priority === "core" && qualityScore < 0.7
				? "active"
				: (input.priority ?? "active");
	const status =
		qualityScore >= 0.75
			? "accepted"
			: qualityScore >= 0.5
				? "probation"
				: "weak";

	return {
		version: 1,
		producer,
		sourceKind,
		qualityScore,
		status,
		gates,
		contentHash: input.sourceHash,
		dedupeKey: `${input.domain}:${input.sourceHash}`,
		confidenceRequested: requestedConfidence,
		confidenceApplied,
		priorityApplied,
		evaluatedAt: now,
	};
}

export function mergeBrainWriteMetadata(
	metadata: Record<string, unknown> | null | undefined,
	envelope: BrainWriteQualityEnvelope,
): Record<string, unknown> {
	return {
		...metadata,
		producer: metadataString(metadata, "producer") ?? envelope.producer,
		sourceKind: metadataString(metadata, "sourceKind") ?? envelope.sourceKind,
		brainWrite: envelope,
	};
}
