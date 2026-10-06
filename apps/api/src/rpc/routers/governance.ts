/**
 * Governance Overview Router
 *
 * REST Endpoints:
 * GET /governance/overview - Weill & Ross governance-on-one-page (read-only)
 *
 * Two halves:
 *
 * 1. Decision-rights matrix — the five Weill & Ross decision domains
 *    translated to AI labor. Every cell is DERIVED from a real enforcement
 *    point (the enforcing function is cited in `enforcedBy`); cells with no
 *    mechanical enforcement are marked `ungoverned` or `declared_unenforced`
 *    honestly. Where the enforcement code exports its constants, the matrix
 *    imports them so the rendered cells cannot silently drift from the gate
 *    (AGENT_UNREACHABLE_CAPABILITY_FIELDS, DEFAULT_PACE_LAYER_POLICY,
 *    BULK_FACT_ADMISSION_THRESHOLD, DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG).
 *    Gap redaction: the ungoverned/declared_unenforced cell DETAILS are
 *    operator-only (redactDecisionRightsForAgents) — agent-class callers see
 *    the rows and statuses but each gap cell reads "restricted".
 *
 * 2. Live governance state — per-tedi autonomy gates (objective gateConfig),
 *    pace-layer portfolio (reusing getSkillPortfolioBalance), pending
 *    approvals, review-flagged skills, 24h cron-ledger summary, and the last
 *    10 queryable governance events (audit_events + graduations derived from
 *    gateConfig.lastGraduatedAt — with an explicit coverage statement for the
 *    governance moments that leave no queryable row today).
 *
 * Actor vocabulary used in decide/propose cells:
 *   human            — signed-in user JWT (authType "user" with sub)
 *   apikey           — operator-issued API key (sk_...)
 *   tedi:non_author  — an identified tedi that is NOT the proposal's author
 *   tedi:mcp-admin   — a tedi whose capability profile grants platform:admin
 *   tedi:any         — any org tedi holding the tool's MCP scope
 *   tedi:self        — the tedi itself (within its own runtime)
 */

import { implement } from "@orpc/server";
import type {
	DecisionRightsRow,
	GovernanceEvent,
	ObjectiveGateSummary,
	TediGovernanceState,
} from "@tedix/api-contract/contracts/governance";
import { governanceContract } from "@tedix/api-contract/contracts/governance";
import {
	DEFAULT_GATE_MIN_COMPLEXITY,
	DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG,
	parseGateConfig,
} from "@tedix/api-contract/contracts/tedi-objectives";
import {
	countPendingApprovalsByTedi,
	countReviewFlaggedSkillsByTedi,
	GOVERNANCE_AUDIT_ACTIONS,
	listGovernanceAuditEvents,
	summarizeCronExecutionsByTedi,
} from "@tedix/db/queries/governance-overview";
import { BULK_FACT_ADMISSION_THRESHOLD } from "@tedix/db/queries/memory-graph/facts";
import {
	getSkillPortfolioBalance,
	getSkillPortfolioBalanceByTedi,
} from "@tedix/db/queries/skill-portfolio";
import { listObjectives } from "@tedix/db/queries/tedi-objectives";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import { DEFAULT_PACE_LAYER_POLICY } from "@tedix/db/schema/control-plane";
import type { TediObjective } from "@tedix/db/schema/tedi-objectives";
import { requireOrgIdOrInput } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	skipOutputValidation,
	withAuth,
} from "../orpc";
import { isLifecycleOverrideAuthority } from "./cognitive-shared";
import { AGENT_UNREACHABLE_CAPABILITY_FIELDS } from "./tedis/crud";

const governanceOs = implement(governanceContract).$context<BaseContext>();
const authOs = governanceOs.use(withAuth);

// =============================================================================
// Decision-rights matrix — derived from enforcement code, never aspirational
// =============================================================================

const ALLOWLIST_DOCTRINE =
	"Allowlist doctrine (agent-capability-mutation-gate ADR): durable/broad authority changes must positively prove a human or operator API key; every other caller identity fails closed. Proposing is open to agents; deciding is gated per cell below.";

/**
 * Pure builder, exported for tests. Every control either cites its enforcing
 * function in `enforcedBy` or carries an `ungoverned`/`declared_unenforced`
 * status — the test suite asserts this invariant over the whole matrix.
 */
export function buildDecisionRightsMatrix(): DecisionRightsRow[] {
	return [
		{
			domain: "ai_principles",
			title: "AI principles — policy packs & SOUL directives",
			question:
				"Who decides the operating principles that bind this org's AI labor?",
			controls: [
				{
					surface:
						"Policy pack content (governancePolicy/gatingPolicy/cronPolicy/modelPolicy via update_policy_pack, create/delete peers)",
					decide: ["human", "apikey", "tedi:mcp-admin"],
					propose: ["tedi:any (report-only findings)"],
					enforcedBy:
						"toolToCapabilityScope() fail-closed missing-mapping error — packages/api-contract/src/schemas/mcp-capability-scopes.ts (MCP edge; apps/api is NOT an agent-facing control)",
					status: "enforced",
					notes:
						"platform_admin tedis mirror the operator by explicit operator decision (agent capability mutation gate, sibling-surface audit).",
				},
				{
					surface: "SOUL directives (tedis.update `personality`)",
					decide: ["human", "apikey", "tedi:mcp-admin", "tedi:self"],
					propose: ["tedi:any"],
					enforcedBy: null,
					status: "ungoverned",
					notes:
						"Deliberately agent-writable so self-improvement keeps working (operator decision, sibling-surface audit). A tedi can rewrite its own operating instructions — a real self-modification surface; the only backstop is org membership (requireTediAccess).",
				},
				{
					surface:
						"Autonomous delegation dispatch (needs_approval verdicts on Home/kernel delegations and write proposals)",
					decide: ["human (org member with approvalAuthority)"],
					propose: ["tedi:any", "kernel (auto-routed findings)"],
					enforcedBy:
						"decideDelegationDispatch() — apps/api/src/rpc/routers/kernel/delegation-dispatch.ts",
					status: "enforced",
					notes:
						"Needs_approval verdicts are never promoted to auto without a decision.",
				},
			],
		},
		{
			domain: "architecture",
			title: "Architecture — harness & authority tiers",
			question:
				"Who decides how a tedi's harness, runtime, and authority tier are shaped?",
			controls: [
				{
					surface: `Durable capability/policy tier (tedis.update ${AGENT_UNREACHABLE_CAPABILITY_FIELDS.slice(0, 2).join("/")})`,
					decide: ["human", "apikey"],
					propose: ["tedi:any (report-only finding → human approval)"],
					enforcedBy:
						"agentUnreachableCapabilityFieldsTouched() — apps/api/src/rpc/routers/tedis/crud.ts (allowlist: checked before any privilege/scope lookup; every non-human/non-apikey authType fails closed)",
					status: "enforced",
					notes:
						"The original capability-mutation-gate fields. A tedi's own elevated scopes cannot bypass this.",
				},
				{
					surface:
						"Runtime/policy-pack/template assignment (tedis.runtime_profile_id, policy_pack_id, workspace_template_set_id)",
					decide: ["nobody post-provisioning (set once at creation)"],
					propose: [],
					enforcedBy:
						"UpdateTediInputSchema field absence — apps/api/src/rpc/routers/tedis/crud.ts (no agent-reachable reassignment path exists; ADR sibling-surface audit)",
					status: "enforced",
					notes: "Written once from SYSTEM_DEFAULT_* constants at creation.",
				},
				{
					surface:
						"Runtime profile content (modelPolicy etc. via update_runtime_profile)",
					decide: ["human", "apikey", "tedi:mcp-admin"],
					propose: ["tedi:any (report-only findings)"],
					enforcedBy:
						"toolToCapabilityScope() fail-closed missing-mapping error — packages/api-contract/src/schemas/mcp-capability-scopes.ts (MCP edge)",
					status: "enforced",
					notes: null,
				},
			],
		},
		{
			domain: "infrastructure",
			title: "Infrastructure — workstations, schedules, substrate",
			question:
				"Who decides what substrate capability (workstations, self-scheduling) a tedi holds?",
			controls: [
				{
					surface: `Workstation/repo capability + durable schedule field (tedis.update ${AGENT_UNREACHABLE_CAPABILITY_FIELDS.slice(2).join("/")})`,
					decide: ["human", "apikey"],
					propose: ["tedi:any (report-only finding → human approval)"],
					enforcedBy:
						"agentUnreachableCapabilityFieldsTouched() — apps/api/src/rpc/routers/tedis/crud.ts",
					status: "enforced",
					notes:
						"repoConfig alone marks a tedi `embodied` and changes dispatch policy; cronJobs is gated as defense-in-depth (the column is inert today).",
				},
				{
					surface: "Live self-scheduling (runtime-native per-tedi `cron` tool)",
					decide: ["tedi:self (within ceilings)", "human", "apikey"],
					propose: ["tedi:self"],
					enforcedBy:
						"cronScheduleCeilingError() + resolveCronExpiry() — apps/tedi-runtime/src/cron.ts; cronProtectionError() — apps/tedi-runtime/src/do.ts (60s recurring floor, 25-job cap, 30d default/365d max TTL, policy-pack protectedCronNames removal protection, fail-closed on D1 read error)",
					status: "bounded",
					notes:
						"Deliberately a ceiling, not a human gate: self-scheduling is a core runtime capability; the runaway vector (1s-forever schedules, unbounded job count) is what is closed.",
				},
			],
		},
		{
			domain: "application_needs",
			title: "Application needs — skills, capabilities, memory admission",
			question:
				"Who decides what skills, capabilities, and knowledge enter the org's repertoire?",
			controls: [
				{
					surface:
						"Skill/proposal creation (record_skills, propose_skill — innovation layer)",
					decide: ["tedi:any (with mcp:skills)", "human", "apikey"],
					propose: ["tedi:any"],
					enforcedBy: `toolToCapabilityScope() EXACT_TOOL_RULES → mcp:skills — packages/api-contract/src/schemas/mcp-capability-scopes.ts; resolvePaceLayerPolicy().innovation — packages/db/src/schema/control-plane.ts (approvalRequired: ${DEFAULT_PACE_LAYER_POLICY.innovation.approvalRequired}, draft TTL ${DEFAULT_PACE_LAYER_POLICY.innovation.draftTtlDays}d)`,
					status: "bounded",
					notes:
						"Innovation layer is automated-with-monitoring by design (GAIE tier 1): creation is open, promotion is gated, zero-use drafts expire.",
				},
				{
					surface: "Skill promotion via proposals (apply_skill_proposal)",
					decide: ["human", "apikey", "tedi:non_author (with mcp:skills)"],
					propose: ["tedi:any (authoring identity recorded)"],
					enforcedBy:
						"skillProposalApplyAuthority() — apps/api/src/rpc/routers/cognitive.ts; db backstop assertForcedSkillPromotionAuthority() — packages/db/src/queries/skill-lifecycle.ts (Disposer separation: the proposer never approves; anonymous machine credentials and authorless entries fail closed)",
					status: "enforced",
					notes:
						"A tedi apply authority is additionally clamped to the `active` force ceiling (clampLifecycleToTediForceCeiling): proven/crystallized targets require an operator, ledger evidence, or muscle crystallization — a clamped apply is annotated, never silent.",
				},
				{
					surface:
						"Forced lifecycle override + tedi-scoped promote/activate (skills.promote, activateWorkflowImprovement, force transitions)",
					decide: ["human", "apikey"],
					propose: ["tedi:any (execute-to-promote usage evidence)"],
					enforcedBy:
						"isLifecycleOverrideAuthority() + requireHumanSkillActivation() — apps/api/src/rpc/routers/cognitive.ts",
					status: "enforced",
					notes:
						"Non-forced promotion is mechanical: the skill_usage_events ledger (execute-to-promote) decides, not any caller.",
				},
				{
					surface:
						"Record-layer skill content mutation (improve_skills on crystallized skills)",
					decide: ["human", "apikey"],
					propose: ["tedi:any (Workshop proposal)"],
					enforcedBy: `isSkillContentMutation() + recordLayerApprovalRequired() — apps/api/src/rpc/routers/cognitive.ts, resolving resolvePaceLayerPolicy().record — packages/db/src/schema/control-plane.ts (approvalRequired default: ${DEFAULT_PACE_LAYER_POLICY.record.approvalRequired})`,
					status: "enforced",
					notes: null,
				},
				{
					surface:
						"Muscle crystallization (muscle.crystallize / crystallize_muscle_memory → lifecycleState=crystallized)",
					decide: [
						"human",
						"apikey",
						"tedi:non_author (with proven ledger evidence)",
					],
					propose: ["tedi:any (by executing the skill to the proven bar)"],
					enforcedBy:
						"crystallizeMuscleFromSkill() — packages/db/src/queries/cognitive/skill-crystallization.ts (org-scoped source skill + proven muscle bar from skill_usage_events, no caller exempt) with assertForcedSkillPromotionAuthority() — packages/db/src/queries/skill-lifecycle.ts (disposer separation, tedi force ceiling carved out only for this evidence-verified path); handler premortem via assertSkillPromotionPremortem() — apps/api/src/services/decision-hygiene.ts",
					status: "enforced",
					notes:
						"Closes the former ungated cross-org record-layer write: crystallize now 404s foreign-org skills, demands the proven ledger bar, a Klein-2007 premortem, and a non-author disposer at both handler and db layers.",
				},
				{
					surface:
						"Per-layer eval gates + per-layer draft TTL (paceLayerPolicy.evalRequired / draftTtlDays)",
					decide: [],
					propose: [],
					enforcedBy: null,
					status: "declared_unenforced",
					notes:
						"Config plumbing only: evalRequired and per-layer TTL are declared in resolvePaceLayerPolicy() but nothing enforces them yet (the global draft-TTL sweep applies).",
				},
				{
					surface: `Bulk memory admission (createFacts > ${BULK_FACT_ADMISSION_THRESHOLD} facts/call)`,
					decide: ["human", "apikey"],
					propose: ["tedi:any (single-fact learning loop, ungated by design)"],
					enforcedBy:
						"assertBulkFactAdmission() — packages/db/src/queries/memory-graph/facts.ts (fail-closed when handler authority is omitted; gate placed before any bulk path exists)",
					status: "enforced",
					notes: null,
				},
				{
					surface:
						"Capability map writes (create/update/link/archive capability)",
					decide: ["tedi:any (with mcp:memory)", "human", "apikey"],
					propose: ["tedi:any"],
					enforcedBy:
						"toolToCapabilityScope() EXACT_TOOL_RULES → mcp:memory — packages/api-contract/src/schemas/mcp-capability-scopes.ts",
					status: "bounded",
					notes:
						"Org knowledge structure, same trust tier as objective_*/memory_* writes; depth/cycle invariants enforced at the query layer.",
				},
			],
		},
		{
			domain: "investment",
			title: "Investment — budgets & spend",
			question: "Who decides what this org's AI labor may spend?",
			controls: [
				{
					surface:
						"Tedi budget values (tedis.update `budgets`: dailyTokenLimit, dailyMessageLimit, operatorTokenReserve, operatorMessageReserve, governedLearningTokenReserve, governedLearningMessageReserve, maxCronJobs, browserBudgetDaily)",
					decide: ["human", "apikey", "tedi:mcp-admin", "tedi:self"],
					propose: ["tedi:any"],
					enforcedBy: null,
					status: "ungoverned",
					notes:
						"Named plainly in the ADR: budgets remain agent-writable — an agent can raise its own spend ceilings. Configured ceilings ARE enforced at runtime (e.g. the browser daily budget store in apps/tedi-runtime), but the VALUES carry no human gate.",
				},
				{
					surface:
						"Objective budget caps (tedi_objectives.budgetConfig: maxTokens/maxTimeMs/maxCostCents/maxActions)",
					decide: [],
					propose: [],
					enforcedBy: null,
					status: "declared_unenforced",
					notes:
						"Written by objective create/update and mission-os templates; no code path enforces these caps mechanically today.",
				},
				{
					surface: "Paid MCP tool spend (x402 payment gating on tools/call)",
					decide: ["payer (settlement required before dispatch)"],
					propose: ["tedi:any (invoking a priced tool)"],
					enforcedBy:
						"checkToolPayment() — apps/mcp/src/mcp/payments.ts (synchronous settlement to mcp_payment_events before tool dispatch; apps/api mcp-payments router is read/policy-only by design)",
					status: "enforced",
					notes: null,
				},
				{
					surface:
						"Autonomy over gated objectives (gate graduation to autonomous)",
					decide: [
						"mechanical: the execution ledger (streaks of complexity-weighted, grounded successes)",
					],
					propose: ["tedi:any (by doing governed work)"],
					enforcedBy: `computeGateGraduation() + computeEpisodeComplexity() — apps/api/src/services/mission-os.ts (default gate: ${DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG.gateType} n=${DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG.graduationCriteria.consecutiveSuccesses}, minComplexity ${DEFAULT_GATE_MIN_COMPLEXITY}; failures/unverified reset the streak)`,
					status: "enforced",
					notes:
						"Kahneman–Klein certification: autonomy is earned from rapid unequivocal feedback, never granted by a caller.",
				},
			],
		},
	];
}

/** Placeholder for gap details hidden from agent-class callers. */
const RESTRICTED_CELL_DETAIL = "restricted";

/**
 * Gap redaction for agent-class callers: the `ungoverned` /
 * `declared_unenforced` cells enumerate exactly which control surfaces have
 * no mechanical gate — an attack map when read by the governed workers
 * themselves. Operators (signed-in human / operator API key, the
 * isLifecycleOverrideAuthority allowlist) see everything; every other caller
 * gets the domain rows with those cells' detail replaced by "restricted".
 * Enforced/bounded cells stay fully visible — worker legibility of the gates
 * that bind them is the point of this surface.
 */
export function redactDecisionRightsForAgents(
	rows: DecisionRightsRow[],
): DecisionRightsRow[] {
	return rows.map((row) => ({
		...row,
		controls: row.controls.map((control) =>
			control.status === "ungoverned" ||
			control.status === "declared_unenforced"
				? {
						surface: RESTRICTED_CELL_DETAIL,
						decide: [],
						propose: [],
						enforcedBy: null,
						status: control.status,
						notes: RESTRICTED_CELL_DETAIL,
					}
				: control,
		),
	}));
}

// =============================================================================
// Live-state assembly helpers
// =============================================================================

/** Hard caps keeping the overview a one-pager and the queries cheap. */
const MAX_TEDIS = 25;
const MAX_ACTIVE_OBJECTIVES = 200;
const MAX_GATES_PER_TEDI = 20;
const RECENT_EVENT_LIMIT = 10;
const CRON_WINDOW_MS = 24 * 60 * 60 * 1000;

function toGateSummary(objective: TediObjective): ObjectiveGateSummary {
	const gate = parseGateConfig(objective.gateConfig);
	return {
		objectiveId: objective.id,
		title: objective.title,
		type: objective.type,
		gateType: gate.gateType,
		autonomyLevel: gate.autonomyLevel,
		currentStreak: gate.currentStreak,
		consecutiveSuccessesRequired: gate.graduationCriteria.consecutiveSuccesses,
		minComplexity:
			gate.graduationCriteria.minComplexity ?? DEFAULT_GATE_MIN_COMPLEXITY,
		lastGraduatedAt: gate.lastGraduatedAt,
	};
}

function countBy(values: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) {
		counts[value] = (counts[value] ?? 0) + 1;
	}
	return counts;
}

const EVENT_COVERAGE = {
	auditedActions: [...GOVERNANCE_AUDIT_ACTIONS],
	derived: [
		"gate_graduation — derived from gateConfig.lastGraduatedAt on active objectives (graduations write no audit_events row; completed/archived objectives fall out of this view)",
	],
	notRecorded: [
		"mutation_gate_rejection — agentUnreachableCapabilityFieldsTouched() throws FORBIDDEN before any audit write; rejections are not persisted",
		"forced_skill_promotion — assertForcedSkillPromotionAuthority() is a db-layer assert; force promotions write no audit_events row",
	],
};

// =============================================================================
// Procedure
// =============================================================================

const overviewProcedure = authOs.overview
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgIdOrInput(context, input?.organizationId);
		const now = new Date();
		const sinceIso = new Date(now.getTime() - CRON_WINDOW_MS).toISOString();

		const allTedis = await getTedisByOrganization(context.db, orgId);
		const tedis = allTedis.slice(0, MAX_TEDIS);

		const [
			orgPortfolio,
			tediPortfolios,
			pendingApprovals,
			reviewFlagged,
			cronSummaries,
			activeObjectives,
			auditRows,
		] = await Promise.all([
			getSkillPortfolioBalance(context.db, orgId),
			getSkillPortfolioBalanceByTedi(context.db, orgId),
			countPendingApprovalsByTedi(context.db, orgId),
			countReviewFlaggedSkillsByTedi(context.db, orgId),
			summarizeCronExecutionsByTedi(context.db, orgId, sinceIso),
			listObjectives(context.db, {
				orgId,
				status: "active",
				limit: MAX_ACTIVE_OBJECTIVES,
			}),
			listGovernanceAuditEvents(context.db, orgId, RECENT_EVENT_LIMIT),
		]);

		const approvalsByTedi = new Map(
			pendingApprovals.map((row) => [row.tediId, row.count]),
		);
		const flaggedByTedi = new Map(
			reviewFlagged.map((row) => [row.tediId, row.count]),
		);
		const cronByTedi = new Map(cronSummaries.map((row) => [row.tediId, row]));
		const objectivesByTedi = new Map<string, TediObjective[]>();
		for (const objective of activeObjectives.data) {
			const list = objectivesByTedi.get(objective.tediId) ?? [];
			list.push(objective);
			objectivesByTedi.set(objective.tediId, list);
		}

		const tediStates: TediGovernanceState[] = tedis.map((tedi) => {
			const gates = (objectivesByTedi.get(tedi.id) ?? []).map(toGateSummary);
			const portfolio = tediPortfolios.get(tedi.id);
			const cron = cronByTedi.get(tedi.id);
			return {
				tediId: tedi.id,
				slug: tedi.slug ?? null,
				name: tedi.displayName ?? tedi.name,
				objectives: {
					activeTotal: gates.length,
					byGateType: countBy(gates.map((gate) => gate.gateType)),
					byAutonomyLevel: countBy(gates.map((gate) => gate.autonomyLevel)),
					gates: gates.slice(0, MAX_GATES_PER_TEDI),
					gatesTruncated: gates.length > MAX_GATES_PER_TEDI,
				},
				skillPortfolio: {
					totalSkills: portfolio?.totalSkills ?? 0,
					innovation: portfolio?.layers.innovation.count ?? 0,
					differentiation: portfolio?.layers.differentiation.count ?? 0,
					record: portfolio?.layers.record.count ?? 0,
				},
				pendingApprovals: approvalsByTedi.get(tedi.id) ?? 0,
				reviewFlaggedSkills: flaggedByTedi.get(tedi.id) ?? 0,
				cronExecutions24h: {
					fires: cron?.fires ?? 0,
					failures: cron?.failures ?? 0,
					lastFireAt: cron?.lastFireAt ?? null,
				},
			};
		});

		// Merge audit-backed events with graduations derived from gateConfig
		// into one chronological feed, capped at RECENT_EVENT_LIMIT.
		const auditEvents: GovernanceEvent[] = auditRows.map((row) => ({
			at: row.timestamp.toISOString(),
			kind: row.action,
			actorType: row.actorType,
			actorId: row.actorId,
			resourceType: row.resourceType,
			resourceId: row.resourceId,
			summary: `${row.action} by ${row.actorType}:${row.actorId} on ${row.resourceType}${row.resourceId ? ` ${row.resourceId}` : ""}`,
		}));
		const graduationEvents: GovernanceEvent[] = activeObjectives.data.flatMap(
			(objective) => {
				const gate = parseGateConfig(objective.gateConfig);
				if (!gate.lastGraduatedAt) return [];
				return [
					{
						at: gate.lastGraduatedAt,
						kind: "gate_graduation",
						actorType: "tedi",
						actorId: objective.tediId,
						resourceType: "objective",
						resourceId: objective.id,
						summary: `Objective "${objective.title}" graduated to ${gate.autonomyLevel}`,
					},
				];
			},
		);
		const recentEvents = [...auditEvents, ...graduationEvents]
			.sort((left, right) => right.at.localeCompare(left.at))
			.slice(0, RECENT_EVENT_LIMIT);

		const matrix = buildDecisionRightsMatrix();
		return {
			organizationId: orgId,
			generatedAt: now.toISOString(),
			doctrine: ALLOWLIST_DOCTRINE,
			decisionRights: isLifecycleOverrideAuthority(context)
				? matrix
				: redactDecisionRightsForAgents(matrix),
			tedis: tediStates,
			tediTotal: allTedis.length,
			tedisTruncated: allTedis.length > tedis.length,
			orgSkillPortfolio: {
				totalSkills: orgPortfolio.totalSkills,
				layers: orgPortfolio.layers,
				healthyEnvelope: orgPortfolio.healthyEnvelope,
				stagnation: orgPortfolio.stagnation,
				stagnationKind: orgPortfolio.stagnationKind,
			},
			orgScopedReviewFlaggedSkills: flaggedByTedi.get(null) ?? 0,
			pendingApprovalsTotal: pendingApprovals.reduce(
				(sum, row) => sum + row.count,
				0,
			),
			recentEvents,
			eventCoverage: EVENT_COVERAGE,
		};
	});

export const governanceContractRouter = governanceOs.router({
	overview: skipOutputValidation(overviewProcedure),
});
