import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { z } from "zod";
import { baseErrors } from "../errors";
import {
	CalendarAccountSelectionSchema,
	CalendarConfigurationSchema,
	CalendarConfigRevisionSchema,
	CalendarInfoSchema,
	CalendarPlanSchema,
	CalendarReceiptSchema,
	CalendarStatusSchema,
	ConfigureCalendarsInputSchema,
} from "../schemas/calendar-coordinator";
export const calendarCoordinatorContract = oc
	.route({ tags: ["calendar-coordinator"], prefix: "/calendar-coordinator" })
	.errors(baseErrors)
	.router({
		supportedAccounts: oc
			.route({ method: "GET", path: "/accounts" })
			.input(z.object({ scope: z.enum(["tenant", "user"]) }))
			.output(
				z.array(
					CalendarAccountSelectionSchema.extend({
						instanceLabel: z.string(),
						accountSubject: z.string().nullable(),
					}),
				),
			),
		listCalendars: oc
			.route({ method: "GET", path: "/calendars" })
			.input(CalendarAccountSelectionSchema)
			.output(
				z.object({
					account: CalendarAccountSelectionSchema.extend({
						instanceLabel: z.string(),
						accountSubject: z.string().nullable(),
					}),
					calendars: z.array(CalendarInfoSchema),
				}),
			),
		list: oc
			.route({ method: "GET", path: "/" })
			.input(z.object({ workspaceId: z.string().uuid() }))
			.output(z.array(CalendarConfigurationSchema)),
		configure: oc
			.route({ method: "POST", path: "/" })
			.input(ConfigureCalendarsInputSchema)
			.output(CalendarConfigurationSchema),
		activate: oc
			.route({ method: "POST", path: "/{id}/activate" })
			.input(
				CalendarConfigRevisionSchema.extend({
					actions: z.array(z.enum(["create", "update", "delete"])).min(1),
				}),
			)
			.output(CalendarConfigurationSchema),
		deactivate: oc
			.route({ method: "POST", path: "/{id}/deactivate" })
			.input(CalendarConfigRevisionSchema)
			.output(CalendarConfigurationSchema),
		preview: oc
			.route({ method: "POST", path: "/{id}/preview" })
			.input(CalendarConfigRevisionSchema)
			.output(CalendarPlanSchema),
		apply: oc
			.route({ method: "POST", path: "/{id}/apply" })
			.input(CalendarConfigRevisionSchema.extend({ planId: z.string().uuid() }))
			.output(CalendarReceiptSchema),
		previewCompensation: oc
			.route({ method: "POST", path: "/{id}/compensation-preview" })
			.input(
				CalendarConfigRevisionSchema.extend({
					planId: z.string().uuid(),
					actionIds: z.array(z.string()).min(1).max(20),
				}),
			)
			.output(CalendarPlanSchema),
		compensate: oc
			.route({ method: "POST", path: "/{id}/compensate" })
			.input(CalendarConfigRevisionSchema.extend({ planId: z.string().uuid() }))
			.output(CalendarReceiptSchema),
		recover: oc
			.route({ method: "POST", path: "/{id}/recover" })
			.input(CalendarConfigRevisionSchema.extend({ planId: z.string().uuid() }))
			.output(CalendarReceiptSchema),
		reconcileSubscription: oc
			.route({
				method: "POST",
				path: "/subscriptions/{subscriptionId}/reconcile",
			})
			.input(
				z.object({
					subscriptionId: z.string().uuid(),
					expectedSkillRevision: z.number().int().positive(),
				}),
			)
			.output(CalendarReceiptSchema),
		status: oc
			.route({ method: "GET", path: "/{id}" })
			.input(z.object({ id: z.string().uuid() }))
			.output(CalendarStatusSchema),
	});
