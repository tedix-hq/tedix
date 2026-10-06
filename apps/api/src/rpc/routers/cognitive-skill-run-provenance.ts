import type { SkillWorkflowRuntimeVariant } from "@tedix/api-contract/contracts/cognitive";
import type { SkillRun } from "@tedix/db/queries/skill-runs";
import type { BaseContext } from "../orpc";
import {
	resolveSkillRunArtifactContents,
	type ResolvedSkillRunArtifact,
} from "../../services/skill-workflow-inspection";
import { sha256Digest } from "./cognitive-shared";

export interface SkillWorkflowRuntimeProvenance {
	workerVersionId: string | null;
	workerVersionTag: string | null;
	workerVersionTimestamp: string | null;
	executionCompatibilityHash: string | null;
	dispatchShimVersion: string | null;
	compatibilityDate: string | null;
	dynamicWorkflowsVersion: string | null;
	loaderConfigHash: string | null;
	tenantCpuMs: number | null;
	tenantSubRequests: number | null;
}

export function parseSkillWorkflowRuntimeProvenance(
	content: string | null,
): SkillWorkflowRuntimeProvenance {
	const empty = {
		workerVersionId: null,
		workerVersionTag: null,
		workerVersionTimestamp: null,
		executionCompatibilityHash: null,
		dispatchShimVersion: null,
		compatibilityDate: null,
		dynamicWorkflowsVersion: null,
		loaderConfigHash: null,
		tenantCpuMs: null,
		tenantSubRequests: null,
	};
	if (!content) return empty;
	try {
		const manifest = JSON.parse(content) as {
			provenance?: { runtime?: Record<string, unknown> };
		};
		const runtime = manifest.provenance?.runtime;
		if (!runtime) return empty;
		const text = (key: string) =>
			typeof runtime[key] === "string" ? runtime[key] : null;
		const number = (key: string) =>
			typeof runtime[key] === "number" ? runtime[key] : null;
		return {
			workerVersionId: text("workerVersionId"),
			workerVersionTag: text("workerVersionTag"),
			workerVersionTimestamp: text("workerVersionTimestamp"),
			executionCompatibilityHash: text("executionCompatibilityHash"),
			dispatchShimVersion: text("dispatchShimVersion"),
			compatibilityDate: text("compatibilityDate"),
			dynamicWorkflowsVersion: text("dynamicWorkflowsVersion"),
			loaderConfigHash: text("loaderConfigHash"),
			tenantCpuMs: number("tenantCpuMs"),
			tenantSubRequests: number("tenantSubRequests"),
		};
	} catch {
		return empty;
	}
}

export async function skillWorkflowRevision(
	run: SkillRun,
	runtime: SkillWorkflowRuntimeProvenance = parseSkillWorkflowRuntimeProvenance(
		null,
	),
	runtimeVariants: SkillWorkflowRuntimeVariant[] = [],
) {
	const runtimeSignatures = new Set(
		runtimeVariants.map((variant) =>
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
	);
	return {
		runId: run.id,
		skillId: run.skillId,
		tediId: run.tediId,
		skillSlug: run.skillSlug ?? null,
		revision: run.skillRevision ?? null,
		status: run.status,
		observedAt: run.startedAt ?? null,
		observedRunCount: 1,
		firstObservedAt: run.startedAt ?? null,
		lastObservedAt: run.startedAt ?? null,
		completedCount: run.status === "completed" ? 1 : 0,
		failedCount: run.status === "failed" ? 1 : 0,
		canceledCount: run.status === "canceled" ? 1 : 0,
		workflowSourceSha256:
			run.workflowSource != null
				? await sha256Digest(run.workflowSource)
				: null,
		skillDocSha256:
			run.skillDoc != null ? await sha256Digest(run.skillDoc) : null,
		runtimeVariants,
		runtimeDriftObserved: runtimeSignatures.size > 1,
		runtimeDriftBlocked: runtimeVariants.some(
			(variant) => variant.observation === "blocked",
		),
		...runtime,
	};
}

export function parseSkillWorkflowRuntimeVariants(
	resolved: ResolvedSkillRunArtifact[],
): Map<string, SkillWorkflowRuntimeVariant[]> {
	const byRun = new Map<string, SkillWorkflowRuntimeVariant[]>();
	for (const { artifact, content } of resolved) {
		const match =
			/^epochs\/(\d+)\/(manifests|runtime-compatible|runtime-drift)\/[a-f0-9]{64}\.json$/.exec(
				artifact.path,
			);
		if (!match) continue;
		const executionEpoch = Number.parseInt(match[1]!, 10);
		if (!Number.isInteger(executionEpoch) || executionEpoch < 0) continue;
		const variant: SkillWorkflowRuntimeVariant = {
			runId: artifact.runId,
			executionEpoch,
			observation:
				match[2] === "runtime-drift"
					? "blocked"
					: match[2] === "runtime-compatible"
						? "compatible"
						: "executed",
			manifestPath: artifact.path,
			observedAt: artifact.createdAt ?? null,
			...parseSkillWorkflowRuntimeProvenance(content),
		};
		const variants = byRun.get(artifact.runId) ?? [];
		variants.push(variant);
		byRun.set(artifact.runId, variants);
	}
	return byRun;
}

export async function loadSkillWorkflowRuntimeVariants(
	context: BaseContext,
	runIds: string[],
): Promise<Map<string, SkillWorkflowRuntimeVariant[]>> {
	if (runIds.length === 0) return new Map();
	const { listRunWorkflowRuntimeObservationsForRuns } =
		await import("@tedix/db/queries/skill-run-artifacts");
	const artifacts = await listRunWorkflowRuntimeObservationsForRuns(
		context.db,
		runIds,
	);
	const env = context.env as { SKILL_ARTIFACTS?: R2Bucket };
	const { resolved, warnings } = await resolveSkillRunArtifactContents({
		artifacts,
		includeArbitraryContent: false,
		loadR2: env.SKILL_ARTIFACTS
			? async (key) => env.SKILL_ARTIFACTS!.get(key)
			: undefined,
	});
	if (warnings.length > 0) {
		console.warn("[skills.workflowRevisions] runtime manifest scan warnings", {
			runCount: runIds.length,
			warnings,
		});
	}
	return parseSkillWorkflowRuntimeVariants(resolved);
}

export async function resolveArtifactText(
	context: BaseContext,
	artifact: { contentInline: string | null; contentR2Key: string | null },
): Promise<string | null> {
	if (artifact.contentInline != null) return artifact.contentInline;
	if (!artifact.contentR2Key) return null;
	const env = context.env as { SKILL_ARTIFACTS?: R2Bucket };
	if (!env.SKILL_ARTIFACTS) return null;
	const object = await env.SKILL_ARTIFACTS.get(artifact.contentR2Key);
	return object ? object.text() : null;
}

export async function loadSkillWorkflowRuntimeProvenance(
	context: BaseContext,
	runId: string,
): Promise<SkillWorkflowRuntimeProvenance> {
	const { getRunArtifact } =
		await import("@tedix/db/queries/skill-run-artifacts");
	const manifest = await getRunArtifact(context.db, runId, "manifest.json");
	return parseSkillWorkflowRuntimeProvenance(
		manifest ? await resolveArtifactText(context, manifest) : null,
	);
}
