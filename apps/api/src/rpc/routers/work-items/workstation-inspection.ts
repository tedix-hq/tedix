import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { RepositoryInspectionResultSchema } from "@tedix/api-contract/schemas/workstation";
import { getWorkstationInspectionAuthority } from "@tedix/db/queries/workstations";
import { getAuthoritativeWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import {
	AUTHZ,
	createError,
	ErrorCodes,
	userHoldsPermission,
} from "../../orpc";
import {
	assertWorkItemAccess,
	authOs,
	requireOwnerAdminWorkItemAuthor,
	rethrowWorkItemWriteError,
} from "./policy-helpers";

type InspectionHandlerArgs = Parameters<
	Parameters<typeof authOs.inspectAttemptRepository.handler>[0]
>[0];

export async function inspectAttemptRepository({
	input,
	context,
}: InspectionHandlerArgs) {
	const workItem = await assertWorkItemAccess(context, input.id);
	await requireOwnerAdminWorkItemAuthor(
		context,
		workItem.orgId,
		"Raw repository inspection",
	);
	if (!userHoldsPermission(context, "secrets:manage"))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Raw repository inspection requires secrets management authority",
		);
	const attempt = await getAuthoritativeWorkItemAttempt(context.db, {
		orgId: workItem.orgId,
		workItemId: workItem.id,
		attemptId: input.attemptId,
	}).catch(rethrowWorkItemWriteError);
	if (attempt.executorType !== "tedi")
		throw createError(
			ErrorCodes.CONFLICT,
			"Attempt has no governed workstation",
		);
	const tedi = await getTediByIdForOrganization(
		context.db,
		attempt.executorId,
		workItem.orgId,
	);
	const authority = await getWorkstationInspectionAuthority(context.db, {
		orgId: workItem.orgId,
		workItemId: workItem.id,
		attemptId: attempt.id,
		tediId: attempt.executorId,
	});
	if (
		!tedi?.slug ||
		!authority?.workstationLease.bodyGenerationId ||
		!context.env.TEDI_SERVICE
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"Active repository inspection authority is unavailable",
		);
	const response = await context.env.TEDI_SERVICE.fetch(
		new Request("https://tedi/api/admin/workstation/repository/inspect", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Service-Binding": "true",
				"X-Tedix-Host": `${tedi.slug}.tedi.tedix.dev`,
				"X-Tedix-Org-Id": workItem.orgId,
				"X-Tedix-Tedi-Id": tedi.id,
				"X-Tedix-Workstation": "true",
			},
			body: JSON.stringify({
				...input,
				leaseId: authority.workstationLease.id,
				workstationId: authority.workstation.id,
				workItemId: workItem.id,
				generationId: authority.workstationLease.bodyGenerationId,
			}),
		}),
	);
	if (!response.ok)
		throw createError(
			response.status === 409 ? ErrorCodes.CONFLICT : ErrorCodes.BAD_GATEWAY,
			"Repository inspection is unavailable",
		);
	const parsed = RepositoryInspectionResultSchema.safeParse(
		await response.json().catch(() => null),
	);
	if (!parsed.success)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Invalid repository inspection response",
		);
	return parsed.data;
}

export const inspectAttemptRepositoryProcedure = authOs.inspectAttemptRepository
	.use(AUTHZ.osRead)
	.use(AUTHZ.objectiveRead)
	.handler(inspectAttemptRepository);
