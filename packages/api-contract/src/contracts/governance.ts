import "@orpc/openapi/extensions/route";
/**
 * Governance Overview Contract
 *
 * The Weill & Ross "governance on one page" for an organization's AI labor
 * (flywheel remodel P5 #3): a decision-rights matrix over the five classic
 * decision domains translated to AI labor, where every cell is derived from a
 * real enforcement point in code (cited in `enforcedBy`) or honestly marked
 * ungoverned — plus the live governance state per tedi (autonomy gates,
 * pace-layer portfolio, pending approvals, review flags) and the last
 * governance events that are actually queryable.
 *
 * Hammer's BPR failure record (50–70% failure, root cause: neglected
 * people/change) makes operator legibility the change-management surface for
 * autonomous workers; MIT CISR found only 1 in 3 executives could describe
 * how their IT was governed. This read exists so that number is 1 in 1 here.
 *
 * Read-only. Projected MCP tool id: `get_governance_overview`
 * (GOVERNANCE_TOOL_ID_OVERRIDES in apps/api/src/services/tool-schema-sync.ts).
 * Used by: Tedix OS Activity governance, tedis via the aggregate MCP
 * surface, operators via Code Mode.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";

// =============================================================================
// SCHEMAS — decision-rights matrix
// =============================================================================

/** The five Weill & Ross decision domains, translated to AI labor. */
export const GovernanceDomainSchema = z.enum([
	"ai_principles",
	"architecture",
	"infrastructure",
	"application_needs",
	"investment",
]);
export type GovernanceDomain = z.infer<typeof GovernanceDomainSchema>;

/**
 * Honest enforcement status of a decision-rights cell:
 * - `enforced` — a hard mechanical gate exists (allowlist/predicate/scope).
 * - `bounded` — ceilings/limits exist but no human gate (e.g. cron ceilings).
 * - `declared_unenforced` — config knob exists, nothing reads it yet.
 * - `ungoverned` — no mechanical enforcement; named plainly, never dressed up.
 */
export const GovernanceControlStatusSchema = z.enum([
	"enforced",
	"bounded",
	"declared_unenforced",
	"ungoverned",
]);
export type GovernanceControlStatus = z.infer<
	typeof GovernanceControlStatusSchema
>;

export const GovernanceControlSchema = z.object({
	/** The concrete surface this cell governs (endpoint/field/tool). */
	surface: z.string(),
	/** Who may DECIDE — commit the durable change. Derived from code. */
	decide: z.array(z.string()),
	/** Who may PROPOSE — surface findings/drafts without deciding. */
	propose: z.array(z.string()),
	/**
	 * The enforcing function (name + file) this cell is derived from.
	 * Null ONLY when status is `ungoverned` or `declared_unenforced`.
	 */
	enforcedBy: z.string().nullable(),
	status: GovernanceControlStatusSchema,
	notes: z.string().nullable(),
});
export type GovernanceControl = z.infer<typeof GovernanceControlSchema>;

export const DecisionRightsRowSchema = z.object({
	domain: GovernanceDomainSchema,
	title: z.string(),
	/** The Weill & Ross decision question, translated to AI labor. */
	question: z.string(),
	controls: z.array(GovernanceControlSchema),
});
export type DecisionRightsRow = z.infer<typeof DecisionRightsRowSchema>;

// =============================================================================
// SCHEMAS — live governance state
// =============================================================================

const ObjectiveGateSummarySchema = z.object({
	objectiveId: z.string(),
	title: z.string(),
	type: z.string(),
	gateType: z.string(),
	autonomyLevel: z.string(),
	currentStreak: z.number(),
	consecutiveSuccessesRequired: z.number(),
	minComplexity: z.number(),
	lastGraduatedAt: z.string().nullable(),
});
export type ObjectiveGateSummary = z.infer<typeof ObjectiveGateSummarySchema>;

const PaceLayerCountsSchema = z.object({
	totalSkills: z.number(),
	innovation: z.number(),
	differentiation: z.number(),
	record: z.number(),
});

const TediGovernanceStateSchema = z.object({
	tediId: z.string(),
	slug: z.string().nullable(),
	name: z.string(),
	objectives: z.object({
		activeTotal: z.number(),
		byGateType: z.record(z.string(), z.number()),
		byAutonomyLevel: z.record(z.string(), z.number()),
		/** Per-gate detail, capped — see gatesTruncated. */
		gates: z.array(ObjectiveGateSummarySchema),
		gatesTruncated: z.boolean(),
	}),
	/** Per-tedi pace-layer counts (org-scoped tediId-NULL skills excluded). */
	skillPortfolio: PaceLayerCountsSchema,
	pendingApprovals: z.number(),
	reviewFlaggedSkills: z.number(),
	/** 24h window over the tedi_cron_executions ledger. */
	cronExecutions24h: z.object({
		fires: z.number(),
		failures: z.number(),
		lastFireAt: z.string().nullable(),
	}),
});
export type TediGovernanceState = z.infer<typeof TediGovernanceStateSchema>;

const GovernanceEventSchema = z.object({
	at: z.string(),
	/** Audit action (e.g. "tedi.config_change") or derived kind ("gate_graduation"). */
	kind: z.string(),
	actorType: z.string().nullable(),
	actorId: z.string().nullable(),
	resourceType: z.string().nullable(),
	resourceId: z.string().nullable(),
	summary: z.string(),
});
export type GovernanceEvent = z.infer<typeof GovernanceEventSchema>;

/** What the event feed can and cannot see — stated, not implied. */
const GovernanceEventCoverageSchema = z.object({
	/** audit_events actions the feed queries (they are actually written). */
	auditedActions: z.array(z.string()),
	/** Event kinds derived from other ledgers (with their derivation). */
	derived: z.array(z.string()),
	/** Governance moments that leave NO queryable row today. */
	notRecorded: z.array(z.string()),
});

const OrgPortfolioLayerStatSchema = z.object({
	count: z.number(),
	share: z.number(),
	healthyShare: z.number(),
	deviation: z.number(),
});

const OrgSkillPortfolioSchema = z.object({
	totalSkills: z.number(),
	layers: z.record(z.string(), OrgPortfolioLayerStatSchema),
	healthyEnvelope: z.record(z.string(), z.number()),
	stagnation: z.boolean(),
	stagnationKind: z.string().nullable(),
});

export const GovernanceOverviewSchema = z.object({
	organizationId: z.string(),
	generatedAt: z.string(),
	/** The one-sentence doctrine every enforced cell follows. */
	doctrine: z.string(),
	decisionRights: z.array(DecisionRightsRowSchema),
	tedis: z.array(TediGovernanceStateSchema),
	tediTotal: z.number(),
	tedisTruncated: z.boolean(),
	/** Org-wide pace-layer balance (includes org-scoped tediId-NULL skills). */
	orgSkillPortfolio: OrgSkillPortfolioSchema,
	/** Review-flagged skills with no owning tedi (org-scoped rows). */
	orgScopedReviewFlaggedSkills: z.number(),
	pendingApprovalsTotal: z.number(),
	/** Last 10 governance events across audit + derived sources. */
	recentEvents: z.array(GovernanceEventSchema),
	eventCoverage: GovernanceEventCoverageSchema,
});
export type GovernanceOverview = z.infer<typeof GovernanceOverviewSchema>;

/**
 * Optional explicit org target. Ignored whenever the caller's auth context
 * already carries an organization scope (user JWT, API key, forwarded MCP
 * context) — only service-binding callers without org context need it.
 */
const OrganizationIdInputSchema = z.uuid().optional();

// =============================================================================
// CONTRACT
// =============================================================================

export const governanceContract = oc
	.route({ tags: ["governance"], prefix: "/governance" })
	.errors(baseErrors)
	.router({
		overview: oc
			.route({
				method: "GET",
				path: "/overview",
				summary: "Get governance overview",
				description:
					"Weill & Ross governance-on-one-page for this organization's AI labor: the decision-rights matrix (five domains; every cell cites its enforcing function or is marked ungoverned) plus live per-tedi governance state — autonomy gates, pace-layer portfolio, pending approvals, review-flagged skills — and the last 10 queryable governance events. Read-only, org-scoped, windowed.",
			})
			.input(z.object({ organizationId: OrganizationIdInputSchema }).optional())
			.output(GovernanceOverviewSchema),
	});

export type GovernanceContract = typeof governanceContract;
