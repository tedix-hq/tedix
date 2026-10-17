import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	FileSupportRequestSchema,
	SupportAnswerSchema,
	SupportConfigurationSchema,
	SupportReceiptSchema,
	SupportReportSchema,
} from "../schemas/support";

const ticket = z.strictObject({ ticketId: z.uuid() });
const edit = z.strictObject({
	ticketId: z.uuid(),
	expectedVersion: z.number().int().positive(),
	idempotencyKey: z.string().min(1).max(128),
});
const staffTicket = z.strictObject({
	receipt: SupportReceiptSchema,
	report: SupportReportSchema,
	mirrorWorkItemId: z.uuid(),
	draft: SupportAnswerSchema.nullable(),
	escalationWorkItemId: z.string().nullable(),
	interactionId: z.string().nullable(),
});
export const supportContract = oc.errors(baseErrors).router({
	review: oc
		.route({
			method: "POST",
			path: "/support/review",
			summary: "Record the daily internal support digest for the admin",
		})
		.input(z.strictObject({ summary: z.string().min(1).max(4000) }))
		.output(z.strictObject({ workItemId: z.uuid(), interactionId: z.uuid() })),
	file: oc
		.route({
			method: "POST",
			path: "/support/requests",
			summary: "File a consented support request or follow-up",
		})
		.input(FileSupportRequestSchema)
		.output(SupportReceiptSchema),
	status: oc
		.route({
			method: "GET",
			path: "/support/status",
			summary: "Read your public support status",
		})
		.input(
			ticket.extend({
				afterVersion: z.number().int().nonnegative().default(0),
			}),
		)
		.output(SupportReceiptSchema),
	mine: oc
		.route({
			method: "GET",
			path: "/support/mine",
			summary: "List your support tickets",
		})
		.input(
			z.strictObject({ limit: z.number().int().min(1).max(100).default(50) }),
		)
		.output(
			z.strictObject({
				items: z.array(SupportReceiptSchema),
				canReview: z.boolean(),
			}),
		),
	configure: oc
		.route({
			method: "POST",
			path: "/support/configuration",
			summary: "Configure the installation support bridge",
		})
		.input(SupportConfigurationSchema)
		.output(SupportConfigurationSchema),
	queue: oc
		.route({
			method: "GET",
			path: "/support/queue",
			summary: "Read the ticket-scoped support queue",
		})
		.input(
			z.strictObject({
				limit: z.number().int().min(1).max(100).default(50),
				includeClosed: z.boolean().default(false),
			}),
		)
		.output(z.array(staffTicket)),
	get: oc
		.route({
			method: "GET",
			path: "/support/ticket",
			summary: "Read one consented support ticket",
		})
		.input(ticket)
		.output(staffTicket),
	draft: oc
		.route({
			method: "POST",
			path: "/support/draft",
			summary: "Draft a cited support answer; never sends",
		})
		.input(
			edit.extend({
				answer: SupportAnswerSchema,
			}),
		)
		.output(staffTicket),
	publish: oc
		.route({
			method: "POST",
			path: "/support/publish",
			summary: "Human admin publishes the exact reviewed support draft",
		})
		.input(edit)
		.output(SupportReceiptSchema),
	escalate: oc
		.route({
			method: "POST",
			path: "/support/escalate",
			summary: "Escalate diagnosis to engineering Work or one human question",
		})
		.input(
			edit.extend({
				target: z.enum(["engineering", "admin"]),
				reason: z
					.string()
					.min(1)
					.max(500)
					.regex(/^[^\r\n]+$/),
			}),
		)
		.output(staffTicket),
});
