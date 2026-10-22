import { ORPCError } from "@orpc/server";
import type { SkillWorkflowStep } from "@tedix/api-contract/contracts/cognitive";
import {
	getSkillEntry,
	getSkillEntryBySlug,
} from "@tedix/db/queries/cognitive/skill-crud";
import {
	getSkillRun,
	type SkillRun,
	type SkillRunStatus,
} from "@tedix/db/queries/skill-runs";
import { getTediOrganizationId } from "@tedix/db/queries/tedis";
import {
	type ResolvedSkillRunArtifact,
	resolveSkillRunArtifactContents,
} from "../../../services/skill-workflow-inspection";
import { type BaseContext, createError, ErrorCodes } from "../../orpc";

// =============================================================================
// SKILL WORKFLOW EXECUTION
// =============================================================================

export interface SkillRuntimeRunResponse {
	runId: string;
	workflowInstanceId: string;
	status?: SkillRunStatus;
	executionEpoch?: number;
	deduplicated?: boolean;
	idempotencyKey?: string | null;
}

export interface SkillRuntimeStatusResponse {
	status: SkillRunStatus;
	result?: unknown;
	error?: string | null;
	completedAt?: string | null;
	pausedAt?: string | null;
	executionEpoch?: number;
	restartId?: string | null;
	engine?: Record<string, unknown> | null;
}

export interface SkillRuntimeLifecycleResponse {
	runId: string;
	status: SkillRunStatus;
	executionEpoch?: number;
	restartId?: string;
	restartAborted?: boolean;
	engine?: Record<string, unknown> | null;
	engineStatus?: string;
	deduplicated?: boolean;
	operationAttempts?: number;
	statusChecks?: number;
}

export function skillRuntimeLifecycleEngine(
	remote: SkillRuntimeLifecycleResponse,
): Record<string, unknown> | null {
	if (remote.engine) return remote.engine;
	if (!remote.engineStatus) return null;
	return {
		status: remote.engineStatus,
		deduplicated: remote.deduplicated ?? false,
		operationAttempts: remote.operationAttempts ?? null,
		statusChecks: remote.statusChecks ?? null,
	};
}

export function isRecoverableSkillRuntimeCancelFailure(
	error: unknown,
): boolean {
	return (
		error instanceof ORPCError &&
		(error.code === ErrorCodes.BAD_GATEWAY ||
			error.code === ErrorCodes.SERVICE_UNAVAILABLE)
	);
}

type PublicSkillRun = Omit<
	SkillRun,
	| "workflowSource"
	| "workflowSourceHash"
	| "skillDoc"
	| "skillRevision"
	| "skillSlug"
	| "restartCommandId"
	| "originTediRunId"
	| "resourceAccessEnvelope"
> & {
	engine?: Record<string, unknown> | null;
};

export function publicSkillRun(
	run: SkillRun,
	engine?: Record<string, unknown> | null,
): PublicSkillRun {
	const retired = Boolean(
		run.workflowRetiredAt ||
		run.error === "REVOKED" ||
		run.error?.startsWith("REVOKED:"),
	);
	return {
		id: run.id,
		organizationId: run.organizationId,
		skillId: run.skillId,
		tediId: run.tediId,
		workflowInstanceId: run.workflowInstanceId,
		// Cloudflare reconciliation evidence, already projected on the run
		// summary; operators inspecting one run need the same discriminator and
		// reconciler stamp without paging the whole history.
		runtimeEnvironment: run.runtimeEnvironment,
		lastReconciledAt: run.lastReconciledAt ?? null,
		executionEpoch: run.executionEpoch ?? 0,
		restartRequestedAt: run.restartRequestedAt ?? null,
		workflowRetiredAt: run.workflowRetiredAt ?? null,
		status: run.status,
		params: run.params,
		result: retired ? null : run.result,
		error: run.error,
		capabilityManifest: run.capabilityManifest,
		startedAt: run.startedAt,
		completedAt: run.completedAt,
		pausedAt: run.pausedAt,
		certification: run.certification ?? false,
		createdBy: run.createdBy,
		workItemId: run.workItemId ?? null,
		costSummary: retired ? null : (run.costSummary ?? null),
		engine: retired ? null : (engine ?? null),
	};
}

export async function requireOwnedTedi(
	context: BaseContext,
	tediId: string,
	organizationId: string,
): Promise<void> {
	const tediOrganizationId = await getTediOrganizationId(context.db, tediId);
	if (tediOrganizationId !== organizationId) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}
}

export function requireWorkflowRunTedi(
	run: Pick<SkillRun, "tediId">,
	requestedTediId: string | undefined,
): void {
	if (requestedTediId && run.tediId !== requestedTediId) {
		throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
	}
}

export function getSkillRunForEnvironment(
	context: BaseContext,
	runId: string,
	organizationId: string,
): Promise<SkillRun | undefined> {
	return getSkillRun(
		context.db,
		runId,
		organizationId,
		context.env.ENVIRONMENT,
	);
}

export async function resolveSkillRunArtifacts(
	context: BaseContext,
	runId: string,
	includeArbitraryContent: boolean,
	operationalOnly = false,
	limit = 2_000,
	kind: "all" | "steps" | "calls" = "all",
	query?: {
		exhaustive?: boolean;
		offset?: number;
		stepName?: string;
		stepKind?: SkillWorkflowStep["kind"];
		attempt?: number;
	},
): Promise<{
	resolved: ResolvedSkillRunArtifact[];
	warnings: string[];
	truncated: boolean;
}> {
	const {
		listRunArtifactsPage,
		listRunOperationalArtifacts,
		listRunWorkflowCallArtifacts,
		listRunWorkflowStepArtifacts,
	} = await import("@tedix/db/queries/skill-run-artifacts");
	const requested = Math.min(Math.max(limit, 1), 2_000);
	const readPage = async (offset: number, pageLimit: number) =>
		kind === "steps"
			? listRunWorkflowStepArtifacts(context.db, runId, {
					limit: pageLimit,
					offset,
					stepName: query?.stepName,
					kind: query?.stepKind,
				})
			: kind === "calls"
				? listRunWorkflowCallArtifacts(context.db, runId, {
						limit: pageLimit,
						offset,
						stepName: query?.stepName,
						attempt: query?.attempt,
					})
				: operationalOnly
					? listRunOperationalArtifacts(context.db, runId, pageLimit)
					: listRunArtifactsPage(context.db, runId, {
							limit: pageLimit,
							offset,
						});
	let fetched: Awaited<ReturnType<typeof listRunArtifactsPage>> = [];
	if (query?.exhaustive && (kind === "steps" || kind === "calls")) {
		const scanPageSize = 500;
		for (let offset = 0; ; offset += scanPageSize) {
			const page = await readPage(offset, scanPageSize);
			fetched.push(...page);
			if (page.length < scanPageSize) break;
		}
	} else {
		fetched = await readPage(query?.offset ?? 0, requested + 1);
	}
	const truncated = !query?.exhaustive && fetched.length > requested;
	const artifacts = query?.exhaustive ? fetched : fetched.slice(0, requested);
	const warnings: string[] = [];
	if (truncated) {
		warnings.push(
			`Artifact inspection was truncated at ${requested} records; narrow the query or use paginated raw artifact inventory.`,
		);
	}

	const env = context.env as { SKILL_ARTIFACTS?: R2Bucket };
	const contentResolution = await resolveSkillRunArtifactContents({
		artifacts,
		includeArbitraryContent,
		loadR2: env.SKILL_ARTIFACTS
			? async (key) => env.SKILL_ARTIFACTS!.get(key)
			: undefined,
	});
	warnings.push(...contentResolution.warnings);
	const resolved = contentResolution.resolved;
	return { resolved, warnings, truncated };
}

export async function resolveWorkflowSkillId(
	context: BaseContext,
	organizationId: string,
	input: { skillId?: string; slug?: string },
): Promise<string> {
	if (!input.skillId && !input.slug) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Either skillId or slug is required",
		);
	}
	const skill = input.skillId
		? await getSkillEntry(context.db, input.skillId, organizationId)
		: await getSkillEntryBySlug(context.db, organizationId, input.slug!);
	if (!skill) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
	return skill.id;
}

export function assertExpectedSkillRevision(
	expected: number | undefined,
	actual: number,
) {
	if (expected !== undefined && expected !== actual) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Skill changed after trigger admission; review the current revision before running",
		);
	}
}
