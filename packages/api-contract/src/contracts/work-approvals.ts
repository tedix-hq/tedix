import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	CreateWorkApprovalProposalInputSchema,
	DecideWorkApprovalProposalInputSchema,
	ListWorkApprovalInboxInputSchema,
	ListWorkApprovalInboxResultSchema,
	WorkApprovalDecisionReceiptSchema,
	WorkApprovalProposalSchema,
} from "../schemas/work-approvals";
import * as z from "zod";

export const workApprovalsContract = oc
	.route({ tags: ["work-approvals"], prefix: "/work-approvals" })
	.errors(baseErrors)
	.router({
		propose: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Propose Work admission approval",
				successStatus: 201,
			})
			.input(CreateWorkApprovalProposalInputSchema)
			.output(WorkApprovalProposalSchema),

		decide: oc
			.route({
				method: "POST",
				path: "/{proposalId}/decision",
				summary: "Decide Work approval proposal",
			})
			.input(DecideWorkApprovalProposalInputSchema)
			.output(
				z.strictObject({
					proposal: WorkApprovalProposalSchema,
					decision: WorkApprovalDecisionReceiptSchema,
				}),
			),

		listInbox: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List Work approval inbox",
			})
			.input(ListWorkApprovalInboxInputSchema)
			.output(ListWorkApprovalInboxResultSchema),

		listAudit: oc
			.route({
				method: "GET",
				path: "/audit",
				summary: "List organization Work approval audit ledger",
			})
			.input(ListWorkApprovalInboxInputSchema)
			.output(ListWorkApprovalInboxResultSchema),
	});

export type WorkApprovalsContract = typeof workApprovalsContract;
