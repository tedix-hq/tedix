/**
 * Home Conversation Brain Observer
 *
 * Mines explicit operator decisions from the Home (operator↔kernel)
 * conversation into institutional memory. Runs as a single step inside
 * MemoryReflectionWorkflow.
 *
 * Decision signals mined:
 *   - audit_events: approval.approved / approval.rejected (approval_request),
 *     kernel.run.canceled, kernel.run.retried.
 *   - kernel_runtime_events (kind=decision.recorded): home.plan.approved /
 *     home.plan.rejected. Plan approvals are always operator-initiated (the
 *     write-tier auto-approve path only resolves home_tool_write approvals), so
 *     no operator-vs-auto filter is needed here.
 *
 * Gates (see docs/engineering/cognition/brain.md):
 *   - Source URI: home:reflection:{orgId}:{eventId}
 *   - Scope: orgId always set; tediId only when the decision named a tedi
 *   - Visibility: "org"; confidence <= 0.7 (operator decisions are reversible)
 *   - Dedup: per-event source URI + content hash + the learn envelope's
 *     semantic dedup. Operator decisions are distinct from a tedi's work
 *     observations, so this cannot re-bridge tedi work.
 *   - PII strip: no raw actor IDs, IPs, or payload content beyond the summary
 *   - Budget: max 50 facts per call, shared across both sources
 *   - Selectivity: only human operator decisions (actor_type="user")
 *
 * For delegation decisions, the kernel's own routing rationale (run metadata
 * `kernelRoute`, shape per route-schema.ts) is folded into the fact text,
 * clamped to 200 chars and newline-stripped. When it is absent the fact is the
 * bare delegated-to line.
 */

import type { DbClient } from "@tedix/db/client";
import {
	hasActiveMemoryFactSource,
	listHomeOperatorDecisionAuditEvents,
	listHomePlanDecisionEvents,
} from "@tedix/db/queries/home-reflection";
import { getOrCreateDomain } from "@tedix/db/queries/memory-graph/domains";
import {
	createFact,
	findFactBySourceHash,
	recordFactVerification,
} from "@tedix/db/queries/memory-graph/facts";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	buildBrainWriteQualityEnvelope,
	mergeBrainWriteMetadata,
} from "./brain-write-quality";

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** Max facts written per org per cycle — prevents noise bursts. */
const MAX_FACTS_PER_CYCLE = 50;

/** Lookback window for audit events (hours). Matches the reflection cron cadence. */
const LOOKBACK_HOURS = 9;

/** Explicit operator decision actions we mine. */
const DECISION_ACTIONS = [
	"approval.approved",
	"approval.rejected",
	"kernel.run.canceled",
	"kernel.run.retried",
] as const;

type DecisionAction = (typeof DECISION_ACTIONS)[number];

const PRODUCER_NAME = "home-reflection";
const DOMAIN_NAME = "operations";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface DecisionFact {
	content: string;
	tediId: string | null;
	childRunId: string | null;
	eventId: string;
	action: string;
}

export interface HomeReflectionResult {
	eventsScanned: number;
	factsWritten: number;
	factsSkipped: number;
	budgetHit: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Route-rationale extraction
// ────────────────────────────────────────────────────────────────────────────

/** Hard bound on the folded kernel rationale clause (chars). */
const RATIONALE_MAX_CHARS = 200;

/**
 * Clamp a free-text clause to a hard char bound and strip newlines/tabs so the
 * fact text stays single-line and bounded. Collapses interior whitespace runs.
 */
function clampClause(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? flat.slice(0, max).trimEnd() : flat;
}

/**
 * Pull the kernel's own routing rationale off a run/audit metadata record's
 * `kernelRoute` object (shape per route-schema.ts).
 * Returns the clamped, newline-stripped rationale string, or null when absent or
 * non-string (fail-soft → caller keeps the bare fact text).
 */
function extractRouteRationale(
	metadata: Record<string, unknown>,
): string | null {
	const route = metadata.kernelRoute;
	if (route == null || typeof route !== "object") return null;
	const rationale = (route as Record<string, unknown>).rationale;
	if (typeof rationale !== "string") return null;
	const clamped = clampClause(rationale, RATIONALE_MAX_CHARS);
	return clamped.length > 0 ? clamped : null;
}

/**
 * Build the "why this tedi" clause folded onto a delegation decision fact.
 * No raw actor IDs/IPs/payload — only the chosen tedi id (already a delegation
 * target, not PII) plus the kernel's clamped, sanitized rationale.
 */
function buildDelegationRationaleClause(
	delegatedTediId: string,
	metadata: Record<string, unknown>,
): string | null {
	const rationale = extractRouteRationale(metadata);
	if (!rationale) return null;
	return `Kernel delegated to tedi ${delegatedTediId} for this request because: ${rationale}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Decision fact extraction
// ────────────────────────────────────────────────────────────────────────────

function buildDecisionContent(
	action: DecisionAction,
	metadata: Record<string, unknown>,
	resourceId: string | null,
): string | null {
	// Smoke / CLI / answerless turns: skip anything without meaningful context
	const actionType =
		typeof metadata.actionType === "string" ? metadata.actionType : null;
	// The approval path records the operator note as `resolution`; cancel uses
	// `reason`. Prefer whichever is present (kernel-runtime.ts respondApproval /
	// cancelRun audit metadata).
	const note = (() => {
		const resolution =
			typeof metadata.resolution === "string"
				? metadata.resolution.trim()
				: null;
		const reason =
			typeof metadata.reason === "string" ? metadata.reason.trim() : null;
		return resolution || reason || null;
	})();
	const delegatedTediId =
		typeof metadata.delegatedTediId === "string"
			? metadata.delegatedTediId
			: null;
	// cancel/retry audit rows carry the run id as resourceId, not in metadata;
	// approvals carry homeRunId. Use whichever identifies the run.
	const homeRunId =
		typeof metadata.homeRunId === "string"
			? metadata.homeRunId
			: typeof resourceId === "string" && resourceId.length > 0
				? resourceId
				: null;

	switch (action) {
		case "approval.approved": {
			if (!actionType) return null;
			const target = actionType.replace(/_/g, " ");
			const suffix = note ? ` (note: ${note.slice(0, 120)})` : "";
			return `Operator approved ${target}${suffix}`.slice(0, 400);
		}
		case "approval.rejected": {
			if (!actionType) return null;
			const target = actionType.replace(/_/g, " ");
			const suffix = note ? ` (reason: ${note.slice(0, 120)})` : "";
			return `Operator rejected ${target}${suffix}`.slice(0, 400);
		}
		case "kernel.run.canceled": {
			const tediLabel = delegatedTediId
				? ` delegated to tedi ${delegatedTediId}`
				: "";
			const suffix = note ? ` (reason: ${note.slice(0, 120)})` : "";
			const runSuffix = homeRunId ? ` [run ${homeRunId.slice(0, 8)}]` : "";
			// When the decision concerns a delegation, fold the kernel's own
			// routing rationale (WHY this tedi) onto the fact. Fail-soft → bare line.
			const why = delegatedTediId
				? buildDelegationRationaleClause(delegatedTediId, metadata)
				: null;
			const whySuffix = why ? `. ${why}` : "";
			return `Operator canceled a Home run${tediLabel}${suffix}${runSuffix}${whySuffix}`.slice(
				0,
				400,
			);
		}
		case "kernel.run.retried": {
			const tediLabel = delegatedTediId ? ` to tedi ${delegatedTediId}` : "";
			const runSuffix = homeRunId ? ` [run ${homeRunId.slice(0, 8)}]` : "";
			// Fold the kernel's routing rationale onto a delegation retry too.
			const why = delegatedTediId
				? buildDelegationRationaleClause(delegatedTediId, metadata)
				: null;
			const whySuffix = why ? `. ${why}` : "";
			return `Operator retried a failed Home run${tediLabel}${runSuffix}${whySuffix}`.slice(
				0,
				400,
			);
		}
	}
}

function extractTediId(
	action: DecisionAction,
	metadata: Record<string, unknown>,
): string | null {
	if (action === "approval.approved" || action === "approval.rejected") {
		const tediId = metadata.tediId;
		return typeof tediId === "string" && tediId.length > 0 ? tediId : null;
	}
	if (action === "kernel.run.canceled" || action === "kernel.run.retried") {
		const delegatedTediId = metadata.delegatedTediId;
		return typeof delegatedTediId === "string" && delegatedTediId.length > 0
			? delegatedTediId
			: null;
	}
	return null;
}

function extractChildRunId(metadata: Record<string, unknown>): string | null {
	const childRunId = metadata.childRunId;
	return typeof childRunId === "string" && childRunId.length > 0
		? childRunId
		: null;
}

// ────────────────────────────────────────────────────────────────────────────
// Source hash
// ────────────────────────────────────────────────────────────────────────────

async function contentHash(content: string): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(content.trim().toLowerCase()),
	);
	return [...new Uint8Array(buf)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Per-event source dedup: skip if we already wrote this exact audit event in a
// prior reflection cycle. Source URI is home:reflection:{orgId}:{auditEventId}.
async function hasFact(
	db: DbClient,
	orgId: string,
	source: string,
): Promise<boolean> {
	return hasActiveMemoryFactSource(db, { organizationId: orgId, source });
}

// ────────────────────────────────────────────────────────────────────────────
// Write fact through memory_learn boundary
// ────────────────────────────────────────────────────────────────────────────

async function writeFact(
	db: DbClient,
	orgId: string,
	fact: DecisionFact,
): Promise<boolean> {
	const sourceUri = `home:reflection:${orgId}:${fact.eventId}`;

	// Per-event source dedup: skip if we already wrote this event
	const alreadyWritten = await hasFact(db, orgId, sourceUri);
	if (alreadyWritten) return false;

	const hash = await contentHash(fact.content);

	// Content-hash dedup: exact same content already in memory — boost instead of insert
	const existingByHash = await findFactBySourceHash(db, orgId, hash);
	if (existingByHash) {
		await recordFactVerification(db, existingByHash.id, 1.01);
		return false;
	}

	const domain = await getOrCreateDomain(db, orgId, DOMAIN_NAME);
	const visibility = "org";
	// Confidence <= 0.7: operator can reverse a decision (probationary by default)
	const requestedConfidence = 0.65;

	const metadata: Record<string, unknown> = {
		producer: PRODUCER_NAME,
		sourceKind: "brain-reflection",
		expectedUse:
			"Surface operator intent patterns to future kernel planning and tedi allocation",
		confidenceReason:
			"Explicit operator action from audit log; decision is reversible",
		homeProducer: "home-reflection",
		decisionAction: fact.action,
		...(fact.childRunId ? { homeChildRunId: fact.childRunId } : {}),
		...(fact.tediId ? { decisionTediId: fact.tediId } : {}),
	};

	const writeQuality = buildBrainWriteQualityEnvelope({
		content: fact.content,
		domain: DOMAIN_NAME,
		confidence: requestedConfidence,
		priority: "active",
		source: sourceUri,
		sourceHash: hash,
		metadata,
	});
	const mergedMeta = mergeBrainWriteMetadata(metadata, writeQuality);

	const factId = crypto.randomUUID();
	const createdAt = new Date().toISOString();
	await createFact(db, {
		id: factId,
		organizationId: orgId,
		tediId: fact.tediId ?? null,
		domainId: domain.id,
		content: fact.content,
		summary: fact.content.slice(0, 100),
		factType: "decision",
		confidence: writeQuality.confidenceApplied,
		validTo: null,
		archivedAt: null,
		priority: writeQuality.priorityApplied,
		status: "probation",
		validFrom: createdAt,
		source: sourceUri,
		sourceSessionId: null,
		sourceUrl: null,
		sourceHash: hash,
		metadata: toJsonRecord(mergedMeta),
		visibility,
		accessCount: 0,
	});

	return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Plan-decision mining from kernel_runtime_events
// ────────────────────────────────────────────────────────────────────────────

const PLAN_DECISION_ACTIONS = [
	"home.plan.approved",
	"home.plan.rejected",
] as const;

type PlanDecisionAction = (typeof PLAN_DECISION_ACTIONS)[number];

function buildPlanDecisionContent(
	action: PlanDecisionAction,
	payload: Record<string, unknown>,
): string {
	const assignments = Array.isArray(payload.assignments)
		? (payload.assignments as Array<Record<string, unknown>>)
		: [];
	const ownerIds = assignments
		.map((a) => (typeof a.ownerTediId === "string" ? a.ownerTediId : null))
		.filter((id): id is string => id !== null);
	const n = ownerIds.length;
	const tediList = ownerIds.join(", ");

	// Extract a compact objective summary from the homePlan if present.
	// HomePlan.assignments[].objective is a plain string (HomePlanAssignmentSchema).
	// Cap at 120 chars total to avoid PII/noise bleed.
	let objectiveSummary = "";
	const homePlan = payload.homePlan as
		| Record<string, unknown>
		| null
		| undefined;
	if (homePlan && Array.isArray(homePlan.assignments)) {
		const planAssignments = homePlan.assignments as Array<
			Record<string, unknown>
		>;
		const objectives = planAssignments
			.map((a) => (typeof a.objective === "string" ? a.objective.trim() : null))
			.filter((o): o is string => o !== null && o.length > 0);
		if (objectives.length > 0) {
			const joined = objectives.join("; ");
			objectiveSummary =
				joined.length > 120 ? `${joined.slice(0, 117)}...` : joined;
		}
	}

	if (action === "home.plan.approved") {
		const base = `Operator approved a plan delegating to ${n} tedi${n === 1 ? "" : "s"}: ${tediList}`;
		const suffix = objectiveSummary ? `. Objectives: ${objectiveSummary}` : "";
		return `${base}${suffix}`.slice(0, 400);
	}
	// home.plan.rejected
	const base = `Operator rejected a proposed plan with ${n} tedi${n === 1 ? "" : "s"}: ${tediList}`;
	const suffix = objectiveSummary ? `. Objectives: ${objectiveSummary}` : "";
	return `${base}${suffix}`.slice(0, 400);
}

function extractPlanTediId(
	assignments: Array<Record<string, unknown>>,
): string | null {
	const ownerIds = assignments
		.map((a) => (typeof a.ownerTediId === "string" ? a.ownerTediId : null))
		.filter((id): id is string => id !== null);
	// Tedi-scoped only when exactly one owner; multi-owner → org-scoped (null)
	return ownerIds.length === 1 ? (ownerIds[0] ?? null) : null;
}

async function minePlanDecisions(
	db: DbClient,
	{ orgId, since }: { orgId: string; since: Date },
	budget: { factsWritten: number; factsSkipped: number; budgetHit: boolean },
): Promise<{ eventsScanned: number }> {
	const planEvents = await listHomePlanDecisionEvents(db, {
		organizationId: orgId,
		since: since.toISOString(),
		limit: MAX_FACTS_PER_CYCLE * 2,
	});

	for (const event of planEvents) {
		if (budget.factsWritten >= MAX_FACTS_PER_CYCLE) {
			budget.budgetHit = true;
			break;
		}

		const payload = (event.payload ?? {}) as Record<string, unknown>;
		const action = payload.action as PlanDecisionAction | undefined;
		if (action !== "home.plan.approved" && action !== "home.plan.rejected") {
			budget.factsSkipped++;
			continue;
		}

		const assignments = Array.isArray(payload.assignments)
			? (payload.assignments as Array<Record<string, unknown>>)
			: [];

		const content = buildPlanDecisionContent(action, payload);
		const tediId = extractPlanTediId(assignments);

		const fact: DecisionFact = {
			content,
			tediId,
			childRunId: null,
			eventId: event.id,
			action,
		};

		try {
			const written = await writeFact(db, orgId, fact);
			if (written) {
				budget.factsWritten++;
			} else {
				budget.factsSkipped++;
			}
		} catch (err) {
			console.error(
				`[home-reflection] Failed to write plan-decision fact for event ${event.id}:`,
				err,
			);
			budget.factsSkipped++;
		}
	}

	return { eventsScanned: planEvents.length };
}

// ────────────────────────────────────────────────────────────────────────────
// Main producer
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mine explicit operator decisions from the Home conversation audit log and
 * plan-decision events from kernel_runtime_events, writing compact decision
 * facts to the brain via the memory_learn boundary.
 *
 * Called from MemoryReflectionWorkflow step "mine-home-decisions".
 */
export async function mineHomeOperatorDecisions(
	db: DbClient,
	{
		orgId,
	}: {
		orgId: string;
	},
): Promise<HomeReflectionResult> {
	const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

	// Query audit_events for explicit operator decision actions in the lookback window
	const events = await listHomeOperatorDecisionAuditEvents(db, {
		organizationId: orgId,
		actions: [...DECISION_ACTIONS],
		since,
		limit: MAX_FACTS_PER_CYCLE * 2,
	});

	const budget = { factsWritten: 0, factsSkipped: 0, budgetHit: false };

	for (const event of events) {
		if (budget.factsWritten >= MAX_FACTS_PER_CYCLE) {
			budget.budgetHit = true;
			break;
		}

		// Defensive: operator decisions are human-initiated. Skip service/automated
		// actors even if the query filter is bypassed (e.g. in tests).
		if (event.actorType !== "user") {
			budget.factsSkipped++;
			continue;
		}

		const metadata = (event.metadata ?? {}) as Record<string, unknown>;
		const action = event.action as DecisionAction;

		const content = buildDecisionContent(action, metadata, event.resourceId);
		if (!content) {
			budget.factsSkipped++;
			continue;
		}

		const tediId = extractTediId(action, metadata);
		const childRunId = extractChildRunId(metadata);

		const fact: DecisionFact = {
			content,
			tediId,
			childRunId,
			eventId: event.id,
			action,
		};

		try {
			const written = await writeFact(db, orgId, fact);
			if (written) {
				budget.factsWritten++;
			} else {
				budget.factsSkipped++;
			}
		} catch (err) {
			console.error(
				`[home-reflection] Failed to write fact for event ${event.id}:`,
				err,
			);
			budget.factsSkipped++;
		}
	}

	// Mine plan-level decisions from kernel_runtime_events (shared budget)
	const { eventsScanned: planEventsScanned } = await minePlanDecisions(
		db,
		{ orgId, since },
		budget,
	);

	return {
		eventsScanned: events.length + planEventsScanned,
		factsWritten: budget.factsWritten,
		factsSkipped: budget.factsSkipped,
		budgetHit: budget.budgetHit,
	};
}
