/** Workshop, workflow-improvement, trajectory, and coverage handlers. */

import { isToolExcludedFromSkillCoverage } from "@tedix/api-contract/schemas/tools";
import { getAppById } from "@tedix/db/queries/app-records";
import {
	listSkillsByApp,
	listSkillsByTedi,
} from "@tedix/db/queries/cognitive/skill-catalog";
import {
	getSkillEntry,
	getSkillEntryBySlug,
	updateSkillEntry,
} from "@tedix/db/queries/cognitive/skill-crud";
import { listAllSkillsForOrg } from "@tedix/db/queries/cognitive/skill-inventory";
import {
	computeSkillPromotion,
	computeSkillPromotionBlockers,
	defaultPromotedLifecycleState,
} from "@tedix/db/queries/cognitive/skill-promotion";
import {
	listSkillCoverageToolsForApp,
	resolveToolSlugsForApp,
} from "@tedix/db/queries/cognitive/skill-tool-metadata";
import {
	type SkillValidationResult,
	validateSkillInput,
} from "@tedix/db/queries/cognitive/skill-validation";
import { getPolicyPackById } from "@tedix/db/queries/control-plane/definitions";
import { getOrCreateDomain } from "@tedix/db/queries/memory-graph/domains";
import {
	clampLifecycleToTediForceCeiling,
	SkillLifecycleTransitionError,
	SkillPaceLayerOverrideError,
} from "@tedix/db/queries/skill-lifecycle";
import { getSkillPortfolioBalance } from "@tedix/db/queries/skill-portfolio";
import { listRunArtifacts } from "@tedix/db/queries/skill-run-artifacts";
import { getTediById } from "@tedix/db/queries/tedis";
import {
	bindNativeTelemetryIdentities,
	composeTrajectorySkillProposal,
	extractRunToolSequences,
	filterNovelPatterns,
	filterPatternsWithCanonicalToolIds,
	listLinkedSuccessfulEpisodes,
	listSkillsForTrajectoryDedupe,
	mineToolSequencePatterns,
	resolveToolNamesToAppToolIds,
	DEFAULT_MIN_SUPPORT as TRAJECTORY_DEFAULT_MIN_SUPPORT,
} from "@tedix/db/queries/trajectory-mining";
import type {
	SkillEntry,
	SkillPaceLayer,
	SkillRun,
} from "@tedix/db/schema/cognitive";
import { resolvePaceLayerPolicy } from "@tedix/db/schema/control-plane";
import { toJsonRecord } from "@tedix/db/utils/json";
import { measureMiningPhase } from "../../lib/mining-phase-timing";
import { assertSkillPromotionPremortem } from "../../services/decision-hygiene";
import { AUTHZ, type BaseContext, createError, ErrorCodes } from "../orpc";
import { requireOrgId } from "../org-scope";
import {
	getSkillRunForEnvironment,
	requireOwnedTedi,
} from "./cognitive-skill-runs";
import {
	applyValidationGate,
	coerceArrayOptional,
	createSkillFromInput,
	extractMcpToolMetadata,
	mergeToolSlugsFromInputAndMetadata,
	resolveAppId,
	syncSkillScheduleProjection,
	validatedSkillSchedule,
} from "./cognitive-skill-shared";
import {
	appendRevisionReasoning,
	authedSkills,
	isLifecycleOverrideAuthority,
	sha256Digest,
	skillProposalApplyAuthority,
} from "./cognitive-shared";

async function getSkillWorkshopProposal(
	context: BaseContext,
	orgId: string,
	input: { id?: string; slug?: string },
): Promise<SkillEntry> {
	if (!input.id && !input.slug) {
		throw createError(ErrorCodes.BAD_REQUEST, "Either id or slug is required");
	}
	const existing = input.id
		? await getSkillEntry(context.db, input.id, orgId)
		: await getSkillEntryBySlug(context.db, orgId, input.slug!);
	if (!existing) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
	if (!existing.tediId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Skill Workshop actions require a tedi-scoped proposal",
		);
	}
	return existing;
}

export const WORKFLOW_IMPROVEMENT_TAG = "workflow-improvement";
const BASELINE_RUN_TAG_PREFIX = "baseline-run:";
const BASELINE_WORKFLOW_TAG_PREFIX = "baseline-workflow:";
const CANDIDATE_WORKFLOW_TAG_PREFIX = "candidate-workflow:";

function taggedValue(
	tags: string[] | null | undefined,
	prefix: string,
): string | null {
	return (
		tags?.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) ?? null
	);
}

function assertWorkflowImprovementProposal(entry: SkillEntry): void {
	if (!entry.tags?.includes(WORKFLOW_IMPROVEMENT_TAG) || !entry.sourceSkillId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Skill is not a workflow improvement proposal",
		);
	}
}

export function isHumanSkillActivator(
	context: Pick<BaseContext, "authType" | "user">,
): boolean {
	return context.authType === "user" && Boolean(context.user?.sub);
}

export function isWorkflowImprovementBaselineTerminal(
	status: SkillRun["status"],
): boolean {
	return status === "completed" || status === "failed" || status === "canceled";
}

export function requireHumanSkillActivation(context: BaseContext): void {
	if (!isHumanSkillActivator(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A signed-in human operator must activate skill proposals; tedis and machine credentials may propose and test, but cannot activate",
		);
	}
}

export function requireLifecycleOverrideAuthority(context: BaseContext): void {
	if (!isLifecycleOverrideAuthority(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"force lifecycle override requires a signed-in human or an operator API key; agent-authenticated callers cannot bypass execute-to-promote gating",
		);
	}
}

/** Effective pace layer: the required stored classification. */
export function effectiveSkillPaceLayer(
	entry: Pick<SkillEntry, "paceLayer">,
): SkillPaceLayer {
	return entry.paceLayer;
}

/**
 * True when an improve payload mutates the skill's substance — its content,
 * supporting files (incl. `scripts/workflow.ts`), input schema, or export
 * format — as opposed to metadata-only edits (tags, summary, visibility…).
 * This is the mutation class the record-layer approval gate covers.
 */
export function isSkillContentMutation(input: {
	content?: unknown;
	files?: unknown;
	inputSchema?: unknown;
	agentSkillsFormat?: unknown;
}): boolean {
	return (
		input.content !== undefined ||
		input.files !== undefined ||
		input.inputSchema !== undefined ||
		input.agentSkillsFormat !== undefined
	);
}

/**
 * Resolve the record layer's approvalRequired knob from the owning tedi's
 * policy pack (`paceLayerPolicy`), falling back to the platform default
 * (true). Org-level skills have no tedi and use the default directly.
 */
export async function recordLayerApprovalRequired(
	context: BaseContext,
	entry: Pick<SkillEntry, "tediId">,
): Promise<boolean> {
	let definition: Parameters<typeof resolvePaceLayerPolicy>[0];
	if (entry.tediId) {
		const tedi = await getTediById(context.db, entry.tediId);
		if (tedi?.policyPackId) {
			const pack = await getPolicyPackById(context.db, tedi.policyPackId);
			definition = pack?.definition ?? undefined;
		}
	}
	return resolvePaceLayerPolicy(definition).record.approvalRequired;
}

/**
 * updateSkillEntry with the db-layer execute-to-promote gate surfaced as a
 * typed BAD_REQUEST instead of a 500.
 */
export async function updateSkillEntryGated(
	context: BaseContext,
	id: string,
	patch: Parameters<typeof updateSkillEntry>[2],
	options?: Parameters<typeof updateSkillEntry>[3],
): Promise<void> {
	try {
		await updateSkillEntry(context.db, id, patch, options);
	} catch (error) {
		if (
			error instanceof SkillLifecycleTransitionError ||
			error instanceof SkillPaceLayerOverrideError
		) {
			throw createError(ErrorCodes.BAD_REQUEST, error.message, {
				code: error.code,
				...error.details,
			});
		}
		throw error;
	}
}

type WorkflowCertificationArtifact = {
	path: string;
	outcome: "pending" | "success" | "failure";
};

function isFailedWorkflowToolCall(
	artifact: WorkflowCertificationArtifact,
): boolean {
	return (
		artifact.outcome === "failure" &&
		/(?:^|\/)calls\/(?:run|compensate)\/\d+\.json$/.test(artifact.path)
	);
}

export function workflowCertificationPassed(
	result: unknown,
	artifacts: WorkflowCertificationArtifact[] = [],
): boolean {
	if (!result || typeof result !== "object" || Array.isArray(result))
		return false;
	if (artifacts.some(isFailedWorkflowToolCall)) return false;
	const certification = (result as Record<string, unknown>).certification;
	if (
		!certification ||
		typeof certification !== "object" ||
		Array.isArray(certification)
	) {
		return false;
	}
	const record = certification as Record<string, unknown>;
	return (
		record.status === "passed" ||
		record.passed === true ||
		record.overallStatus === "passed"
	);
}

async function validateWorkflowImprovementEntry(
	context: BaseContext,
	entry: SkillEntry,
): Promise<SkillValidationResult> {
	return validateSkillInput(
		context.db,
		{
			title: entry.title,
			description: entry.description ?? undefined,
			summary: entry.summary ?? undefined,
			content: entry.content,
			files: entry.files ?? null,
			toolSlugs: extractMcpToolMetadata(entry.content),
			metadataToolSlugs: extractMcpToolMetadata(entry.content),
		},
		entry.appId ?? null,
	);
}

async function workflowImprovementGovernance(
	proposal: SkillEntry,
	state: "pending_human_activation" | "activated",
	certificationRunId: string | null = null,
) {
	assertWorkflowImprovementProposal(proposal);
	const candidateSource = proposal.files?.["scripts/workflow.ts"];
	const baselineRunId = taggedValue(proposal.tags, BASELINE_RUN_TAG_PREFIX);
	const baselineHash = taggedValue(proposal.tags, BASELINE_WORKFLOW_TAG_PREFIX);
	if (!candidateSource || !baselineRunId || !baselineHash) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Workflow improvement proposal is missing immutable baseline provenance",
		);
	}
	return {
		state,
		baselineRunId,
		baselineSkillId: proposal.sourceSkillId!,
		baselineRevision: proposal.sourceRevision ?? 0,
		baselineWorkflowSha256: baselineHash,
		candidateWorkflowSha256:
			taggedValue(proposal.tags, CANDIDATE_WORKFLOW_TAG_PREFIX) ??
			(await sha256Digest(candidateSource)),
		humanActivationRequired: true as const,
		certificationRunId,
		certificationPassed: certificationRunId !== null,
	};
}

export const skillsProposeWorkshop = authedSkills.proposeWorkshop
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const tediId = input.tediId ?? context.tediId;
		if (!tediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"tediId is required to create a Skill Workshop proposal",
			);
		}
		const { entry } = await createSkillFromInput(context, orgId, {
			...input,
			tediId,
			visibility: input.visibility ?? "private",
			lifecycleState: "draft",
			revisionReasoning:
				input.revisionReasoning ?? "Created as a Skill Workshop proposal.",
		});
		return { entry };
	});

/**
 * Trajectory mining (trace↔skill coupling): deterministic consolidation
 * operator that mines recurring successful tool-call sequences from
 * evidence-linked rationale episodes and feeds them into the Skill Workshop
 * as tedi-scoped draft proposals. Detection is pure SQL/TS (no LLM); proposals
 * always carry toolIds + run evidence and never auto-apply — noisy
 * auto-generated skills are excluded by the support
 * floor (>=3 distinct proof-carrying runs), the dedupe gate, and the
 * disposer-separated apply_skill_proposal step (human/apikey, or a tedi
 * distinct from the proposal author — never the authoring identity).
 */
export interface MineTrajectoryCandidatesParams {
	orgId: string;
	tediId?: string;
	windowDays?: number;
	minSupport?: number;
	maxProposals?: number;
	dryRun?: boolean;
}

/**
 * Trajectory-mining core: mine recurring successful tool-call routines from
 * run-linked rationale episodes into draft skill proposals. Shared by the
 * `skills.mineCandidates` oRPC handler and the platform skill-scheduler's
 * skill-development re-attach (`apps/api/src/services/skill-scheduler.ts`) —
 * the consolidation operator that used to ride the `skill-development`
 * `onCronFire` DO cron and was orphaned when that loop became a skill-schedule.
 * With `dryRun` (or no `tediId`) it mines without proposing. Callers own
 * authorization: the oRPC handler gates on `tedis:update`; the scheduler runs
 * it as trusted internal work.
 */
export async function mineTrajectoryCandidates(
	context: BaseContext,
	params: MineTrajectoryCandidatesParams,
) {
	const { orgId, tediId } = params;
	const dryRun = params.dryRun === true;
	const windowDays = params.windowDays ?? 14;
	// Hard floor of 3 regardless of input — high-support patterns only.
	const minSupport = Math.max(
		params.minSupport ?? TRAJECTORY_DEFAULT_MIN_SUPPORT,
		TRAJECTORY_DEFAULT_MIN_SUPPORT,
	);
	const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
	const episodes = await measureMiningPhase(context, "mining.episodes", () =>
		listLinkedSuccessfulEpisodes(context.db, { orgId, tediId, since }),
	);
	const runs = extractRunToolSequences(episodes);
	const patterns = mineToolSequencePatterns(runs, { minSupport });
	const toolResolution = bindNativeTelemetryIdentities(
		await measureMiningPhase(context, "mining.tool_resolution", () =>
			resolveToolNamesToAppToolIds(
				context.db,
				patterns.flatMap((pattern) => pattern.tools),
			),
		),
	);
	const identityFiltered = filterPatternsWithCanonicalToolIds(
		patterns,
		toolResolution,
	);
	const existing = await measureMiningPhase(context, "mining.dedupe", () =>
		listSkillsForTrajectoryDedupe(context.db, orgId),
	);
	const { novel, skipped: duplicateSkips } = filterNovelPatterns(
		identityFiltered.resolved,
		existing,
		toolResolution.toolIdByName,
	);
	const proposed: SkillEntry[] = [];
	if (!dryRun && tediId) {
		const maxProposals = Math.min(params.maxProposals ?? 3, 10);
		for (const pattern of novel.slice(0, maxProposals)) {
			const draft = composeTrajectorySkillProposal(pattern, {
				toolIdByName: toolResolution.toolIdByName,
				minSupport,
			});
			const { entry } = await createSkillFromInput(context, orgId, {
				...draft,
				tediId,
				visibility: "private",
				lifecycleState: "draft",
			});
			proposed.push(entry);
		}
	}
	return {
		episodesExamined: episodes.length,
		runsExamined: runs.length,
		patterns: patterns.map((pattern) => ({
			key: pattern.key,
			tools: pattern.tools,
			support: pattern.support,
			supportRunIds: pattern.supportRunIds,
		})),
		proposed,
		skipped: [...identityFiltered.skipped, ...duplicateSkips],
	};
}

export const skillsMineCandidates = authedSkills.mineCandidates
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const tediId = input.tediId ?? context.tediId ?? undefined;
		if (input.dryRun !== true && !tediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"tediId is required to create trajectory proposals (pass dryRun: true to mine without proposing)",
			);
		}
		return measureMiningPhase(context, "mining.total", () =>
			mineTrajectoryCandidates(context, {
				orgId,
				tediId,
				windowDays: input.windowDays,
				minSupport: input.minSupport,
				maxProposals: input.maxProposals,
				dryRun: input.dryRun === true,
			}),
		);
	});

export const skillsPortfolioBalance = authedSkills.portfolioBalance
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		return getSkillPortfolioBalance(context.db, orgId, {
			tediId: input.tediId,
		});
	});

export const skillsProposeWorkflowImprovement =
	authedSkills.proposeWorkflowImprovement
		.use(AUTHZ.tedisWrite)
		.handler(async ({ input, context }) => {
			const orgId = requireOrgId(context);
			const baselineRun = await getSkillRunForEnvironment(
				context,
				input.baselineRunId,
				orgId,
			);
			if (!baselineRun) {
				throw createError(ErrorCodes.NOT_FOUND, "Baseline skill run not found");
			}
			if (!isWorkflowImprovementBaselineTerminal(baselineRun.status)) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Baseline run must be terminal before it can ground an improvement proposal",
				);
			}
			if (!baselineRun.workflowSource) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Baseline run has no pinned workflow source",
				);
			}
			const tediId = input.tediId ?? context.tediId ?? baselineRun.tediId;
			if (tediId !== baselineRun.tediId) {
				throw createError(ErrorCodes.NOT_FOUND, "Baseline skill run not found");
			}
			await requireOwnedTedi(context, tediId, orgId);

			const baseline = await getSkillEntry(
				context.db,
				baselineRun.skillId,
				orgId,
			);
			if (!baseline) {
				throw createError(ErrorCodes.NOT_FOUND, "Baseline skill not found");
			}
			if (
				baseline.tags?.includes(WORKFLOW_IMPROVEMENT_TAG) ||
				baseline.lifecycleState === "draft" ||
				baseline.lifecycleState === "stale" ||
				baseline.lifecycleState === "archived"
			) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Workflow improvements require an active, proven, or crystallized canonical skill",
				);
			}
			if (baselineRun.skillRevision !== baseline.revision) {
				throw createError(
					ErrorCodes.CONFLICT,
					`Baseline advanced from observed revision ${baselineRun.skillRevision} to ${baseline.revision}; execute the current revision before proposing an improvement`,
				);
			}
			const baselineWorkflowSha256 = await sha256Digest(
				baselineRun.workflowSource,
			);
			const candidateWorkflowSha256 = await sha256Digest(
				input.files["scripts/workflow.ts"]!,
			);
			if (baselineWorkflowSha256 === candidateWorkflowSha256) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Candidate workflow source is identical to the observed baseline",
				);
			}

			const proposalTitle = `${(baseline.slug ?? "workflow").slice(0, 38)} improvement ${crypto.randomUUID().slice(0, 8)}`;
			const proposalTags = [
				...(input.tags ?? baseline.tags ?? []).filter(
					(tag) =>
						tag !== WORKFLOW_IMPROVEMENT_TAG &&
						!tag.startsWith(BASELINE_RUN_TAG_PREFIX) &&
						!tag.startsWith(BASELINE_WORKFLOW_TAG_PREFIX) &&
						!tag.startsWith(CANDIDATE_WORKFLOW_TAG_PREFIX),
				),
				WORKFLOW_IMPROVEMENT_TAG,
				`${BASELINE_RUN_TAG_PREFIX}${baselineRun.id}`,
				`${BASELINE_WORKFLOW_TAG_PREFIX}${baselineWorkflowSha256}`,
				`${CANDIDATE_WORKFLOW_TAG_PREFIX}${candidateWorkflowSha256}`,
			];
			const { entry: proposal } = await createSkillFromInput(context, orgId, {
				title: proposalTitle,
				description: input.description ?? baseline.description ?? undefined,
				summary: input.summary ?? baseline.summary ?? undefined,
				content: input.content,
				files: input.files,
				tediId,
				visibility: "private",
				lifecycleState: "draft",
				revisionReasoning: `Workflow improvement proposed from run ${baselineRun.id} at baseline revision ${baseline.revision}. ${input.reason}\nBaseline ${baselineWorkflowSha256}; candidate ${candidateWorkflowSha256}.`,
				inputSchema: baseline.inputSchema ?? undefined,
				agentSkillsFormat: baseline.agentSkillsFormat ?? undefined,
				appId: baseline.appId ?? undefined,
				toolIds: baseline.toolIds ?? undefined,
				tags: proposalTags,
				audience: baseline.audience ?? undefined,
				preconditions: baseline.preconditions ?? undefined,
				sourceSkillId: baseline.id,
				sourceRevision: baseline.revision,
			});
			const validation = await validateWorkflowImprovementEntry(
				context,
				proposal,
			);
			return {
				proposal,
				validation,
				governance: await workflowImprovementGovernance(
					proposal,
					"pending_human_activation",
				),
			};
		});

export const skillsInspectWorkflowImprovement =
	authedSkills.inspectWorkflowImprovement
		.use(AUTHZ.tedisRead)
		.handler(async ({ input, context }) => {
			const orgId = requireOrgId(context);
			const proposal = await getSkillWorkshopProposal(context, orgId, {
				id: input.id,
			});
			assertWorkflowImprovementProposal(proposal);
			if (input.tediId && proposal.tediId !== input.tediId) {
				throw createError(ErrorCodes.NOT_FOUND, "Proposal not found");
			}
			const baseline = await getSkillEntry(
				context.db,
				proposal.sourceSkillId!,
				orgId,
			);
			if (!baseline) {
				throw createError(ErrorCodes.NOT_FOUND, "Baseline skill not found");
			}
			return {
				proposal,
				baseline,
				validation: await validateWorkflowImprovementEntry(context, proposal),
				stale: baseline.revision !== proposal.sourceRevision,
				governance: await workflowImprovementGovernance(
					proposal,
					"pending_human_activation",
				),
			};
		});

export const skillsActivateWorkflowImprovement =
	authedSkills.activateWorkflowImprovement
		.use(AUTHZ.tedisWrite)
		.handler(async ({ input, context }) => {
			requireHumanSkillActivation(context);
			const orgId = requireOrgId(context);
			const proposal = await getSkillWorkshopProposal(context, orgId, {
				id: input.id,
			});
			assertWorkflowImprovementProposal(proposal);
			const baseline = await getSkillEntry(
				context.db,
				proposal.sourceSkillId!,
				orgId,
			);
			if (!baseline) {
				throw createError(ErrorCodes.NOT_FOUND, "Baseline skill not found");
			}
			if (baseline.revision !== proposal.sourceRevision) {
				throw createError(
					ErrorCodes.CONFLICT,
					`Baseline revision changed from ${proposal.sourceRevision} to ${baseline.revision}; rebase and recertify the proposal`,
				);
			}
			const certificationRun = await getSkillRunForEnvironment(
				context,
				input.certificationRunId,
				orgId,
			);
			const certificationArtifacts = certificationRun
				? await listRunArtifacts(context.db, certificationRun.id)
				: [];
			if (
				!certificationRun ||
				certificationRun.skillId !== proposal.id ||
				certificationRun.status !== "completed" ||
				!workflowCertificationPassed(
					certificationRun.result,
					certificationArtifacts,
				)
			) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Activation requires a completed, failure-free run of this proposal whose result contains certification.passed=true or certification.overallStatus='passed'",
				);
			}
			const validation = await validateWorkflowImprovementEntry(
				context,
				proposal,
			);
			if (!validation.valid) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Workflow improvement is no longer valid",
					{ validation },
				);
			}
			const schedule = validatedSkillSchedule(
				proposal.content,
				baseline.tediId,
			);
			await updateSkillEntry(context.db, baseline.id, {
				content: proposal.content,
				files: proposal.files ?? null,
				description: proposal.description ?? baseline.description,
				summary: proposal.summary ?? baseline.summary,
				inputSchema: proposal.inputSchema ?? baseline.inputSchema,
				agentSkillsFormat:
					proposal.agentSkillsFormat ?? baseline.agentSkillsFormat,
				appId: proposal.appId ?? baseline.appId,
				toolIds: proposal.toolIds ?? baseline.toolIds,
				tags: (proposal.tags ?? []).filter(
					(tag) =>
						tag !== WORKFLOW_IMPROVEMENT_TAG &&
						!tag.startsWith(BASELINE_RUN_TAG_PREFIX) &&
						!tag.startsWith(BASELINE_WORKFLOW_TAG_PREFIX) &&
						!tag.startsWith(CANDIDATE_WORKFLOW_TAG_PREFIX),
				),
				audience: proposal.audience ?? baseline.audience,
				preconditions: proposal.preconditions ?? baseline.preconditions,
				revision: baseline.revision + 1,
				revisionReasoning: appendRevisionReasoning(
					baseline,
					`Human-activated workflow improvement ${proposal.id} after certified run ${certificationRun.id}: ${input.reason}`,
				),
			});
			const activatedBaseline = await getSkillEntry(
				context.db,
				baseline.id,
				orgId,
			);
			if (!activatedBaseline) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Activated skill not found",
				);
			}
			await syncSkillScheduleProjection(context, activatedBaseline, schedule);
			await updateSkillEntry(context.db, proposal.id, {
				lifecycleState: "archived",
				revision: proposal.revision + 1,
				revisionReasoning: appendRevisionReasoning(
					proposal,
					`Activated into canonical skill ${baseline.id} revision ${activatedBaseline.revision}.`,
				),
			});
			const archivedProposal = await getSkillEntry(
				context.db,
				proposal.id,
				orgId,
			);
			return {
				baseline: activatedBaseline,
				proposal: archivedProposal ?? proposal,
				governance: await workflowImprovementGovernance(
					proposal,
					"activated",
					certificationRun.id,
				),
			};
		});

export const skillsInspectWorkshop = authedSkills.inspectWorkshop
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const existing = await getSkillWorkshopProposal(context, orgId, input);
		const validation = await validateSkillInput(
			context.db,
			{
				title: existing.title,
				description: existing.description ?? undefined,
				summary: existing.summary ?? undefined,
				content: existing.content,
				files: existing.files ?? null,
				toolSlugs: extractMcpToolMetadata(existing.content),
				metadataToolSlugs: extractMcpToolMetadata(existing.content),
			},
			existing.appId ?? null,
		);
		const blockers = await computeSkillPromotionBlockers(context.db, existing);
		const { changes } = computeSkillPromotion(existing);
		return {
			entry: existing,
			validation,
			promotion: {
				id: existing.id,
				applied: false,
				changes: [...blockers, ...changes],
				entry: null,
			},
		};
	});

export const skillsReviseWorkshop = authedSkills.reviseWorkshop
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await getSkillWorkshopProposal(context, orgId, { id: input.id });
		const existing = await getSkillEntry(context.db, input.id, orgId);
		if (!existing) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");

		let domainId: string | undefined;
		if (input.domain !== undefined) {
			const domain = await getOrCreateDomain(context.db, orgId, input.domain);
			domainId = domain.id;
		}
		const resolvedAppId = await resolveAppId(context, input);
		const scopeAppId = resolvedAppId ?? existing.appId ?? null;
		const effectiveContent = input.content ?? existing.content;
		const { allToolSlugs, metadataToolSlugs } =
			mergeToolSlugsFromInputAndMetadata({
				toolSlugs: input.toolSlugs,
				content: effectiveContent,
			});
		if (input.toolSlugs?.length && !scopeAppId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"toolSlugs requires appId or appSlug for resolution scope",
			);
		}
		const validateMode = input.validate ?? "error";
		if (validateMode !== "skip") {
			const result = await validateSkillInput(
				context.db,
				{
					title: input.title ?? existing.title,
					description: input.description ?? existing.description ?? undefined,
					summary: input.summary ?? existing.summary ?? undefined,
					content: effectiveContent,
					files: input.files ?? existing.files ?? null,
					toolSlugs: allToolSlugs,
					metadataToolSlugs,
				},
				scopeAppId,
			);
			applyValidationGate(result, validateMode);
		}

		let toolIdsUpdate: string[] | undefined;
		if (input.toolIds !== undefined || allToolSlugs.length) {
			const explicit =
				input.toolIds !== undefined
					? (coerceArrayOptional(input.toolIds) ?? [])
					: ((existing.toolIds as string[] | null | undefined) ?? []);
			const slugIds: string[] = [];
			if (allToolSlugs.length && scopeAppId) {
				const { resolvedIds, unresolved } = await resolveToolSlugsForApp(
					context.db,
					scopeAppId,
					allToolSlugs,
				);
				if (unresolved.length > 0 && validateMode === "error") {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						`toolSlugs not found in app_tools for app ${scopeAppId}: ${unresolved.join(", ")}`,
					);
				}
				slugIds.push(...resolvedIds);
			}
			toolIdsUpdate = [...new Set([...explicit, ...slugIds])];
		}

		await updateSkillEntry(context.db, input.id, {
			...(input.title !== undefined ? { title: input.title } : {}),
			...(input.content !== undefined ? { content: input.content } : {}),
			...(input.files !== undefined ? { files: input.files } : {}),
			...(input.description !== undefined
				? { description: input.description }
				: {}),
			...(input.visibility !== undefined
				? { visibility: input.visibility }
				: {}),
			...(domainId !== undefined ? { domainId } : {}),
			revisionReasoning: appendRevisionReasoning(
				existing,
				input.revisionReasoning ?? "Revised Skill Workshop proposal.",
			),
			...(input.inputSchema !== undefined
				? { inputSchema: toJsonRecord(input.inputSchema) }
				: {}),
			...(input.agentSkillsFormat !== undefined
				? { agentSkillsFormat: input.agentSkillsFormat }
				: {}),
			...(resolvedAppId !== null ? { appId: resolvedAppId } : {}),
			...(toolIdsUpdate !== undefined ? { toolIds: toolIdsUpdate } : {}),
			...(input.summary !== undefined ? { summary: input.summary } : {}),
			...(input.tags !== undefined
				? { tags: coerceArrayOptional(input.tags) }
				: {}),
			...(input.audience !== undefined
				? { audience: coerceArrayOptional(input.audience) }
				: {}),
			...(input.preconditions !== undefined
				? { preconditions: input.preconditions }
				: {}),
			lifecycleState: "draft",
			revision: existing.revision + 1,
		});

		const updated = await getSkillEntry(context.db, input.id, orgId);
		if (updated) {
			await syncSkillScheduleProjection(
				context,
				updated,
				validatedSkillSchedule(updated.content, updated.tediId),
			);
		}
		return { entry: updated! };
	});

export const skillsApplyWorkshop = authedSkills.applyWorkshop
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const existing = await getSkillWorkshopProposal(context, orgId, input);
		// Disposer separation: human/apikey pass; a tedi may apply only a
		// DIFFERENT identity's proposal; anonymous machine credentials fail.
		const applyAuthority = skillProposalApplyAuthority(context, existing);
		if (existing.tags?.includes(WORKFLOW_IMPROVEMENT_TAG)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Workflow improvement proposals must use activateWorkflowImprovement so certification and baseline revision checks cannot be bypassed",
			);
		}
		// Force ceiling: a tedi apply authority may force-promote to at
		// most `active`. A request above the ceiling is CLAMPED (never a
		// silent success at a lower state — the clamp is annotated in the
		// changes list and the durable revisionReasoning).
		const requestedLifecycle =
			input.lifecycleState ??
			defaultPromotedLifecycleState(existing.lifecycleState ?? "active");
		const targetLifecycle =
			applyAuthority.kind === "tedi"
				? clampLifecycleToTediForceCeiling(
						existing.lifecycleState,
						requestedLifecycle,
					)
				: requestedLifecycle;
		const clampChange =
			targetLifecycle !== requestedLifecycle
				? {
						code: "TEDI_APPLY_LIFECYCLE_CLAMPED",
						field: "lifecycleState",
						before: requestedLifecycle,
						after: targetLifecycle,
						note: `Requested "${requestedLifecycle}" clamped to "${targetLifecycle}": a tedi apply authority can force-promote to at most "active" (force ceiling); proven requires ledger-verified execution evidence and crystallized requires muscle crystallization or an operator.`,
					}
				: null;
		// P5 decision hygiene: record-layer promotions/mutations require a
		// Klein-2007 premortem; operators may skip with a logged reason. Gated
		// on the EFFECTIVE (post-clamp) target — the transition that happens.
		const premortemGate = assertSkillPromotionPremortem({
			existing,
			targetLifecycleState: targetLifecycle,
			premortem: input.premortem,
			skipReason: input.skipPremortemReason,
			operatorAuthority: applyAuthority.kind === "operator",
		});
		validatedSkillSchedule(existing.content, null);
		const applyReasoning = [
			input.revisionReasoning ?? "Applied Skill Workshop proposal.",
			...(clampChange ? [clampChange.note] : []),
			...(premortemGate.auditLine ? [premortemGate.auditLine] : []),
		].join("\n");
		const { changes, patch } = computeSkillPromotion(existing, {
			visibility: input.visibility,
			lifecycleState: targetLifecycle,
			supersedesId: input.supersedesId,
			revisionReasoning: applyReasoning,
		});
		const blockers = await computeSkillPromotionBlockers(context.db, existing);
		const allChanges = [
			...blockers,
			...(clampChange ? [clampChange] : []),
			...changes,
		];
		if (blockers.length > 0) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Skill Workshop apply blocked: ${blockers.map((change) => change.code).join(", ")}`,
				{ blockers },
			);
		}
		if (Object.keys(patch).length === 0) {
			return {
				id: existing.id,
				applied: false,
				changes: allChanges,
				entry: existing,
			};
		}
		// skillProposalApplyAuthority above proved a non-proposer disposer —
		// apply is the sanctioned override of execute-to-promote gating. The
		// same authority is re-asserted at the db layer (two-layer gate).
		await updateSkillEntryGated(context, existing.id, patch, {
			force: true,
			forceAuthority: applyAuthority,
		});
		const updated = await getSkillEntry(context.db, existing.id, orgId);
		if (updated) {
			await syncSkillScheduleProjection(context, updated, null);
		}
		return {
			id: existing.id,
			applied: true,
			changes: allChanges,
			entry: updated ?? null,
		};
	});

export const skillsRejectWorkshop = authedSkills.rejectWorkshop
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const existing = await getSkillWorkshopProposal(context, orgId, {
			id: input.id,
		});
		await updateSkillEntry(context.db, existing.id, {
			lifecycleState: "archived",
			revision: existing.revision + 1,
			revisionReasoning: appendRevisionReasoning(
				existing,
				`Rejected Skill Workshop proposal: ${input.reason}`,
			),
		});
		const updated = await getSkillEntry(context.db, existing.id, orgId);
		if (updated) {
			await syncSkillScheduleProjection(context, updated, null);
		}
		return { entry: updated! };
	});

export const skillsQuarantineWorkshop = authedSkills.quarantineWorkshop
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const existing = await getSkillWorkshopProposal(context, orgId, {
			id: input.id,
		});
		await updateSkillEntry(context.db, existing.id, {
			lifecycleState: "stale",
			revision: existing.revision + 1,
			revisionReasoning: appendRevisionReasoning(
				existing,
				`Quarantined Skill Workshop proposal: ${input.reason}`,
			),
		});
		const updated = await getSkillEntry(context.db, existing.id, orgId);
		if (updated) {
			await syncSkillScheduleProjection(context, updated, null);
		}
		return { entry: updated! };
	});

export const skillsValidate = authedSkills.validate
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		// Mode A: validate stored skill by id (or its skillId alias) or slug
		const storedId = input.id ?? input.skillId;
		if (storedId || input.slug) {
			const skill = storedId
				? await getSkillEntry(context.db, storedId, orgId)
				: await getSkillEntryBySlug(context.db, orgId, input.slug!);
			if (!skill) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
			return validateSkillInput(
				context.db,
				{
					title: skill.title,
					description: skill.description ?? undefined,
					summary: skill.summary ?? undefined,
					content: skill.content,
					files: skill.files ?? null,
					toolSlugs: extractMcpToolMetadata(skill.content),
					metadataToolSlugs: extractMcpToolMetadata(skill.content),
				},
				skill.appId ?? null,
			);
		}

		// Mode B: validate draft input
		const appId = await resolveAppId(context, input);
		if (input.toolSlugs?.length && !appId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"toolSlugs requires appId or appSlug for resolution scope",
			);
		}
		const { allToolSlugs, metadataToolSlugs } =
			mergeToolSlugsFromInputAndMetadata(input);
		return validateSkillInput(
			context.db,
			{
				title: input.title,
				description: input.description,
				summary: input.summary,
				content: input.content,
				files: input.files ?? null,
				toolSlugs: allToolSlugs,
				metadataToolSlugs,
			},
			appId,
		);
	});

export const skillsAuditToolCoverage = authedSkills.auditToolCoverage
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const limit = Math.min(Math.max(input.limit ?? 250, 1), 500);
		const scopeAppId = await resolveAppId(context, input);
		const app = scopeAppId ? await getAppById(context.db, scopeAppId) : null;
		const appSlug = input.appSlug ?? app?.slug ?? null;

		const skills = scopeAppId
			? await listSkillsByApp(context.db, orgId, scopeAppId, {
					limit,
					tediId: input.tediId,
				})
			: input.tediId
				? await listSkillsByTedi(context.db, orgId, input.tediId, { limit })
				: (
						await listAllSkillsForOrg(context.db, orgId, {
							limit,
						})
					).entries;

		const tools = scopeAppId
			? await listSkillCoverageToolsForApp(context.db, scopeAppId)
			: [];
		const activeTools = tools.filter((tool) => tool.enabled !== false);
		const excludedTools = activeTools.filter((tool) =>
			isToolExcludedFromSkillCoverage(
				tool.meta as Record<string, unknown> | null | undefined,
			),
		);
		const auditableTools = input.includeExcludedTools
			? activeTools
			: activeTools.filter(
					(tool) =>
						!isToolExcludedFromSkillCoverage(
							tool.meta as Record<string, unknown> | null | undefined,
						),
				);
		const toolsByName = new Map(activeTools.map((tool) => [tool.toolId, tool]));
		const coveredToolIds = new Set<string>();
		const skillsWithoutToolCoverage: Array<{
			id: string;
			slug: string | null | undefined;
			title: string;
			hasWorkflow: boolean;
		}> = [];
		const skillsWithUnresolvedToolMetadata: Array<{
			id: string;
			slug: string | null | undefined;
			title: string;
			toolNames: string[];
		}> = [];

		for (const skill of skills) {
			const explicitToolIds =
				(skill.toolIds as string[] | null | undefined) ?? [];
			const metadataToolNames = extractMcpToolMetadata(skill.content);
			const resolvedMetadataToolIds = scopeAppId
				? metadataToolNames
						.map((toolName) => toolsByName.get(toolName)?.id)
						.filter((id): id is string => typeof id === "string")
				: [];
			for (const id of [...explicitToolIds, ...resolvedMetadataToolIds]) {
				coveredToolIds.add(id);
			}
			const unresolvedMetadataToolNames = scopeAppId
				? metadataToolNames.filter((toolName) => !toolsByName.has(toolName))
				: metadataToolNames;
			if (unresolvedMetadataToolNames.length) {
				skillsWithUnresolvedToolMetadata.push({
					id: skill.id,
					slug: skill.slug,
					title: skill.title,
					toolNames: unresolvedMetadataToolNames,
				});
			}
			const files = skill.files as Record<string, unknown> | null | undefined;
			if (
				explicitToolIds.length === 0 &&
				resolvedMetadataToolIds.length === 0
			) {
				skillsWithoutToolCoverage.push({
					id: skill.id,
					slug: skill.slug,
					title: skill.title,
					hasWorkflow: !!files?.["scripts/workflow.ts"],
				});
			}
		}

		const toolsWithoutSkillCoverage = auditableTools
			.filter((tool) => !coveredToolIds.has(tool.id))
			.map((tool) => ({
				id: tool.id,
				toolId: tool.toolId,
				title: tool.title,
				readOnly: tool.annotations?.readOnlyHint === true,
				hasOutputSchema: tool.outputSchema != null,
			}));
		const readOnlyToolsMissingOutputSchema = auditableTools
			.filter(
				(tool) =>
					tool.annotations?.readOnlyHint === true && tool.outputSchema == null,
			)
			.map((tool) => ({
				id: tool.id,
				toolId: tool.toolId,
				title: tool.title,
			}));

		const warnings: string[] = [];
		if (!scopeAppId) {
			warnings.push(
				"Provide appId or appSlug to audit concrete app_tools coverage and outputSchema gaps.",
			);
		}
		if (scopeAppId && activeTools.length === 0) {
			warnings.push(
				`App ${appSlug ?? scopeAppId} has no active app_tools; verify the appSlug/appId before treating this as full coverage.`,
			);
		}
		if (skills.length >= limit) {
			warnings.push(
				`Skill result hit limit=${limit}; increase limit or scope by app/tedi for a complete audit.`,
			);
		}

		return {
			appId: scopeAppId,
			appSlug,
			summaryOnly: input.summary ?? false,
			skillCount: skills.length,
			toolCount: auditableTools.length,
			excludedToolCount: excludedTools.length,
			coveredToolCount: auditableTools.filter((tool) =>
				coveredToolIds.has(tool.id),
			).length,
			uncoveredToolCount: toolsWithoutSkillCoverage.length,
			skillsWithoutToolCoverage: input.summary ? [] : skillsWithoutToolCoverage,
			toolsWithoutSkillCoverage: input.summary ? [] : toolsWithoutSkillCoverage,
			readOnlyToolsMissingOutputSchema: input.summary
				? []
				: readOnlyToolsMissingOutputSchema,
			skillsWithUnresolvedToolMetadata: input.summary
				? []
				: skillsWithUnresolvedToolMetadata,
			warnings: input.summary
				? [
						...warnings,
						"summary=true omitted detailed entity lists; rerun without summary for full findings.",
					]
				: warnings,
		};
	});
