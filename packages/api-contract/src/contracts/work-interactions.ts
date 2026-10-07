import {
	ListWorkInteractionCliInboxInputSchema,
	ListWorkInteractionCliInboxResultSchema,
} from "../schemas/work-interactions";
import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	CancelWorkInteractionInputSchema,
	CreateWorkInteractionInputSchema,
	DelegateWorkInteractionInputSchema,
	GetWorkInteractionInputSchema,
	GetWorkInteractionResultSchema,
	ListWorkInteractionInboxInputSchema,
	ListWorkInteractionInboxResultSchema,
	RespondToWorkInteractionInputSchema,
	WorkInteractionRequestSchema,
	WorkInteractionResponseSchema,
} from "../schemas/work-interactions";

export const workInteractionsContract = oc
	.route({ tags: ["work-interactions"], prefix: "/work-interactions" })
	.errors(baseErrors)
	.router({
		listCliInboxProjection: oc
			.route({
				method: "GET",
				path: "/cli-inbox",
				summary: "Bounded CLI interaction inbox",
			})
			.input(ListWorkInteractionCliInboxInputSchema)
			.output(ListWorkInteractionCliInboxResultSchema),
		delegate: oc
			.route({
				method: "POST",
				path: "/{requestId}/delegate",
				summary: "Delegate a question to a tedi",
			})
			.input(DelegateWorkInteractionInputSchema)
			.output(WorkInteractionRequestSchema),
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create Work interaction",
				successStatus: 201,
			})
			.input(CreateWorkInteractionInputSchema)
			.output(WorkInteractionRequestSchema),
		respond: oc
			.route({
				method: "POST",
				path: "/{requestId}/responses",
				summary: "Respond to Work interaction",
				successStatus: 201,
			})
			.input(RespondToWorkInteractionInputSchema)
			.output(
				z.strictObject({
					request: WorkInteractionRequestSchema,
					response: WorkInteractionResponseSchema,
				}),
			),
		cancel: oc
			.route({
				method: "POST",
				path: "/{requestId}/cancel",
				summary: "Cancel Work interaction",
			})
			.input(CancelWorkInteractionInputSchema)
			.output(WorkInteractionRequestSchema),
		get: oc
			.route({
				method: "GET",
				path: "/{requestId}",
				summary: "Get Work interaction detail",
			})
			.input(GetWorkInteractionInputSchema)
			.output(GetWorkInteractionResultSchema),
		listInbox: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List Work interaction inbox",
			})
			.input(ListWorkInteractionInboxInputSchema)
			.output(ListWorkInteractionInboxResultSchema),
		listOutbox: oc
			.route({
				method: "GET",
				path: "/outbox",
				summary: "List authenticated creator Work interaction outbox",
			})
			.input(ListWorkInteractionInboxInputSchema)
			.output(ListWorkInteractionInboxResultSchema),
		listAudit: oc
			.route({
				method: "GET",
				path: "/audit",
				summary: "List organization Work interaction audit ledger",
			})
			.input(ListWorkInteractionInboxInputSchema)
			.output(ListWorkInteractionInboxResultSchema),
	});

export type WorkInteractionsContract = typeof workInteractionsContract;
