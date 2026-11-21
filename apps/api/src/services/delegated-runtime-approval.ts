import type { z } from "zod";
import type { DelegatedApprovalReceiptSchema } from "@tedix/api-contract/schemas/delegated-approvals";
import { namesOtherOrganization } from "@tedix/api-contract/utils/approval-holds";
import { delegatedClassAllowed } from "@tedix/api-contract/utils/delegated-approvals";
import { delegatedApprover } from "@tedix/db/queries/work-items/delegated-approvals";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import type { TediApprovalRequest } from "@tedix/db/schema/approvals";
import { verifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import { parseHomeToolWritePayload } from "../rpc/routers/kernel/write-executor";
import type { BaseContext } from "../rpc/orpc";

/** Resolve checks the caller; execution checks the saved decider again. */
export async function runtimeApprovalDelegate(
	context: BaseContext,
	approval: TediApprovalRequest,
	receipt?: z.infer<typeof DelegatedApprovalReceiptSchema>,
) {
	const payload = parseHomeToolWritePayload(approval.payload);
	if (
		approval.actionType !== "home.tool_write" ||
		!payload?.initiatedByUserId ||
		payload.organizationId !== approval.orgId ||
		!delegatedClassAllowed({
			actionClass: "change",
			declaredClass: approval.payload.declaredClass,
		}) ||
		namesOtherOrganization(
			[payload.args, ...(payload.additionalArgs ?? [])],
			approval.orgId,
		)
	)
		return null;
	const owner = await getMemberByUserId(
		context.db,
		approval.orgId,
		payload.initiatedByUserId,
	);
	if (owner?.status !== "active" || !owner.userId) return null;
	if (
		receipt &&
		(receipt.ownerId !== owner.userId ||
			approval.resolvedBy !== `${receipt.actorType}:${receipt.actorId}`)
	)
		return null;
	const actor = receipt
		? { type: receipt.actorType, id: receipt.actorId }
		: await verifiedActiveWorkActor(context, approval.orgId);
	return delegatedApprover(context.db, {
		orgId: approval.orgId,
		ownerId: owner.userId,
		actor,
	});
}
