import { safeExceptionTopology } from "../../lib/safe-log-metadata";

const MAX_CONTENT_BYTES = 32_000;
const MAX_QUERY_BYTES = 1_024;
const FACT_SESSION_PREFIX = "fact:";

type AgentMemoryFailureOperation = "projection" | "recall" | "relevance_recall";
type AgentMemoryFailureStage =
	| "get_profile"
	| "delete_session"
	| "remember"
	| "recall"
	| "fallback";

function logAgentMemoryFailure(
	operation: AgentMemoryFailureOperation,
	stage: AgentMemoryFailureStage,
	error: unknown,
	totalMs?: number,
): void {
	console.error({
		component: "api.agent-memory",
		event: "agent_memory_failed",
		operation,
		stage,
		...(totalMs !== undefined && { totalMs }),
		exception: safeExceptionTopology(error),
	});
}

export interface CanonicalMemoryProjection {
	factId: string;
	content: string;
	summary?: string | null;
	factType: string;
	confidence: number;
}

export interface GovernedCanonicalMemoryProjection extends CanonicalMemoryProjection {
	orgId: string;
	tediId?: string | null;
	memoryScope?: string | null;
	usePolicy?: string | null;
	reviewStatus?: string | null;
	archivedAt?: string | null;
	validTo?: string | null;
}

export interface AgentMemoryCandidate {
	factId: string;
	score: number;
}

/**
 * How many candidate ids one Home-turn recall asks for: twice the six facts
 * the prompt renders, so D1 hydration and eligibility filtering still leave a
 * full slate. Shared by the DO-ingress start and in-assembly fallback so both
 * issue the identical request.
 */
export const HOME_RELEVANCE_RECALL_CANDIDATE_LIMIT = 12;

const BLOCKED_REVIEW_STATUSES = new Set([
	"restricted",
	"rejected",
	"superseded",
	"stale",
	"disputed",
]);

export function isCanonicalMemoryReviewAllowed(
	reviewStatus?: string | null,
): boolean {
	return !BLOCKED_REVIEW_STATUSES.has(reviewStatus ?? "");
}

export function isCanonicalMemoryProjectable(
	fact: GovernedCanonicalMemoryProjection,
): boolean {
	return (
		!fact.archivedAt &&
		!fact.validTo &&
		fact.memoryScope !== "graph" &&
		fact.usePolicy !== "do_not_inject_automatically" &&
		isCanonicalMemoryReviewAllowed(fact.reviewStatus)
	);
}

export function agentMemoryOrgProfileName(orgId: string): string {
	return `org-${orgId}`.slice(0, 100);
}

export function agentMemoryTediProfileName(
	orgId: string,
	tediId: string,
): string {
	return `org-${orgId}-tedi-${tediId}`.slice(0, 100);
}

export function agentMemoryProjectionProfileNames(params: {
	orgId: string;
	tediId?: string | null;
	memoryScope?: string | null;
}): string[] {
	if (params.memoryScope === "tedi" && params.tediId) {
		return [agentMemoryTediProfileName(params.orgId, params.tediId)];
	}
	return [agentMemoryOrgProfileName(params.orgId)];
}

export function agentMemoryFactSessionId(factId: string): string {
	return `${FACT_SESSION_PREFIX}${factId}`.slice(0, 64);
}

export function factIdFromAgentMemorySession(
	sessionId: string | null,
): string | null {
	if (!sessionId?.startsWith(FACT_SESSION_PREFIX)) return null;
	const factId = sessionId.slice(FACT_SESSION_PREFIX.length);
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		factId,
	)
		? factId
		: null;
}

function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(value);
	return bytes.byteLength <= maxBytes
		? value
		: new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function projectionContent(fact: CanonicalMemoryProjection): string {
	return truncateUtf8(
		[
			"Tedix governed memory projection. D1 remains canonical.",
			`Canonical fact: ${fact.factId}`,
			`Type: ${fact.factType}`,
			`Confidence: ${fact.confidence}`,
			fact.summary ? `Summary: ${fact.summary}` : null,
			`Content: ${fact.content}`,
		]
			.filter((line): line is string => line !== null)
			.join("\n"),
		MAX_CONTENT_BYTES,
	);
}

export async function projectCanonicalMemory(
	namespace: AgentMemoryNamespace,
	profileName: string,
	fact: CanonicalMemoryProjection,
): Promise<void> {
	const startedAt = Date.now();
	let stage: AgentMemoryFailureStage = "get_profile";
	try {
		const profile = await namespace.getProfile(profileName);
		const sessionId = agentMemoryFactSessionId(fact.factId);
		stage = "delete_session";
		await profile.deleteSession(sessionId);
		stage = "remember";
		await profile.remember({ content: projectionContent(fact), sessionId });
		console.log("[agent-memory.projection] complete", {
			factId: fact.factId,
			profileName,
			totalMs: Date.now() - startedAt,
		});
	} catch (error) {
		logAgentMemoryFailure("projection", stage, error, Date.now() - startedAt);
		throw error;
	}
}

export async function deleteCanonicalMemoryProjection(
	namespace: AgentMemoryNamespace,
	profileNames: Iterable<string>,
	factId: string,
): Promise<void> {
	const sessionId = agentMemoryFactSessionId(factId);
	await Promise.all(
		[...new Set(profileNames)].map(async (profileName) => {
			const profile = await namespace.getProfile(profileName);
			await profile.deleteSession(sessionId);
		}),
	);
}

/** Reconcile the rebuildable semantic projection from one canonical D1 row. */
export async function reconcileCanonicalMemoryProjection(
	namespace: AgentMemoryNamespace,
	fact: GovernedCanonicalMemoryProjection,
): Promise<void> {
	const profileNames = agentMemoryProjectionProfileNames(fact);
	if (!isCanonicalMemoryProjectable(fact)) {
		await deleteCanonicalMemoryProjection(namespace, profileNames, fact.factId);
		return;
	}
	await projectCanonicalMemory(namespace, profileNames[0]!, fact);
}

export async function recallCanonicalMemoryCandidates(
	namespace: AgentMemoryNamespace,
	params: {
		orgId: string;
		tediId?: string;
		query: string;
		limit: number;
	},
): Promise<AgentMemoryCandidate[]> {
	const query = truncateUtf8(params.query.trim(), MAX_QUERY_BYTES);
	if (!query) return [];
	const profileNames = [agentMemoryOrgProfileName(params.orgId)];
	if (params.tediId) {
		profileNames.push(agentMemoryTediProfileName(params.orgId, params.tediId));
	}
	const recalled = await Promise.all(
		profileNames.map(async (profileName) => {
			const startedAt = Date.now();
			let stage: AgentMemoryFailureStage = "get_profile";
			try {
				const profile = await namespace.getProfile(profileName);
				stage = "recall";
				const result = await profile.recall(query, {
					thinkingLevel: "low",
					responseLength: "short",
				});
				console.log("[agent-memory.recall] complete", {
					profileName,
					totalMs: Date.now() - startedAt,
					candidateCount: result.candidates.length,
					hasAnswer: result.answer.trim().length > 0,
					skipReason: result.answer.trim() ? null : "no_match",
					canonicalCandidateCount: result.candidates.filter(
						(candidate) =>
							factIdFromAgentMemorySession(candidate.sessionId) !== null,
					).length,
				});
				return result;
			} catch (error) {
				logAgentMemoryFailure("recall", stage, error, Date.now() - startedAt);
				throw error;
			}
		}),
	);
	const bestByFact = new Map<string, number>();
	// Cloudflare documents an empty answer as no matching memories. Candidates
	// alone can still contain retrieval neighbors; never inject those as a match.
	for (const result of recalled) {
		if (!result.answer.trim()) continue;
		for (const candidate of result.candidates) {
			const factId = factIdFromAgentMemorySession(candidate.sessionId);
			if (!factId) continue;
			bestByFact.set(
				factId,
				Math.max(
					bestByFact.get(factId) ?? Number.NEGATIVE_INFINITY,
					candidate.score,
				),
			);
		}
	}
	return [...bestByFact.entries()]
		.map(([factId, score]) => ({ factId, score }))
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(0, params.limit));
}

/**
 * Start a semantic recall that NEVER rejects — a failure logs and resolves to
 * no candidates. This is the shape the Home kernel hot path needs: one
 * org-profile recall can take several seconds, because `recall` always synthesizes an answer
 * with a model call and the platform offers no retrieval-only path. The
 * kernel therefore starts the recall as early as it can (`KernelDO.processTurn`
 * entry, before the turn body's module imports) and bounds how long context
 * assembly waits for it. Authorization is unchanged: the result is ids only,
 * hydrated and filtered from canonical D1 before any content reaches a prompt.
 */
export function startRelevanceRecall(
	namespace: AgentMemoryNamespace,
	params: { orgId: string; query: string; limit: number },
): Promise<AgentMemoryCandidate[]> {
	return recallCanonicalMemoryCandidates(namespace, params).catch(
		(error: unknown) => {
			logAgentMemoryFailure("relevance_recall", "fallback", error);
			return [];
		},
	);
}
