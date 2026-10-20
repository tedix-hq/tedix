import {
	listSkillRunSnapshotsForSkill,
	listSkillRunsForSkill,
	listSkillRunsForTedi,
} from "@tedix/db/queries/skill-runs";
import { listSkillSchedulesPage } from "@tedix/db/queries/skill-schedules";
import {
	aggregateSkillWorkflowReliability,
	parseSkillWorkflowRecordsByRun,
} from "../../../services/skill-workflow-inspection";
import { AUTHZ, createError, ErrorCodes } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authedSkills } from "../cognitive-shared";
import {
	loadSkillWorkflowRuntimeProvenance,
	loadSkillWorkflowRuntimeVariants,
	parseSkillWorkflowRuntimeProvenance,
	resolveArtifactText,
	skillWorkflowRevision,
	type SkillWorkflowRuntimeProvenance,
} from "../cognitive-skill-run-provenance";
import {
	resolveWorkflowSkillId,
	requireOwnedTedi,
	getSkillRunForEnvironment,
	requireWorkflowRunTedi,
} from "./shared";

export const skillsListWorkflowRevisions = authedSkills.listWorkflowRevisions
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const skillId = await resolveWorkflowSkillId(context, orgId, input);
		if (input.tediId) await requireOwnedTedi(context, input.tediId, orgId);
		const runs = await listSkillRunSnapshotsForSkill(
			context.db,
			orgId,
			skillId,
			context.env.ENVIRONMENT,
			{
				tediId: input.tediId,
				limit: input.limit,
			},
		);
		const { listRunArtifactsForRunsByPath } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const manifests = await listRunArtifactsForRunsByPath(
			context.db,
			runs.map((run) => run.id),
			"manifest.json",
		);
		const runtimes = new Map<string, SkillWorkflowRuntimeProvenance>();
		await Promise.all(
			manifests.map(async (manifest) => {
				runtimes.set(
					manifest.runId,
					parseSkillWorkflowRuntimeProvenance(
						await resolveArtifactText(context, manifest),
					),
				);
			}),
		);
		const runtimeVariants = await loadSkillWorkflowRuntimeVariants(
			context,
			runs.map((run) => run.id),
		);
		const observed = await Promise.all(
			runs.map((run) =>
				skillWorkflowRevision(
					run,
					runtimes.get(run.id),
					runtimeVariants.get(run.id),
				),
			),
		);
		const unique = new Map<string, (typeof observed)[number]>();
		for (const revision of observed) {
			const key = [
				revision.revision ?? "null",
				revision.workflowSourceSha256 ?? "missing",
				revision.skillDocSha256 ?? "missing",
				revision.workerVersionId ?? "legacy-worker",
				revision.executionCompatibilityHash ?? "legacy-execution-compatibility",
				revision.dispatchShimVersion ?? "legacy-shim",
				revision.compatibilityDate ?? "legacy-compatibility-date",
				revision.dynamicWorkflowsVersion ?? "legacy-dynamic-workflows",
				revision.loaderConfigHash ?? "legacy-loader-config",
				revision.tenantCpuMs ?? "legacy-cpu-limit",
				revision.tenantSubRequests ?? "legacy-subrequest-limit",
			].join(":");
			const current = unique.get(key);
			if (!current) {
				unique.set(key, revision);
				continue;
			}
			current.observedRunCount += 1;
			current.completedCount += revision.completedCount;
			current.failedCount += revision.failedCount;
			current.canceledCount += revision.canceledCount;
			if (
				revision.firstObservedAt &&
				(!current.firstObservedAt ||
					revision.firstObservedAt < current.firstObservedAt)
			) {
				current.firstObservedAt = revision.firstObservedAt;
			}
			if (
				revision.lastObservedAt &&
				(!current.lastObservedAt ||
					revision.lastObservedAt > current.lastObservedAt)
			) {
				current.lastObservedAt = revision.lastObservedAt;
			}
			current.workerVersionId ??= revision.workerVersionId;
			current.workerVersionTag ??= revision.workerVersionTag;
			current.workerVersionTimestamp ??= revision.workerVersionTimestamp;
			current.executionCompatibilityHash ??=
				revision.executionCompatibilityHash;
			current.dispatchShimVersion ??= revision.dispatchShimVersion;
			current.compatibilityDate ??= revision.compatibilityDate;
			current.dynamicWorkflowsVersion ??= revision.dynamicWorkflowsVersion;
			current.loaderConfigHash ??= revision.loaderConfigHash;
			current.tenantCpuMs ??= revision.tenantCpuMs;
			current.tenantSubRequests ??= revision.tenantSubRequests;
			const existingVariantPaths = new Set(
				current.runtimeVariants.map(
					(variant) => `${variant.runId}:${variant.manifestPath}`,
				),
			);
			for (const variant of revision.runtimeVariants) {
				const path = `${variant.runId}:${variant.manifestPath}`;
				if (!existingVariantPaths.has(path)) {
					current.runtimeVariants.push(variant);
					existingVariantPaths.add(path);
				}
			}
			current.runtimeDriftObserved =
				new Set(
					current.runtimeVariants.map((variant) =>
						JSON.stringify([
							variant.workerVersionId,
							variant.executionCompatibilityHash,
							variant.dispatchShimVersion,
							variant.compatibilityDate,
							variant.dynamicWorkflowsVersion,
							variant.loaderConfigHash,
							variant.tenantCpuMs,
							variant.tenantSubRequests,
						]),
					),
				).size > 1;
			current.runtimeDriftBlocked ||= revision.runtimeDriftBlocked;
		}
		return {
			provenance: "observed_executed_runs" as const,
			sampledRunCount: runs.length,
			mayBeTruncated: runs.length >= input.limit,
			revisions: [...unique.values()],
		};
	});

export const skillsGetWorkflowRevision = authedSkills.getWorkflowRevision
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const [runtime, variants] = await Promise.all([
			loadSkillWorkflowRuntimeProvenance(context, run.id),
			loadSkillWorkflowRuntimeVariants(context, [run.id]),
		]);
		return {
			provenance: "observed_executed_run" as const,
			revision: await skillWorkflowRevision(run, runtime, variants.get(run.id)),
			workflowSource: input.includeSource ? run.workflowSource : undefined,
			skillDoc: input.includeSource ? run.skillDoc : undefined,
		};
	});

export const skillsCompareWorkflowRevisions =
	authedSkills.compareWorkflowRevisions
		.use(AUTHZ.tedisRead)
		.handler(async ({ input, context }) => {
			const orgId = requireOrgId(context);
			const [baselineRun, candidateRun] = await Promise.all([
				getSkillRunForEnvironment(context, input.baselineRunId, orgId),
				getSkillRunForEnvironment(context, input.candidateRunId, orgId),
			]);
			if (!baselineRun || !candidateRun) {
				throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
			}
			requireWorkflowRunTedi(baselineRun, input.tediId);
			requireWorkflowRunTedi(candidateRun, input.tediId);
			if (baselineRun.skillId !== candidateRun.skillId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Workflow revision comparison requires runs from the same skill",
				);
			}
			const [baselineRuntime, candidateRuntime, variants] = await Promise.all([
				loadSkillWorkflowRuntimeProvenance(context, baselineRun.id),
				loadSkillWorkflowRuntimeProvenance(context, candidateRun.id),
				loadSkillWorkflowRuntimeVariants(context, [
					baselineRun.id,
					candidateRun.id,
				]),
			]);
			const [baseline, candidate] = await Promise.all([
				skillWorkflowRevision(
					baselineRun,
					baselineRuntime,
					variants.get(baselineRun.id),
				),
				skillWorkflowRevision(
					candidateRun,
					candidateRuntime,
					variants.get(candidateRun.id),
				),
			]);
			const lineCount = (value: string | null) =>
				value == null ? null : value.split(/\r?\n/).length;
			const baselineSourceLines = lineCount(baselineRun.workflowSource);
			const candidateSourceLines = lineCount(candidateRun.workflowSource);
			const baselineDocLines = lineCount(baselineRun.skillDoc);
			const candidateDocLines = lineCount(candidateRun.skillDoc);
			return {
				provenance: "observed_executed_runs" as const,
				baseline,
				candidate,
				changes: {
					revisionDelta:
						baseline.revision == null || candidate.revision == null
							? null
							: candidate.revision - baseline.revision,
					workflowSourceChanged:
						baseline.workflowSourceSha256 !== candidate.workflowSourceSha256,
					skillDocChanged: baseline.skillDocSha256 !== candidate.skillDocSha256,
					workerVersionChanged:
						baseline.workerVersionId !== candidate.workerVersionId,
					executionCompatibilityChanged:
						baseline.executionCompatibilityHash !==
						candidate.executionCompatibilityHash,
					compatibilityDateChanged:
						baseline.compatibilityDate !== candidate.compatibilityDate,
					dispatchShimVersionChanged:
						baseline.dispatchShimVersion !== candidate.dispatchShimVersion,
					dynamicWorkflowsVersionChanged:
						baseline.dynamicWorkflowsVersion !==
						candidate.dynamicWorkflowsVersion,
					loaderConfigChanged:
						baseline.loaderConfigHash !== candidate.loaderConfigHash,
					tenantLimitsChanged:
						baseline.tenantCpuMs !== candidate.tenantCpuMs ||
						baseline.tenantSubRequests !== candidate.tenantSubRequests,
					workflowSourceLineDelta:
						baselineSourceLines == null || candidateSourceLines == null
							? null
							: candidateSourceLines - baselineSourceLines,
					skillDocLineDelta:
						baselineDocLines == null || candidateDocLines == null
							? null
							: candidateDocLines - baselineDocLines,
				},
				baselineSource: input.includeSource
					? baselineRun.workflowSource
					: undefined,
				candidateSource: input.includeSource
					? candidateRun.workflowSource
					: undefined,
				baselineSkillDoc: input.includeSource
					? baselineRun.skillDoc
					: undefined,
				candidateSkillDoc: input.includeSource
					? candidateRun.skillDoc
					: undefined,
			};
		});

export const skillsGetWorkflowReliability = authedSkills.getWorkflowReliability
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (!input.skillId && !input.slug && !input.tediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"At least one of skillId, slug, or tediId is required",
			);
		}
		const skillId =
			input.skillId || input.slug
				? await resolveWorkflowSkillId(context, orgId, input)
				: null;
		if (input.tediId) await requireOwnedTedi(context, input.tediId, orgId);
		const runs = input.tediId
			? await listSkillRunsForTedi(
					context.db,
					orgId,
					input.tediId,
					context.env.ENVIRONMENT,
					{
						limit: input.limit,
						skillId: skillId ?? undefined,
					},
				)
			: await listSkillRunsForSkill(
					context.db,
					orgId,
					skillId!,
					context.env.ENVIRONMENT,
					{
						limit: input.limit,
					},
				);
		const { listRunOperationalArtifactsForRuns } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const artifacts = await listRunOperationalArtifactsForRuns(
			context.db,
			runs.map((run) => run.id),
			5_000,
		);
		const runsWithStepEvidence = new Set(
			artifacts
				.filter(
					(artifact) =>
						artifact.path.startsWith("steps/") ||
						/^epochs\/\d+\/steps\//.test(artifact.path),
				)
				.map((artifact) => artifact.runId),
		);
		const runsMissingStepEvidence = runs.filter(
			(run) => !runsWithStepEvidence.has(run.id),
		).length;
		const steps = parseSkillWorkflowRecordsByRun(
			artifacts.map((artifact) => ({ artifact, content: null })),
			{ includeContent: false },
		).steps;
		const warnings: string[] = [];
		if (runsMissingStepEvidence > 0) {
			warnings.push(
				`${runsMissingStepEvidence} of ${runs.length} selected runs have no steps/** evidence; retry, rollback, tool-call, and failed-step counts are lower bounds.`,
			);
		}
		if (artifacts.length >= 5_000) {
			warnings.push(
				"Step evidence hit the 5000-artifact inspection cap; retry and failure counts are lower bounds.",
			);
		}
		return aggregateSkillWorkflowReliability({
			runs,
			steps,
			skillId,
			tediId: input.tediId ?? null,
			warnings,
		});
	});

export const skillsListWorkflowSchedules = authedSkills.listWorkflowSchedules
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (input.tediId) await requireOwnedTedi(context, input.tediId, orgId);
		const skillId = input.slug
			? await resolveWorkflowSkillId(context, orgId, input)
			: input.skillId;
		const page = await listSkillSchedulesPage(context.db, orgId, {
			skillId,
			tediId: input.tediId,
			enabled: input.enabled,
			limit: input.limit,
			offset: input.offset,
			query: input.query,
		});
		const nextOffset = input.offset + page.schedules.length;
		return {
			...page,
			offset: input.offset,
			limit: input.limit,
			nextOffset: nextOffset < page.total ? nextOffset : null,
		};
	});
