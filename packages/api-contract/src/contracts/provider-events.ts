import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	ProviderEventRegisterSchema,
	ProviderEventIdSchema,
	ProviderEventStatusSchema,
} from "../schemas/provider-events";
export const providerEventsContract = oc
	.route({ tags: ["provider-events"], prefix: "/provider-events" })
	.errors(baseErrors)
	.router({
		register: oc
			.route({
				method: "POST",
				path: "/subscriptions",
				summary:
					"Register calendar notifications or MCP event delivery for a tedi skill",
			})
			.input(ProviderEventRegisterSchema)
			.output(ProviderEventStatusSchema),
		list: oc
			.route({
				method: "GET",
				path: "/subscriptions",
				summary: "List provider event subscriptions",
			})
			.input(z.object({}).strict())
			.output(z.array(ProviderEventStatusSchema)),
		get: oc
			.route({
				method: "GET",
				path: "/{id}",
				summary: "Inspect provider event subscription health",
			})
			.input(ProviderEventIdSchema)
			.output(ProviderEventStatusSchema),
		disable: oc
			.route({
				method: "POST",
				path: "/{id}/disable",
				summary: "Disable and unsubscribe provider event delivery",
			})
			.input(ProviderEventIdSchema)
			.output(ProviderEventStatusSchema),
		reconcile: oc
			.route({
				method: "POST",
				path: "/{id}/reconcile",
				summary: "Queue a selected-calendar reconciliation",
			})
			.input(ProviderEventIdSchema)
			.output(z.object({ queued: z.boolean() })),
	});
