/**
 * Sensitive-data lock on a run, for people and the agents acting for them.
 *
 * The lock is set by the MCP gateway (`mcpGovernance.latchRunSensitiveData`)
 * when a run reads a sensitive source. Anyone who may read tedis can see it;
 * only an active owner or admin may clear it, and the clear is an audit event.
 */

import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	clearRunSensitiveDataLatch,
	getRunSensitiveDataLatch,
} from "@tedix/db/queries/sensitive-data-latch";
import { AUTHZ, createError, ErrorCodes } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authedSkills } from "../cognitive-shared";
import { verifiedActiveUserMembership } from "../work-items-principal";

export const SENSITIVE_DATA_LATCH_CLEARED_ACTION =
	"run.sensitive_data_latch_cleared";

export const skillsGetRunSensitiveDataLatch =
	authedSkills.getRunSensitiveDataLatch
		.use(AUTHZ.tedisRead)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			return getRunSensitiveDataLatch(context.db, {
				organizationId,
				runRef: input.runRef,
			});
		});

export const skillsClearRunSensitiveDataLatch =
	authedSkills.clearRunSensitiveDataLatch
		.use(AUTHZ.tedisWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			const membership = await verifiedActiveUserMembership(
				context,
				organizationId,
				"owner or admin",
			);
			if (membership.role !== "owner" && membership.role !== "admin")
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an owner or admin can clear a run's sensitive-data lock",
				);
			const db = context.db;
			const state = await getRunSensitiveDataLatch(db, {
				organizationId,
				runRef: input.runRef,
			});
			if (!state.known)
				throw createError(ErrorCodes.NOT_FOUND, "Run not found");
			const latch = await clearRunSensitiveDataLatch(db, {
				organizationId,
				runRef: input.runRef,
			});
			if (!latch) return { cleared: false, latch: null };
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: membership.userId,
				actorType: "user",
				action: SENSITIVE_DATA_LATCH_CLEARED_ACTION,
				resourceType: input.runRef.kind,
				resourceId: input.runRef.id,
				metadata: {
					reason: input.reason,
					reviewerRole: membership.role,
					latch,
				},
			});
			return { cleared: true, latch };
		});
