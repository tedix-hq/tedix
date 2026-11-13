/**
 * Sample Work: items, projects, relations, sprints, milestones, attempts,
 * graph health and the owner brief.
 */

import {
	fid,
	ORG_ID,
	RpcError,
	T0,
	T1,
	T2,
	T3,
	T4,
	T5,
	TEDI_JUNO,
	TEDI_MILES,
	TEDI_NOVA,
} from "./core";

const workItem = (
	n: number,
	title: string,
	status:
		| "candidate"
		| "accepted"
		| "todo"
		| "claimed"
		| "in_progress"
		| "in_review"
		| "blocked"
		| "done"
		| "cancelled"
		| "stale",
	assigneeTediId: string | null,
	priority: "critical" | "high" | "medium" | "low",
	createdAt: string,
	projectKey = "OPS",
) => ({
	id: fid("70", n),
	orgId: ORG_ID,
	title,
	description: null,
	disposition:
		status === "done"
			? ("completed" as const)
			: status === "cancelled"
				? ("cancelled" as const)
				: ["candidate", "todo"].includes(status)
					? ("proposed" as const)
					: ("accepted" as const),
	workKind:
		title.toLowerCase().includes("query") ||
		title.toLowerCase().includes("wire") ||
		title.toLowerCase().includes("widget")
			? ("coding" as const)
			: title.toLowerCase().includes("policy")
				? ("legal" as const)
				: ("communication" as const),
	riskLevel:
		priority === "critical"
			? ("critical" as const)
			: priority === "high"
				? ("high" as const)
				: ("medium" as const),
	acceptanceContract: ["candidate", "todo"].includes(status)
		? null
		: {
				version: 1 as const,
				doneLooksLike: "The named outcome is delivered",
			},
	requiredCapabilities: [],
	requiredAuthorities: [],
	resourceScopes: [],
	budgetLimitMicros: null,
	priority,
	accountableOwnerType: assigneeTediId ? ("tedi" as const) : null,
	accountableOwnerId: assigneeTediId,
	stewardType: assigneeTediId ? ("tedi" as const) : null,
	stewardId: assigneeTediId,
	reviewerType: "user" as const,
	reviewerId: "local-owner",
	reviewerLeaseExpiresAt: null,
	objectiveId: null,
	workClass: "objective" as const,
	purposeExceptionExpiresAt: null,
	projectId: fid("76", PROJECT_NUMBER_BY_KEY[projectKey] ?? 1),
	parentWorkItemId: null,
	sourceSessionKey: null,
	sourceIntentId: null,
	dueDate: null,
	deadline: null,
	startAt: null,
	durationDays: null,
	provenance: null,
	metadata: null,
	admissionSpecRevision: `local-fixture-revision-${n}`,
	createdAt,
	updatedAt: createdAt,
	acceptedAt: ["candidate", "todo"].includes(status) ? null : createdAt,
	completedAt: status === "done" ? T4 : null,
	cancelledAt: status === "cancelled" ? T4 : null,
	version: 1,
});

/** Fixture project number (`fid("76", n)`) for each work item project key. */
const PROJECT_NUMBER_BY_KEY: Record<string, number> = {
	OPS: 1,
	GROWTH: 2,
	PILOT: 4,
	NOTES: 5,
	GUILD: 6,
};

export const WORK_ITEMS = [
	workItem(
		1,
		"Rebuild the churn cohort query with paging",
		"in_progress",
		TEDI_MILES,
		"high",
		T3,
	),
	workItem(
		2,
		"Draft goodwill-credit policy for delayed orders",
		"blocked",
		TEDI_JUNO,
		"medium",
		T4,
	),
	workItem(
		3,
		"Wire the investor deck into the owner sync brief",
		"todo",
		TEDI_NOVA,
		"low",
		T4,
		"GROWTH",
	),
	workItem(
		4,
		"Publish week-32 revenue summary",
		"done",
		TEDI_MILES,
		"medium",
		T1,
	),
	workItem(
		5,
		"Review the dunning-recovery email copy",
		"in_review",
		TEDI_JUNO,
		"medium",
		T5,
		"GROWTH",
	),
	workItem(
		6,
		"Backfill wholesale order attribution",
		"todo",
		TEDI_MILES,
		"critical",
		T2,
	),
	workItem(7, "Ship the churn dashboard widget", "todo", TEDI_NOVA, "high", T3),
	// Deliberate near-duplicate of item 5 — the coherence report's evidence.
	workItem(
		8,
		"Review the dunning recovery email copy",
		"todo",
		TEDI_JUNO,
		"low",
		T5,
		"GROWTH",
	),
	workItem(
		9,
		"Send the bakery pilot proposal",
		"todo",
		TEDI_NOVA,
		"medium",
		T4,
		"PILOT",
	),
	workItem(
		10,
		"Sort the field notes into topics",
		"todo",
		null,
		"low",
		T2,
		"NOTES",
	),
	workItem(
		11,
		"Plan the next makers meetup",
		"in_progress",
		TEDI_NOVA,
		"medium",
		T5,
		"GUILD",
	),
];

export const workItemId = (n: number) => fid("70", n);

// ---------------------------------------------------------------------------
// Work graph: projects, dependency edges, and the derived diagnostic reads.
// The reports are DERIVED from WORK_ITEMS/WORK_ITEM_RELATIONS rather than
// hand-frozen, so editing an item cannot leave the diagnostics describing a
// board that no longer exists.
// ---------------------------------------------------------------------------

const project = (
	n: number,
	key: string,
	name: string,
	status: "active" | "paused" | "archived" | "done",
	archivedAt: string | null = null,
	description: string | null = null,
	extra: {
		metadata?: Record<string, string>;
		leadTediId?: string;
		targetDate?: string;
	} = {},
) => ({
	id: fid("76", n),
	orgId: ORG_ID,
	key,
	name,
	description,
	status,
	leadTediId: extra.leadTediId ?? null,
	ownerUserId: null,
	objectiveId: null,
	targetDate: (extra.targetDate ?? null) as string | null,
	metadata: extra.metadata ?? null,
	createdAt: T0,
	updatedAt: T4 as string,
	archivedAt,
});

/** `metadata.portfolioBucket`/`portfolioTitle` place a project on the Portfolio home. */
export const PROJECTS = [
	project(
		1,
		"OPS",
		"Platform operations",
		"active",
		null,
		"Keep the reporting stack fast and boring.\nGoal: churn cohort and revenue summaries refresh before the Monday owner sync.\nOut of scope: new dashboards.",
		{
			metadata: {
				portfolioBucket: "Projects",
				portfolioTitle: "Reporting platform",
			},
			leadTediId: TEDI_MILES,
			targetDate: "2026-11-30",
		},
	),
	project(2, "GROWTH", "Growth experiments", "active", null, null, {
		metadata: { portfolioBucket: "Active" },
	}),
	project(3, "LEGACY", "Wind-down", "archived", T1, null, {
		metadata: { portfolioBucket: "Side" },
	}),
	project(
		4,
		"PILOT",
		"Corner bakery pilot",
		"active",
		null,
		"No records yet; owner to define",
		{
			metadata: {
				portfolioBucket: " leads ",
				portfolioTitle: "Bakery pilot",
				portfolioOrg: "acme-demo",
			},
		},
	),
	project(5, "NOTES", "Field notes", "paused"),
	project(
		6,
		"GUILD",
		"Makers guild",
		"active",
		null,
		"Monthly meetups for local makers.",
		{ metadata: { portfolioBucket: "Communities" }, leadTediId: TEDI_NOVA },
	),
];

export function localProject(id: string) {
	const row = PROJECTS.find((project) => project.id === id);
	if (!row) throw new RpcError("NOT_FOUND", "Project not found");
	return row;
}

const relation = (
	n: number,
	from: number,
	to: number,
	relationType: "blocks" | "duplicates" | "references",
) => ({
	id: fid("77", n),
	fromWorkItemId: workItemId(from),
	toWorkItemId: workItemId(to),
	relationType,
	createdAt: T2,
});

export const WORK_ITEM_RELATIONS = [
	relation(1, 6, 1, "blocks"),
	relation(2, 1, 7, "blocks"),
	relation(3, 6, 2, "blocks"),
	relation(4, 5, 3, "references"),
];

const TERMINAL_DISPOSITIONS = new Set(["completed", "cancelled"]);

/** Ordering edges in dependency direction (blocker → dependent). */
const ORDERING_EDGES = WORK_ITEM_RELATIONS.flatMap((row) => {
	if (row.relationType === "blocks") {
		return [{ blocker: row.fromWorkItemId, dependent: row.toWorkItemId }];
	}
	return [];
});

export const workItemsInScope = (projectId?: string) =>
	WORK_ITEMS.filter(
		(row) => projectId === undefined || row.projectId === projectId,
	);

// Sprints, milestones and live attempts — the planning reads a linked
// project's Work view makes beside the item list itself.
const sprint = (
	n: number,
	projectN: number,
	name: string,
	goal: string | null,
	status: "planned" | "active" | "completed" | "cancelled",
	startAt: string,
	endAt: string,
	workItemNs: number[],
) => ({
	sprint: {
		id: fid("45", n),
		orgId: ORG_ID,
		projectId: fid("76", projectN),
		name,
		goal,
		status,
		startAt,
		endAt,
		createdAt: T1,
		updatedAt: null,
		version: 1,
	},
	workItemIds: workItemNs.map(workItemId),
});

export const PROJECT_SPRINTS = [
	sprint(
		1,
		1,
		"Week 33 reporting pass",
		"Cohort query and revenue summary land before the Monday owner sync",
		"active",
		T3,
		"2026-08-16T17:00:00.000Z",
		[1, 6],
	),
	sprint(
		2,
		1,
		"Week 34 reporting pass",
		null,
		"planned",
		"2026-08-17T09:00:00.000Z",
		"2026-08-21T17:00:00.000Z",
		[],
	),
];

const milestone = (
	n: number,
	projectN: number,
	title: string,
	lifecycle: "proposed" | "planned" | "active" | "done" | "cancelled",
	targetAt: string | null,
	sortOrder: number,
	workItemNs: number[],
) => ({
	milestone: {
		id: fid("46", n),
		orgId: ORG_ID,
		projectId: fid("76", projectN),
		title,
		description: null,
		lifecycle,
		accountableOwnerType: "tedi" as const,
		accountableOwnerId: TEDI_MILES,
		targetAt,
		proofRef: null,
		completedAt: lifecycle === "done" ? T4 : null,
		cancelledAt: null,
		sortOrder,
		createdAt: T1,
		updatedAt: null,
		version: 1,
	},
	workItemNs,
});

export const PROJECT_MILESTONES = [
	milestone(
		1,
		1,
		"Owner sync refreshes itself",
		"active",
		"2026-08-17T09:00:00.000Z",
		1,
		[1, 4],
	),
	milestone(
		2,
		1,
		"Churn cohort trusted end to end",
		"planned",
		"2026-08-31T17:00:00.000Z",
		2,
		[6],
	),
];

export const workItemSummary = (row: (typeof WORK_ITEMS)[number]) => ({
	id: row.id,
	title: row.title,
	disposition: row.disposition,
	workKind: row.workKind,
	riskLevel: row.riskLevel,
	priority: row.priority,
	projectId: row.projectId,
	accountableOwnerType: row.accountableOwnerType,
	accountableOwnerId: row.accountableOwnerId,
});

/**
 * Live attempts. The workspace Work list and the activity views read these for
 * progress, so the lease expiry rides on the dev server's own clock — a fixed
 * T-time would read as expired the moment the fixture loads.
 */
const workAttempt = (
	n: number,
	workItemN: number,
	executorId: string,
	runtimeState: "queued" | "running" | "waiting" | "retrying",
	summary: string | null,
) => ({
	id: fid("47", n),
	orgId: ORG_ID,
	workItemId: workItemId(workItemN),
	executorType: "tedi" as const,
	executorId,
	executorSessionId: null,
	externalSessionKey: null,
	runtimeState,
	outcome: null,
	runId: `local-attempt-run-${n}`,
	admissionId: fid("47", 0x40 + n),
	attemptNumber: 1,
	startedAt: T5,
	heartbeatAt: T5,
	expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
	finishedAt: null,
	summary,
	metadata: {},
});

export const WORK_ATTEMPTS = [
	workAttempt(1, 1, TEDI_MILES, "running", "Paging the cohort query"),
	workAttempt(2, 2, TEDI_JUNO, "waiting", null),
	workAttempt(3, 5, TEDI_JUNO, "queued", null),
];

export const orgGraphHealthFor = (
	projectId: string | undefined,
	limit: number,
) => {
	const scoped = workItemsInScope(projectId);
	const ids = new Set(scoped.map((row) => row.id));
	const edges = ORDERING_EDGES.filter(
		(edge) => ids.has(edge.blocker) && ids.has(edge.dependent),
	);
	const downstream = new Map<string, string[]>();
	const hasIncoming = new Set(edges.map((edge) => edge.dependent));
	for (const edge of edges) {
		downstream.set(edge.blocker, [
			...(downstream.get(edge.blocker) ?? []),
			edge.dependent,
		]);
	}
	const reach = (id: string): number => {
		const seen = new Set<string>();
		const queue = [...(downstream.get(id) ?? [])];
		while (queue.length > 0) {
			const next = queue.shift();
			if (next === undefined || seen.has(next)) continue;
			seen.add(next);
			queue.push(...(downstream.get(next) ?? []));
		}
		return seen.size;
	};
	const nonTerminal = scoped.filter(
		(row) => !TERMINAL_DISPOSITIONS.has(row.disposition),
	);
	const rootBlockers = nonTerminal
		.filter(
			(row) =>
				!hasIncoming.has(row.id) && (downstream.get(row.id) ?? []).length > 0,
		)
		.map((row) => ({
			id: row.id,
			title: row.title,
			disposition: row.disposition,
			ownerTediId: row.accountableOwnerId,
			downstreamBlockedCount: reach(row.id),
		}))
		.sort((a, b) => b.downstreamBlockedCount - a.downstreamBlockedCount)
		.slice(0, limit);
	const blockerTedis = [
		...new Map(
			rootBlockers
				.filter((row) => row.ownerTediId !== null)
				.map((row) => [
					row.ownerTediId as string,
					{
						tediId: row.ownerTediId as string,
						rootBlockerCount: 1,
						downstreamImpact: row.downstreamBlockedCount,
					},
				]),
		).values(),
	];
	const statusBlocked = nonTerminal
		.filter((row) => row.disposition === "accepted")
		.map((row) => ({
			id: row.id,
			title: row.title,
			priority: row.priority,
			ownerTediId: row.accountableOwnerId,
			ageHours: 31,
		}));
	return {
		orgId: ORG_ID,
		generatedAt: T5,
		limit,
		rootBlockers,
		blockerTedis,
		capabilityStall: [],
		capabilityLinksAvailable: false,
		statusBlocked,
		counts: {
			totalNonTerminal: nonTerminal.length,
			blockedCount: new Set(edges.map((edge) => edge.dependent)).size,
			statusBlockedCount: statusBlocked.length,
			rootBlockerCount: rootBlockers.length,
			scannedCount: edges.length,
			truncated: false,
		},
		notes: ["Capability links are not populated in the local lane."],
	};
};

/**
 * Coherence report. Org-wide by design: the canonical read scopes by canonical
 * projectId only, and these fixture items carry a project_key with a null
 * project_id — exactly the production shape the OS caption warns about.
 */
export const WORK_GRAPH_HEALTH = {
	orgId: ORG_ID,
	projectId: null,
	generatedAt: T5,
	idleThresholdDays: 14,
	dupThreshold: 0.85,
	scannedCount: WORK_ITEMS.length,
	duplicates: [
		{
			canonicalWorkItemId: workItemId(5),
			duplicateWorkItemIds: [workItemId(8)],
			workItemIds: [workItemId(5), workItemId(8)],
			normalizedTitle: "review the dunning recovery email copy",
			method: "jaccard" as const,
			suggestedAction: "link_duplicates" as const,
		},
	],
	idleAccepted: [
		{
			workItemId: workItemId(3),
			title: "Wire the investor deck into the owner sync brief",
			disposition: "accepted" as const,
			readiness: "ready" as const,
			lastActivityAt: T1,
			idleDays: 21,
			suggestedAction: "review_idle" as const,
		},
	],
	naming: [],
	expiredAttempts: [
		{
			workItemId: workItemId(7),
			attemptId: fid("79", 1),
			executorType: "tedi" as const,
			executorId: TEDI_NOVA,
			executorSessionId: null,
			expiresAt: T3,
			suggestedAction: "flag" as const,
		},
	],
	counts: {
		duplicateClusters: 1,
		duplicateItems: 2,
		idleAccepted: 1,
		naming: 0,
		expiredAttempts: 1,
	},
	truncated: {
		scan: false,
		idleAccepted: false,
		expiredAttempts: false,
	},
};

/**
 * Owner brief. The charter is human-owned; the drift block is the
 * deterministic verdict measured against it.
 */
export const OWNER_BRIEF = {
	generatedAt: T5,
	purposeCharter: {
		id: fid("78", 1),
		orgId: ORG_ID,
		version: 3,
		status: "active" as const,
		purpose:
			"Give this organization digital workers it truly owns: durable, governed operators that execute, learn from outcomes, and stay steerable without constant supervision.",
		principles: [
			"Evidence over assertion — every decision cites what it was based on.",
			"Reversible first: prefer the change that can be undone cheaply.",
		],
		strategicTheses: [
			"Owned memory compounds; rented context does not.",
			"Governance is a product surface, not a compliance afterthought.",
		],
		nonGoals: [
			"No unsupervised spend outside an approved budget.",
			"No customer data leaves the tenant boundary.",
		],
		evidenceRefs: [],
		reviewCadenceDays: 30,
		revisionReason: "Sharpened the red lines after the Q3 budget review",
		createdByUserId: null,
		createdAt: T1,
		activatedAt: T1,
		supersededAt: null,
	},
	needsJudgment: [
		{
			id: workItemId(2),
			title: "Draft goodwill-credit policy for delayed orders",
			kind: "decision" as const,
			reason: "Blocked on an owner policy call: credit ceiling per order.",
			priority: "medium" as const,
			objectiveId: null,
			projectId: fid("76", 1),
			updatedAt: T4,
			blocking: true,
		},
	],
	exceptions: [
		{
			id: workItemId(6),
			title: "Backfill wholesale order attribution",
			kind: "exception" as const,
			reason: "Critical work with no linked objective for 6 days.",
			priority: "critical" as const,
			objectiveId: null,
			projectId: fid("76", 1),
			updatedAt: T2,
			blocking: false,
		},
	],
	outcomes: [
		{
			id: workItemId(4),
			title: "Publish week-32 revenue summary",
			kind: "outcome" as const,
			reason: "Completed against the revenue-visibility objective.",
			priority: "medium" as const,
			objectiveId: null,
			projectId: fid("76", 1),
			updatedAt: T4,
			blocking: false,
		},
	],
	drift: {
		severity: "watch" as const,
		activeObjectiveCount: 4,
		unlinkedObjectiveCount: 1,
		openWorkCount: 7,
		unlinkedOpenWorkCount: 2,
		activeOperationalExceptionCount: 1,
		expiredOperationalExceptionCount: 0,
		legacyUnclassifiedOpenWorkCount: 0,
		charterReviewOverdue: false,
		summary:
			"Two open work items carry no objective, and one active objective sits outside the charter.",
	},
};
