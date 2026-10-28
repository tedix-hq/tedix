import { call } from "@orpc/server";
import { AppRuntimeSkillReadSchema } from "@tedix/api-contract/schemas/os-app-runtime";
import { JsonValueSchema } from "@tedix/api-contract/schemas/common";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { getRunArtifact } from "@tedix/db/queries/skill-run-artifacts";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	hasTedisReadAuthorization,
	hasRequiredScope,
} from "../rpc/orpc";
import { authorizeDerivedOutputSources } from "./os-derived-resource-access";

/** The caller, current app grants and active slot have already been checked by the app router. */
export async function readWorkspaceAppSkill(
	context: BaseContext,
	resource: OsWorkspaceResourceRow,
	input: unknown,
) {
	if (
		resource.providerId !== "tedix" ||
		resource.resourceType !== "skill" ||
		resource.status !== "active" ||
		resource.organizationId !== context.organizationId ||
		!hasTedisReadAuthorization(context) ||
		!hasRequiredScope(context, "tedis:read")
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Skill read is not permitted for this slot",
		);
	}
	const args = AppRuntimeSkillReadSchema.parse(input);
	const run = await getSkillRun(
		context.db,
		args.runId,
		resource.organizationId,
		context.env.ENVIRONMENT,
	);
	if (
		!run ||
		run.organizationId !== resource.organizationId ||
		run.skillId !== resource.providerResourceId ||
		run.workflowRetiredAt ||
		run.error === "REVOKED" ||
		run.error?.startsWith("REVOKED:")
	) {
		throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
	}
	if (
		run.resourceAccessEnvelope &&
		!(await authorizeDerivedOutputSources(context, {
			organizationId: resource.organizationId,
			accessEnvelope: run.resourceAccessEnvelope,
		}))
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Run sources are no longer available",
		);
	}
	if (args.view === "run") {
		return JsonValueSchema.parse({
			id: run.id,
			skillId: run.skillId,
			status: run.status,
			executionEpoch: run.executionEpoch ?? 0,
			startedAt: run.startedAt,
			completedAt: run.completedAt,
			result: run.result ?? null,
		});
	}
	if (args.view === "artifact") {
		const artifact = await getRunArtifact(context.db, run.id, args.path);
		if (!artifact || artifact.sizeBytes > 262144)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Run output is unavailable or exceeds 256 KiB",
			);
		const { skillsGetRunArtifact } =
			await import("../rpc/routers/cognitive-skill-runs/artifacts");
		return JsonValueSchema.parse(
			await call(
				skillsGetRunArtifact,
				{
					runId: run.id,
					skillId: resource.providerResourceId,
					path: args.path,
				},
				{ context },
			),
		);
	}
	if (args.view === "artifacts") {
		const { skillsListRunArtifacts } =
			await import("../rpc/routers/cognitive-skill-runs/artifacts");
		return JsonValueSchema.parse(
			await call(
				skillsListRunArtifacts,
				{
					runId: run.id,
					skillId: resource.providerResourceId,
					limit: args.limit,
					offset: args.offset,
				},
				{ context },
			),
		);
	}
	const { skillsGetWorkflowRunTimeline } =
		await import("../rpc/routers/cognitive-skill-runs/run-reads");
	return JsonValueSchema.parse(
		await call(skillsGetWorkflowRunTimeline, { runId: run.id }, { context }),
	);
}
