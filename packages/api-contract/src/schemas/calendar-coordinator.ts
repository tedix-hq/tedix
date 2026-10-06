import { z } from "zod";
import { ProviderEventStatusSchema } from "./provider-events";
const id = z.string().uuid();
export const CalendarIntervalSchema = z
	.object({ start: z.string().datetime(), end: z.string().datetime() })
	.refine(
		(v) => Date.parse(v.start) < Date.parse(v.end),
		"End must follow start",
	);
export const CalendarAccountSelectionSchema = z.object({
	adapter: z.enum(["google", "microsoft"]),
	providerId: z.string().min(1).max(200),
	connectionScope: z.enum(["tenant", "user"]),
	connectionInstanceId: id,
});
export const CalendarRouteSchema = CalendarAccountSelectionSchema.extend({
	key: z.string().min(1).max(100),
	calendarId: z.string().min(1).max(1000),
	workspaceResourceId: id,
	delegationId: id.optional(),
	deliveryMode: z.enum(["push", "poll"]).default("push"),
});
export const CalendarInfoSchema = z.object({
	id: z.string(),
	name: z.string(),
	timeZone: z.string().nullable(),
	canRead: z.boolean(),
	canWrite: z.boolean(),
	ownerEmail: z.string().nullable(),
	conditionalWrites: z.boolean(),
});
export const CalendarConfigurationSchema = z.object({
	id,
	workspaceId: id,
	organizationId: id,
	ownerUserId: z.string(),
	revision: z.number().int().positive(),
	mode: z.enum(["preview", "active"]),
	timeZone: z.string(),
	window: CalendarIntervalSchema,
	tediId: id,
	skillId: id,
	skillRevision: z.number().int().positive(),
	subscriptionIds: z.array(id).default([]),
	calendars: z.array(CalendarRouteSchema),
	actions: z.array(z.enum(["create", "update", "delete"])),
});
export const ConfigureCalendarsInputSchema = z
	.object({
		id: id.optional(),
		workspaceId: id,
		expectedRevision: z.number().int().nonnegative(),
		tediId: id,
		skillId: id,
		skillRevision: z.number().int().positive(),
		timeZone: z.string().min(1).max(100),
		window: CalendarIntervalSchema,
		calendars: z.array(CalendarRouteSchema).min(2).max(20),
	})
	.superRefine((v, ctx) => {
		if (new Set(v.calendars.map((c) => c.key)).size !== v.calendars.length)
			ctx.addIssue({ code: "custom", message: "Calendar keys must be unique" });
		if (
			new Set(
				v.calendars.map((c) =>
					JSON.stringify([
						c.providerId,
						c.connectionScope,
						c.connectionInstanceId,
						c.calendarId,
					]),
				),
			).size !== v.calendars.length
		)
			ctx.addIssue({
				code: "custom",
				message: "Calendar selections must be distinct",
			});
		if (Date.parse(v.window.end) - Date.parse(v.window.start) > 90 * 86400_000)
			ctx.addIssue({
				code: "custom",
				message: "Preview window is limited to 90 days",
			});
		if (Boolean(v.id) !== v.expectedRevision > 0)
			ctx.addIssue({
				code: "custom",
				message: "Existing configuration requires its revision",
			});
	});
export const CalendarConfigRevisionSchema = z.object({
	id,
	expectedRevision: z.number().int().positive(),
});
export const CalendarActionSchema = z.object({
	id: z.string(),
	kind: z.enum(["create", "update", "delete"]),
	sourceKey: z.string(),
	sourceRouteKey: z.string(),
	sourceEventId: z.string(),
	sourceRevision: z.string().nullable(),
	destinationKey: z.string(),
	destinationEventId: z.string(),
	expectedDestinationRevision: z.string().nullable(),
	ownership: z.string(),
	before: CalendarIntervalSchema.nullable(),
	after: CalendarIntervalSchema.nullable(),
	compensatesActionId: z.string().optional(),
});
export const CalendarPlanSchema = z.object({
	id,
	configurationId: id,
	configurationRevision: z.number().int().positive(),
	purpose: z.enum(["reconcile", "compensate"]),
	originalPlanId: id.optional(),
	window: CalendarIntervalSchema,
	complete: z.boolean(),
	createdAt: z.string(),
	actions: z.array(CalendarActionSchema),
	conflicts: z.array(z.string()),
	snapshotFingerprints: z.record(z.string(), z.string()),
});
export const CalendarMutationSchema = z.object({
	actionId: z.string(),
	state: z.enum(["intent", "confirmed", "uncertain", "conflict"]),
	eventId: z.string(),
	revision: z.string().nullable(),
	error: z.string().nullable(),
});
export const CalendarReceiptSchema = z.object({
	planId: id,
	outcome: z.enum(["confirmed", "partial", "conflict"]),
	mutations: z.array(CalendarMutationSchema),
});
export const CalendarStatusSchema = z.object({
	configuration: CalendarConfigurationSchema,
	lastReceipt: CalendarReceiptSchema.nullable(),
	lastSuccessfulReconcileAt: z.string().nullable(),
	monitoring: z.enum([
		"not_installed",
		"active",
		"needs_attention",
		"disabled",
	]),
	subscriptions: z.array(ProviderEventStatusSchema),
	message: z.string(),
});
