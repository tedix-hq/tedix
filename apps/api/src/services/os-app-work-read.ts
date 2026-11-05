import { call } from "@orpc/server";
import { AppRuntimeWorkReadSchema } from "@tedix/api-contract/schemas/os-app-runtime";
import { JsonValueSchema } from "@tedix/api-contract/schemas/common";
import type { WorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import { getProjectByIdForOrganization } from "@tedix/db/queries/projects";
import { createOsGadgetExecution } from "@tedix/db/queries/os-workspaces/executions";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";

/**
 * Read the live Work board of the Tedix project bound to a granted slot. The
 * app router has already checked the session, role and slot grant; this
 * checks the binding and the acting member, then records the same
 * observation receipt a connection read records.
 */
export async function readWorkspaceAppWork(
	context: BaseContext,
	session: WorkspaceAppSession,
	resource: OsWorkspaceResourceRow,
	input: unknown,
) {
	const args = AppRuntimeWorkReadSchema.parse(input ?? {});
	const actingUserId = context.user?.sub;
	if (
		!actingUserId ||
		resource.providerId !== "tedix" ||
		resource.resourceType !== "project" ||
		resource.status !== "active" ||
		resource.organizationId !== context.organizationId ||
		context.authType !== "user" ||
		!context.userRole ||
		(args.projectId !== undefined &&
			args.projectId !== resource.providerResourceId)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Work read is not permitted for this slot",
		);
	const project = await getProjectByIdForOrganization(
		context.db,
		resource.organizationId,
		resource.providerResourceId,
	);
	if (!project)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Work read is not permitted for this slot",
		);
	const { listCliProjectionProcedure } =
		await import("../rpc/routers/work-items/creation-reads");
	const page = await call(
		listCliProjectionProcedure,
		{
			view: "board",
			projectId: project.id,
			limit: args.limit,
			offset: args.offset,
		},
		{ context },
	);
	await createOsGadgetExecution(createDbQueryClient(context.env.DB), {
		id: crypto.randomUUID(),
		organizationId: resource.organizationId,
		workspaceId: resource.workspaceId,
		gadgetId: session.gadgetId,
		revisionId: session.revisionId,
		revision: session.revision,
		status: "completed",
		completedAt: new Date().toISOString(),
		input: JSON.stringify({
			kind: "connection_observation",
			appSlug: "tedix-work",
			toolId: "list_work_item_cli_rows",
			slot: resource.slot,
			providerId: resource.providerId,
			resourceType: resource.resourceType,
			providerResourceId: resource.providerResourceId,
			resourceName: resource.name,
			account: "organization",
			actingUserId,
			checkEachPersonsAccess: true,
			ownAccess: "own_account",
			mode: "enforce",
			wouldDeny: false,
			containsRestrictedData: false,
		}),
		output: JSON.stringify({
			rows: page.data.length,
			total: page.pagination.total,
		}),
		grantedCapabilities: JSON.stringify(["work.read"]),
		policyDecision: JSON.stringify({
			allowed: true,
			reasons: ["connection_observation", "own_access:own_account"],
		}),
		createdByKind: "user",
		createdById: actingUserId,
		runtimeEnvironment: context.env.ENVIRONMENT,
	});
	return JsonValueSchema.parse({
		project: { id: project.id, name: project.name },
		rows: page.data,
		pagination: page.pagination,
	});
}
