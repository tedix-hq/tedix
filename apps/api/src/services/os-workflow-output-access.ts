import { coreQueryDb } from "@tedix/db/core-store/scope";
import { readWorkspaceRuntimeRole } from "@tedix/db/queries/os-workspace-access";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import type { OsOutputRow } from "@tedix/db/tenant-store/outputs-schema";
import { OsDerivedAccessEnvelopeSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";
import { resolveOsWorkspacePrincipal } from "./os-workspace-visibility";
import { getOsWorkspaceResource } from "./workspace-resource-storage";

export type WorkflowOutputOperation = "outputs.read" | "outputs.write";

/** A use role runs declared operations; it never grants general workspace visibility. */
export async function authorizeWorkflowOutput(
	context: BaseContext,
	output: OsOutputRow,
	operation: WorkflowOutputOperation,
): Promise<boolean> {
	if (
		context.authType !== "service-binding" ||
		!isServiceBinding(context.headers) ||
		!context.tediId ||
		!output.workspaceId ||
		output.organizationId !== context.organizationId
	)
		return false;
	const principal = await resolveOsWorkspacePrincipal(context);
	if (principal?.actorKind !== "tedi") return false;
	const db = coreQueryDb(context.env);
	const scope = {
		organizationId: output.organizationId,
		workspaceId: output.workspaceId,
	};
	const role = await readWorkspaceRuntimeRole(db, scope, principal);
	if (role !== "use") return false;
	function deny(reason: string): never {
		throw createError(ErrorCodes.FORBIDDEN, reason);
	}
	const runId = context.headers.get("X-Tedix-Skill-Run-Id");
	const epoch = context.headers.get("X-Tedix-Workflow-Execution-Epoch");
	const tool =
		operation === "outputs.read" ? "get_os_output" : "set_os_sheet_range";
	const toolId = context.headers.get("X-Tedix-Mcp-Tool-Id");
	if (!runId || !epoch || !/^(0|[1-9][0-9]*)$/.test(epoch) || toolId !== tool)
		deny(
			"Workspace Output access requires a verified workflow run and tool grant",
		);
	const run = await getSkillRun(
		context.db,
		runId,
		scope.organizationId,
		context.env.ENVIRONMENT,
	);
	if (
		!run ||
		run.tediId !== context.tediId ||
		run.status !== "running" ||
		run.executionEpoch !== Number(epoch) ||
		run.workflowRetiredAt ||
		run.restartRequestedAt
	)
		deny(
			"Workspace Output access requires the acting tedi's current workflow run",
		);
	const envelope = OsDerivedAccessEnvelopeSchema.safeParse(
		run.resourceAccessEnvelope,
	);
	const source = envelope.success
		? envelope.data.sources.find(
				(source) =>
					source.workspaceId === output.workspaceId &&
					source.providerId === "tedix" &&
					source.resourceType === "output" &&
					source.providerResourceId === output.id &&
					source.connectionScope === "tenant" &&
					source.operations.includes(operation) &&
					Boolean(source.toolIds?.includes(`os.${tool}`)),
			)
		: undefined;
	if (!source)
		deny(`Missing ${operation} resourceAccessEnvelope grant for os.${tool}`);
	// A sheet-range write returns the updated sheet, including unchanged cells.
	if (!source.operations.includes("outputs.read"))
		deny(`Missing outputs.read resourceAccessEnvelope grant for os.${tool}`);
	const [workspace, resource] = await Promise.all([
		getOsWorkspace(db, scope),
		getOsWorkspaceResource(db, {
			...scope,
			resourceId: source.workspaceResourceId,
		}),
	]);
	if (
		workspace?.status !== "active" ||
		output.status !== "active" ||
		!resource ||
		resource.status !== "active" ||
		resource.providerId !== "tedix" ||
		resource.resourceType !== "output" ||
		resource.providerResourceId !== output.id ||
		resource.connectionScope !== "tenant" ||
		resource.providerAccess?.canRead === false ||
		(operation === "outputs.write" &&
			resource.providerAccess?.canWrite === false)
	)
		deny(`The workspace resource no longer grants ${operation}`);
	return true;
}
