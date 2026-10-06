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
	.route({ tags: ["providerEvents"], prefix: "/provider-events" })
	.errors(baseErrors)
	.router({
		register: oc
			.route({
				method: "POST",
				path: "/",
				summary: "Register provider calendar notifications or explicit polling",
			})
			.input(ProviderEventRegisterSchema)
			.output(ProviderEventStatusSchema),
		list: oc
			.route({
				method: "GET",
				path: "/",
				summary: "List calendar event subscriptions",
			})
			.input(z.object({}).strict())
			.output(z.array(ProviderEventStatusSchema)),
		get: oc
			.route({
				method: "GET",
				path: "/{id}",
				summary: "Inspect calendar notification health",
			})
			.input(ProviderEventIdSchema)
			.output(ProviderEventStatusSchema),
		disable: oc
			.route({
				method: "POST",
				path: "/{id}/disable",
				summary: "Disable and unsubscribe calendar notifications",
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
