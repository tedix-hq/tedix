/** Organization purpose revisions and the deterministic owner-attention brief. */

import { and, desc, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type OrganizationPurposeCharter,
	organizationPurposeCharters,
} from "../schema/organization-purpose";
import { tediObjectives } from "../schema/tedi-objectives";
import { workItems } from "../schema/work-items";

export interface CreatePurposeCharterRevisionParams {
	id: string;
	orgId: string;
	purpose: string;
	principles?: string[];
	strategicTheses?: string[];
	nonGoals?: string[];
	evidenceRefs?: string[];
	reviewCadenceDays?: number;
	revisionReason: string;
	createdByUserId?: string | null;
	createdAt: string;
}

export type OwnerAttentionKind = "decision" | "exception" | "outcome";

export interface OwnerAttentionItem {
	id: string;
	title: string;
	kind: OwnerAttentionKind;
	reason: string;
	priority: "critical" | "high" | "medium" | "low";
	objectiveId: string | null;
	projectId: string | null;
	updatedAt: string;
	blocking: boolean;
}

export interface OrganizationOwnerBrief {
	generatedAt: string;
	purposeCharter: OrganizationPurposeCharter | null;
	needsJudgment: OwnerAttentionItem[];
	exceptions: OwnerAttentionItem[];
	outcomes: OwnerAttentionItem[];
	drift: {
		severity: "none" | "watch" | "action";
		activeObjectiveCount: number;
		unlinkedObjectiveCount: number;
		openWorkCount: number;
		unlinkedOpenWorkCount: number;
		activeOperationalExceptionCount: number;
		expiredOperationalExceptionCount: number;
		legacyUnclassifiedOpenWorkCount: number;
		charterReviewOverdue: boolean;
		summary: string;
	};
}

export async function getActivePurposeCharter(
	db: DbClient,
	orgId: string,
): Promise<OrganizationPurposeCharter | undefined> {
	const rows = await db
		.select()
		.from(organizationPurposeCharters)
		.where(
			and(
				eq(organizationPurposeCharters.orgId, orgId),
				eq(organizationPurposeCharters.status, "active"),
			),
		)
		.limit(1);
	return rows[0];
}

export async function getPurposeCharterById(
	db: DbClient,
	id: string,
): Promise<OrganizationPurposeCharter | undefined> {
	const rows = await db
		.select()
		.from(organizationPurposeCharters)
		.where(eq(organizationPurposeCharters.id, id))
		.limit(1);
	return rows[0];
}

export async function listPurposeCharterRevisions(
	db: DbClient,
	orgId: string,
	limit = 20,
): Promise<OrganizationPurposeCharter[]> {
	return db
		.select()
		.from(organizationPurposeCharters)
		.where(eq(organizationPurposeCharters.orgId, orgId))
		.orderBy(desc(organizationPurposeCharters.version))
		.limit(Math.min(Math.max(limit, 1), 100));
}

/**
 * Activate a new immutable revision and supersede the old one in one D1 batch.
 * Unique (org,version) and the partial one-active-per-org index fence races.
 */
export async function createPurposeCharterRevision(
	db: DbClient,
	data: CreatePurposeCharterRevisionParams,
): Promise<OrganizationPurposeCharter> {
	const [current, versionRows] = await Promise.all([
		getActivePurposeCharter(db, data.orgId),
		db
			.select({
				maxVersion: sql<number>`coalesce(max(${organizationPurposeCharters.version}), 0)`,
			})
			.from(organizationPurposeCharters)
			.where(eq(organizationPurposeCharters.orgId, data.orgId)),
	]);
	const version = Number(versionRows[0]?.maxVersion ?? 0) + 1;
	const insert = db.insert(organizationPurposeCharters).values({
		id: data.id,
		orgId: data.orgId,
		version,
		status: "active",
		purpose: data.purpose.trim(),
		principles: data.principles ?? [],
		strategicTheses: data.strategicTheses ?? [],
		nonGoals: data.nonGoals ?? [],
		evidenceRefs: data.evidenceRefs ?? [],
		reviewCadenceDays: data.reviewCadenceDays ?? 30,
		revisionReason: data.revisionReason.trim(),
		createdByUserId: data.createdByUserId ?? null,
		createdAt: data.createdAt,
		activatedAt: data.createdAt,
	});

	if (current) {
		await db.batch([
			db
				.update(organizationPurposeCharters)
				.set({ status: "superseded", supersededAt: data.createdAt })
				.where(eq(organizationPurposeCharters.id, current.id)),
			insert,
		]);
	} else {
		// The first charter gives legacy active objectives an explicit purpose
		// without rewriting them on every later revision. Future revisions leave
		// alignment visible for deliberate owner review.
		await db.batch([
			insert,
			db
				.update(tediObjectives)
				.set({ purposeCharterId: data.id, updatedAt: data.createdAt })
				.where(
					and(
						eq(tediObjectives.orgId, data.orgId),
						eq(tediObjectives.status, "active"),
						isNull(tediObjectives.purposeCharterId),
					),
				),
		]);
	}

	const created = await db
		.select()
		.from(organizationPurposeCharters)
		.where(eq(organizationPurposeCharters.id, data.id))
		.limit(1);
	return created[0]!;
}

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

function attentionRow(
	row: typeof workItems.$inferSelect,
	kind: OwnerAttentionKind,
	reason: string,
	blocking: boolean,
): OwnerAttentionItem {
	return {
		id: row.id,
		title: row.title,
		kind,
		reason,
		priority: row.priority,
		objectiveId: row.objectiveId,
		projectId: row.projectId,
		updatedAt: row.updatedAt ?? row.completedAt ?? row.createdAt,
		blocking,
	};
}

function rankAttention(a: OwnerAttentionItem, b: OwnerAttentionItem): number {
	return (
		PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
		Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

function requestedOwnerQuestion(
	metadata: Record<string, unknown> | null,
): string | null {
	const ownerAttention = metadata?.ownerAttention;
	if (
		!ownerAttention ||
		typeof ownerAttention !== "object" ||
		Array.isArray(ownerAttention)
	) {
		return null;
	}
	const request = ownerAttention as Record<string, unknown>;
	if (request.requiresOwner !== true) return null;
	const question =
		typeof request.question === "string" ? request.question.trim() : "";
	return question || "This work explicitly requests owner judgment.";
}

function marketingEvaluationOutcome(
	item: {
		metadata: Record<string, unknown> | null;
		disposition: string;
	},
	now: string,
): string | null {
	const raw = item.metadata?.marketingEvaluation;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const evaluation = raw as Record<string, unknown>;
	if (
		evaluation.kind !== "checkpoint" ||
		typeof evaluation.windowDays !== "number" ||
		typeof evaluation.notBefore !== "string"
	) {
		return null;
	}
	const result =
		evaluation.result &&
		typeof evaluation.result === "object" &&
		!Array.isArray(evaluation.result)
			? (evaluation.result as Record<string, unknown>)
			: null;
	if (result) {
		const review =
			evaluation.review &&
			typeof evaluation.review === "object" &&
			!Array.isArray(evaluation.review)
				? (evaluation.review as Record<string, unknown>)
				: null;
		const independentlyAccepted =
			item.disposition === "completed" && review?.accepted === true;
		const metrics =
			result.metrics &&
			typeof result.metrics === "object" &&
			!Array.isArray(result.metrics)
				? Object.entries(result.metrics as Record<string, unknown>)
						.filter((entry): entry is [string, number] =>
							Number.isFinite(entry[1]),
						)
						.slice(0, 3)
						.map(([key, value]) => `${key} ${value}`)
				: [];
		const qualifiedDemand =
			typeof result.qualifiedDemandCount === "number"
				? `${result.qualifiedDemandCount} qualified demand`
				: null;
		const measurements = [
			...metrics,
			...(qualifiedDemand ? [qualifiedDemand] : []),
		];
		const summary =
			typeof result.summary === "string" ? result.summary.trim() : "";
		return [
			independentlyAccepted
				? `Day ${evaluation.windowDays}: ${String(result.status ?? "observed")}`
				: `Day ${evaluation.windowDays}: proposed ${String(result.status ?? "observed")}, awaiting independent review`,
			measurements.length > 0 ? measurements.join(", ") : null,
			summary || null,
		]
			.filter(Boolean)
			.join(" — ");
	}
	if (
		["proposed", "accepted"].includes(item.disposition) &&
		evaluation.notBefore <= now
	) {
		return `Day ${evaluation.windowDays}: not reviewed; the CMO evaluation is due.`;
	}
	return null;
}

/**
 * A bounded, deterministic brief for the human owner. It deliberately reports
 * exceptions and decisions rather than narrating every board event.
 */
export async function getOrganizationOwnerBrief(
	db: DbClient,
	params: { orgId: string; now: string; outcomeWindowDays?: number },
): Promise<OrganizationOwnerBrief> {
	const outcomeWindowDays = params.outcomeWindowDays ?? 7;
	const outcomeCutoff = new Date(
		Date.parse(params.now) - outcomeWindowDays * 86_400_000,
	).toISOString();
	const openStatuses = ["proposed", "accepted"] as const;

	const [
		purposeCharter,
		activeObjectives,
		openWork,
		recentDone,
		openWorkCount,
		unlinkedOpenWorkCount,
		activeOperationalExceptionCount,
		expiredOperationalExceptionCount,
		legacyUnclassifiedOpenWorkCount,
	] = await Promise.all([
		getActivePurposeCharter(db, params.orgId),
		db
			.select({
				id: tediObjectives.id,
				purposeCharterId: tediObjectives.purposeCharterId,
			})
			.from(tediObjectives)
			.where(
				and(
					eq(tediObjectives.orgId, params.orgId),
					eq(tediObjectives.status, "active"),
				),
			),
		db
			.select()
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, params.orgId),
					inArray(workItems.disposition, [...openStatuses]),
				),
			)
			.orderBy(desc(workItems.updatedAt), desc(workItems.createdAt))
			.limit(500),
		db
			.select()
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, params.orgId),
					eq(workItems.disposition, "completed"),
					gte(workItems.completedAt, outcomeCutoff),
				),
			)
			.orderBy(desc(workItems.completedAt))
			.limit(100),
		db.$count(
			workItems,
			and(
				eq(workItems.orgId, params.orgId),
				inArray(workItems.disposition, [...openStatuses]),
			),
		),
		db.$count(
			workItems,
			and(
				eq(workItems.orgId, params.orgId),
				inArray(workItems.disposition, [...openStatuses]),
				isNull(workItems.objectiveId),
			),
		),
		db.$count(
			workItems,
			and(
				eq(workItems.orgId, params.orgId),
				inArray(workItems.disposition, [...openStatuses]),
				inArray(workItems.workClass, ["maintenance", "incident", "hygiene"]),
				gt(workItems.purposeExceptionExpiresAt, params.now),
			),
		),
		db.$count(
			workItems,
			and(
				eq(workItems.orgId, params.orgId),
				inArray(workItems.disposition, [...openStatuses]),
				inArray(workItems.workClass, ["maintenance", "incident", "hygiene"]),
				lte(workItems.purposeExceptionExpiresAt, params.now),
			),
		),
		db.$count(
			workItems,
			and(
				eq(workItems.orgId, params.orgId),
				inArray(workItems.disposition, [...openStatuses]),
				isNull(workItems.objectiveId),
				isNull(workItems.workClass),
			),
		),
	]);

	const needsJudgment = openWork
		.map((item) => ({
			item,
			question:
				item.disposition === "accepted"
					? requestedOwnerQuestion(item.metadata)
					: null,
		}))
		.filter(
			(
				entry,
			): entry is {
				item: (typeof openWork)[number];
				question: string;
			} => entry.question !== null,
		)
		.map(({ item, question }) =>
			attentionRow(item, "decision", question, false),
		)
		.sort(rankAttention)
		.slice(0, 3);

	const nowMs = Date.parse(params.now);
	const exceptions = openWork
		.filter(
			(item) =>
				item.workClass != null &&
				item.workClass !== "objective" &&
				item.purposeExceptionExpiresAt != null,
		)
		.map((item) =>
			attentionRow(
				item,
				"exception",
				item.purposeExceptionExpiresAt != null &&
					Date.parse(item.purposeExceptionExpiresAt) <= nowMs
					? "This operational exception expired and needs an objective, renewal, or closure."
					: "This operational exception remains active.",
				true,
			),
		)
		.sort(rankAttention)
		.slice(0, 3);

	const marketingOutcomeEntries = [...openWork, ...recentDone]
		.map((item) => ({
			item,
			reason: marketingEvaluationOutcome(item, params.now),
		}))
		.filter(
			(
				entry,
			): entry is {
				item: (typeof openWork)[number];
				reason: string;
			} => entry.reason !== null,
		)
		.map(({ item, reason }) => attentionRow(item, "outcome", reason, false));
	const marketingOutcomeIds = new Set(
		marketingOutcomeEntries.map((item) => item.id),
	);

	const outcomes = [
		...marketingOutcomeEntries,
		...recentDone
			.filter(
				(item) => item.objectiveId != null && !marketingOutcomeIds.has(item.id),
			)
			.map((item) =>
				attentionRow(
					item,
					"outcome",
					"Completed with an explicit objective link.",
					false,
				),
			),
	]
		.sort(rankAttention)
		.slice(0, 3);

	const unlinkedObjectiveCount = activeObjectives.filter(
		(objective) =>
			!purposeCharter || objective.purposeCharterId !== purposeCharter.id,
	).length;
	const reviewDueAt = purposeCharter
		? Date.parse(purposeCharter.activatedAt) +
			purposeCharter.reviewCadenceDays * 86_400_000
		: 0;
	const charterReviewOverdue = purposeCharter != null && nowMs >= reviewDueAt;
	const driftSeverity =
		!purposeCharter ||
		legacyUnclassifiedOpenWorkCount > 0 ||
		expiredOperationalExceptionCount > 0
			? "action"
			: charterReviewOverdue ||
				  unlinkedObjectiveCount > 0 ||
				  activeOperationalExceptionCount > 0
				? "watch"
				: "none";
	const summary = !purposeCharter
		? "No active Purpose Charter exists; activity cannot be evaluated against human-owned direction."
		: legacyUnclassifiedOpenWorkCount > 0
			? `${legacyUnclassifiedOpenWorkCount} open Work Item${legacyUnclassifiedOpenWorkCount === 1 ? " lacks" : "s lack"} an objective or bounded operational classification.`
			: expiredOperationalExceptionCount > 0
				? `${expiredOperationalExceptionCount} operational exception${expiredOperationalExceptionCount === 1 ? " has" : "s have"} expired and needs an objective, renewal, or closure.`
				: unlinkedObjectiveCount > 0
					? `${unlinkedObjectiveCount} active objective${unlinkedObjectiveCount === 1 ? " is" : "s are"} not linked to the active charter.`
					: charterReviewOverdue
						? "The Purpose Charter is due for a human review."
						: activeOperationalExceptionCount > 0
							? `${activeOperationalExceptionCount} bounded operational exception${activeOperationalExceptionCount === 1 ? " is" : "s are"} active alongside objective-linked work.`
							: "Active objectives interpret the current Purpose Charter.";

	return {
		generatedAt: params.now,
		purposeCharter: purposeCharter ?? null,
		needsJudgment,
		exceptions,
		outcomes,
		drift: {
			severity: driftSeverity,
			activeObjectiveCount: activeObjectives.length,
			unlinkedObjectiveCount,
			openWorkCount,
			unlinkedOpenWorkCount,
			activeOperationalExceptionCount,
			expiredOperationalExceptionCount,
			legacyUnclassifiedOpenWorkCount,
			charterReviewOverdue,
			summary,
		},
	};
}
