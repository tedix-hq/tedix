import * as z from "zod";
export const ProviderEventAdapterSchema = z.enum([
	"google_calendar",
	"microsoft_calendar",
]);
export const ProviderEventRegisterSchema = z
	.object({
		adapter: ProviderEventAdapterSchema,
		providerId: z.string().min(1).max(200),
		connectionInstanceId: z.uuid(),
		calendarId: z.string().min(1).max(1024),
		tediId: z.uuid(),
		skillId: z.uuid(),
		skillRevision: z.number().int().positive(),
		// A provider may deny push subscriptions to shared calendars. Polling is explicit.
		deliveryMode: z.enum(["push", "poll"]).default("push"),
	})
	.strict();
export const ProviderEventIdSchema = z.object({ id: z.uuid() }).strict();
export const ProviderEventStatusSchema = z.object({
	id: z.uuid(),
	organizationId: z.string(),
	adapter: ProviderEventAdapterSchema,
	providerId: z.string(),
	connectionInstanceId: z.string().nullable(),
	calendarId: z.string(),
	tediId: z.string(),
	skillId: z.string(),
	skillRevision: z.number().int().positive(),
	deliveryMode: z.enum(["push", "poll"]),
	status: z.enum(["registering", "active", "error", "disabled"]),
	expiresAt: z.string().nullable(),
	nextReconcileAt: z.string(),
	lastNotificationAt: z.string().nullable(),
	lastDispatchAt: z.string().nullable(),
	lastError: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type ProviderEventRegister = z.infer<typeof ProviderEventRegisterSchema>;
