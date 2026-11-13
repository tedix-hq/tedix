/**
 * Sample memory: growth snapshots, the knowledge graph, memory health
 * findings and audit events.
 */

import {
	APP_STOREFRONT,
	BLUEPRINT_PUBLISHED,
	CONVERSATION_HOME,
	fid,
	ORG_ID,
	OUTPUT_DOCUMENT,
	OUTPUT_SHEET,
	RUN_CHURN_FAILED,
	RUN_REVENUE_OK,
	T0,
	T1,
	T2,
	T3,
	T4,
	T5,
	TEDI_JUNO,
	TEDI_MILES,
	TEDI_NOVA,
	WORKSPACE_REVENUE,
} from "./core";

export const growthSnapshot = (tediId: string) => ({
	id: fid("7b", 1),
	tediId,
	orgId: ORG_ID,
	snapshotDate: "2026-08-10",
	metrics: {
		facts: 128,
		avgConfidence: 0.82,
		skills: 14,
		avgRevision: 2.1,
		muscles: 5,
		avgUsage: 11.4,
		// Deliberately one MORE than the live expertise read returns for Miles,
		// so the snapshot-drift caption is exercised rather than dead code.
		domains: 4,
		autonomyRate: 0.64,
		expertiseLevels: { "revenue-reporting": "expert" },
	},
	createdAt: T0,
});

/**
 * Knowledge-map projection. `meta` rides along with the nodes, so the caveat
 * the OS renders describes the exact snapshot drawn rather than a second,
 * later health read.
 */
export const KNOWLEDGE_GRAPH = {
	nodes: [
		{
			id: fid("7a", 1),
			label: "revenue-reporting",
			type: "domain" as const,
			properties: { factCount: 84 },
		},
		{
			id: fid("7a", 2),
			label: "churn-analysis",
			type: "domain" as const,
			properties: { factCount: 41 },
		},
		{
			id: fid("7c", 1),
			label: "Monday follow-ups double wholesale renewals",
			type: "knowledge_entry" as const,
			properties: { confidence: 0.86 },
		},
		{
			id: fid("7c", 2),
			label: "Weekly revenue summary",
			type: "skill" as const,
			properties: { revision: 3 },
		},
		{
			id: fid("7d", 1),
			label: "Wholesale renewals convert 2x on Monday",
			type: "fact" as const,
			properties: { confidence: 0.77 },
		},
		{
			id: fid("7d", 2),
			label: "CRM listing times out past 500 accounts",
			type: "fact" as const,
			properties: { confidence: 0.91 },
		},
		{
			id: fid("7d", 3),
			label: "Churn cohort is unstable this week",
			type: "fact" as const,
			properties: { confidence: 0.64 },
		},
		{
			id: fid("7e", 1),
			label: "Publish week-32 revenue summary",
			type: "decision" as const,
			properties: { outcomeStatus: "success" },
		},
	],
	edges: [
		{
			source: fid("7a", 1),
			target: fid("7d", 1),
			type: "HAS_FACT",
			properties: {},
		},
		{
			source: fid("7a", 2),
			target: fid("7d", 3),
			type: "HAS_FACT",
			properties: {},
		},
		{
			source: fid("7a", 2),
			target: fid("7d", 2),
			type: "HAS_FACT",
			properties: {},
		},
		{
			source: fid("7c", 1),
			target: fid("7d", 1),
			type: "DERIVED_FROM",
			properties: {},
		},
		{
			source: fid("7c", 2),
			target: fid("7a", 1),
			type: "OPERATES_ON",
			properties: {},
		},
		{
			source: fid("7e", 1),
			target: fid("7d", 1),
			type: "GROUNDED_IN",
			properties: {},
		},
		// An edge whose target is outside the returned node set: the OS must
		// report it as unresolved rather than draw a box with no meaning.
		{
			source: fid("7e", 1),
			target: fid("7d", 9),
			type: "GROUNDED_IN",
			properties: {},
		},
	],
	meta: {
		graphConfigured: true,
		graphHealthy: true,
		projectionState: "ready" as const,
		projectionReady: true,
		projectionReason: null,
		persistedWatermark: 1840,
		gdsWatermark: 1840,
		degraded: false,
		source: "neo4j" as const,
	},
};

export const MEMORY_HEALTH = {
	totalFacts: 412,
	activeFacts: 371,
	archivedFacts: 41,
	totalGaps: 9,
	totalOpinions: 23,
	totalEdges: 640,
	totalDomains: 6,
	avgConfidence: 0.81,
	orphanRatio: 0.06,
	staleFacts: 14,
	contradictions: 2,
	curiosityQueue: { queued: 4, exploring: 1, completedTotal: 37 },
};

const findingSample = (
	n: number,
	text: string,
	detail: string,
	extra: {
		tediId?: string | null;
		source?: string | null;
		lastVerifiedAt?: string | null;
		lastAccessedAt?: string | null;
	} = {},
) => ({
	factId: fid("73", n),
	tediId: extra.tediId === undefined ? TEDI_NOVA : extra.tediId,
	text,
	detail,
	confidence: 0.8,
	source: extra.source ?? null,
	sourceUrl: null,
	sourceSessionId: null,
	reviewStatus: "pending",
	createdAt: "2026-05-02T09:00:00.000Z",
	lastVerifiedAt: extra.lastVerifiedAt ?? null,
	lastAccessedAt: extra.lastAccessedAt ?? null,
});

export const MEMORY_HEALTH_FINDINGS = {
	checkedAt: "2026-10-20T08:00:00.000Z",
	unusedDays: 60,
	staleDays: 90,
	orphanWindow: 2000,
	graphLayer: { configured: false },
	findings: [
		{
			kind: "unused" as const,
			count: 38,
			capped: false,
			samples: [
				findingSample(
					1,
					"Acme prefers invoices sent on the first business day.",
					"Never retrieved since it was recorded.",
					{ source: "conversation://acme-kickoff" },
				),
				findingSample(
					2,
					"The staging gateway rejects requests without a trace header.",
					"Last retrieved 2026-06-11T10:00:00.000Z.",
					{ lastAccessedAt: "2026-06-11T10:00:00.000Z" },
				),
			],
		},
		{
			kind: "stale_in_use" as const,
			count: 6,
			capped: false,
			samples: [
				findingSample(
					3,
					"Refunds above 500 EUR need a second approver.",
					"Still retrieved lately but not re-checked in a long time.",
					{
						source: "doc://policies/refunds.md",
						lastAccessedAt: "2026-10-18T10:00:00.000Z",
					},
				),
			],
		},
		{
			kind: "duplicate" as const,
			count: 2,
			capped: false,
			samples: [
				findingSample(
					4,
					"Support hours are 9 to 17 CET on weekdays.",
					"2 current facts share one topic key.",
					{ source: "doc://handbook/support.md" },
				),
			],
		},
		{
			kind: "contradiction" as const,
			count: 2,
			capped: false,
			samples: [
				findingSample(
					5,
					"The trial lasts 14 days.",
					'Contradicts: "The trial lasts 30 days."',
					{ tediId: null },
				),
			],
		},
		{
			kind: "orphan" as const,
			count: 12,
			capped: false,
			samples: [
				findingSample(
					6,
					"Weekly report goes out on Thursdays.",
					"Not linked to any other fact.",
					{ source: "conversation://ops-sync" },
				),
			],
		},
	],
};

const auditEvent = (
	n: number,
	actorId: string,
	actorType:
		| "user"
		| "service"
		| "tedi"
		| "m2m"
		| "api_key"
		| "anonymous"
		| "external_agent"
		| "kernel",
	action: string,
	resourceType: string,
	resourceId: string | null,
	timestamp: string,
) => ({
	id: fid("74", n),
	organizationId: ORG_ID,
	actorId,
	actorType,
	action,
	resourceType,
	resourceId,
	metadata: null,
	ipAddress: null,
	userAgent: null,
	timestamp,
});

export const AUDIT_EVENTS = [
	auditEvent(
		1,
		"dev-operator",
		"user",
		"workspace.created",
		"workspace",
		WORKSPACE_REVENUE,
		T0,
	),
	auditEvent(
		2,
		TEDI_MILES,
		"tedi",
		"output.created",
		"output",
		OUTPUT_SHEET,
		T1,
	),
	auditEvent(
		3,
		TEDI_MILES,
		"tedi",
		"output.revised",
		"output",
		OUTPUT_DOCUMENT,
		T1,
	),
	auditEvent(
		4,
		"dev-operator",
		"user",
		"blueprint.published",
		"blueprint",
		BLUEPRINT_PUBLISHED,
		T1,
	),
	auditEvent(
		5,
		TEDI_MILES,
		"tedi",
		"skill_run.completed",
		"skill_run",
		RUN_REVENUE_OK,
		T2,
	),
	auditEvent(
		6,
		TEDI_MILES,
		"tedi",
		"skill_run.failed",
		"skill_run",
		RUN_CHURN_FAILED,
		T3,
	),
	auditEvent(
		7,
		"kernel",
		"kernel",
		"tool.called",
		"tool_call",
		"list_orders",
		T4,
	),
	auditEvent(
		8,
		TEDI_JUNO,
		"tedi",
		"approval.requested",
		"approval",
		fid("71", 2),
		T5,
	),
	auditEvent(
		9,
		"dev-operator",
		"user",
		"conversation.created",
		"conversation",
		CONVERSATION_HOME,
		T0,
	),
	auditEvent(
		10,
		"ci-deployer",
		"service",
		"app.updated",
		"app",
		APP_STOREFRONT,
		T2,
	),
	auditEvent(
		11,
		TEDI_NOVA,
		"tedi",
		"work_item.completed",
		"work_item",
		fid("70", 4),
		T4,
	),
	auditEvent(
		12,
		"dev-operator",
		"api_key",
		"connection.connected",
		"connection",
		"gmail",
		T4,
	),
];
