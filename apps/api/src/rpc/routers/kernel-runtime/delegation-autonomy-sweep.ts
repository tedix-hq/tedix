import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { listPendingDelegationRuns } from "@tedix/db/queries/kernel-runtime-runs";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { createError, ErrorCodes, withAuthorization } from "../../orpc";
import { resolveOrganizationId } from "../kernel/runtime-shared";
import { deriveApprovalAuthority } from "../kernel/context-assembly";
import { authed } from "./policy-normalization";
import { reviewDelegationAutonomy } from "./delegation-autonomy-review";
import { respondKernelDelegationRecommendationApprovalCore } from "./approval-control";
import { releaseWorkstationDelegationAutonomy } from "./delegation-autonomy-workstation";

export const sweepDelegationAutonomyRoute = authed.sweepDelegationAutonomy
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Policy sweeps require a freshly verified active owner/admin in the selected organization",
			},
			"mcp:tedis.write",
		),
	)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		const userId = context.descopeUserId ?? context.user?.sub;
		const member = userId
			? await getMemberByUserId(context.db, organizationId, userId)
			: null;
		if (
			!member ||
			member.status !== "active" ||
			!deriveApprovalAuthority(member.role)
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"An active owner/admin must request the policy sweep",
			);
		const runs = await listPendingDelegationRuns(context.db, {
			organizationId,
			limit: input.limit + 1,
			cursor: input.cursor,
		});
		const dispatched: string[] = [];
		const held: Array<{ runId: string; reason: string }> = [];
		for (const run of runs.slice(0, input.limit)) {
			const review = await reviewDelegationAutonomy(context, run);
			if (!review.allowed) {
				held.push({ runId: run.id, reason: review.reason });
				continue;
			}
			try {
				if (review.workstation)
					await releaseWorkstationDelegationAutonomy(context, {
						organizationId,
						runId: run.id,
					});
				else
					await respondKernelDelegationRecommendationApprovalCore(context, {
						organizationId,
						run,
						decision: "approve",
						resolvedBy: { type: "policy", id: "delegation-autonomy.v1" },
						note: "Released by active low/medium autonomy policy; no human approval was supplied.",
					});
				dispatched.push(run.id);
			} catch (error) {
				held.push({
					runId: run.id,
					reason:
						error instanceof Error ? error.message : "policy release failed",
				});
			}
		}
		const last = runs.slice(0, input.limit).at(-1);
		await insertAuditEvent(context.db, {
			organizationId,
			actorType: "user",
			actorId: userId!,
			action: "kernel.delegation.autonomy_swept",
			resourceType: "organization",
			resourceId: organizationId,
			metadata: { policyVersion: 1, dispatched, held },
			ipAddress: context.headers.get("CF-Connecting-IP"),
			userAgent: context.headers.get("User-Agent"),
		});
		return {
			dispatched,
			held,
			nextCursor:
				runs.length > input.limit && last
					? { at: last.createdAt, id: last.id }
					: null,
		};
	});
