import { JsonValueSchema } from "./common";
import * as z from "zod";
export const ProviderEventAdapterSchema = z.enum([
	"google_calendar",
	"microsoft_calendar",
	"mcp_events",
	"github_webhook",
]);
export const MCP_EVENTS_DEFAULT_MAX_WAKES_PER_HOUR = 12;
/** Draft SEP-3415 events of one connected upstream MCP app. */
export const McpEventsSubscriptionSchema = z
	.object({
		// The organization-owned app whose upstream MCP endpoint emits the event.
		appId: z.uuid(),
		eventName: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[A-Za-z0-9._:/-]+$/),
		arguments: z.record(z.string(), JsonValueSchema).default({}),
		maxWakesPerHour: z
			.number()
			.int()
			.min(1)
			.max(120)
			.default(MCP_EVENTS_DEFAULT_MAX_WAKES_PER_HOUR),
	})
	.strict();
export const GithubWebhookResourceKeySchema = z
	.string()
	.regex(/^(?!\.{1,2}\/)(?!.*\/\.{1,2}$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const GithubWebhookSubscriptionSchema = z
	.object({
		events: z
			.array(
				z
					.string()
					.regex(/^[a-z_]+$/)
					.max(100),
			)
			.min(1)
			.max(30),
		maxWakesPerHour: z.number().int().min(1).max(120).default(12),
	})
	.strict();
export const PersonalSubscriptionBindingSchema = z
	.object({
		workspaceId: z.uuid(),
		resourceId: z.uuid(),
		delegationId: z.uuid(),
		toolId: z.string().min(1).max(200),
	})
	.strict();
export const ProviderEventRegisterSchema = z
	.object({
		adapter: ProviderEventAdapterSchema,
		providerId: z.string().min(1).max(200),
		connectionInstanceId: z.uuid(),
		// Calendar id or repository owner/name; MCP events use mcpEvents.eventName.
		resourceKey: z.string().min(1).max(1024).optional(),
		mcpEvents: McpEventsSubscriptionSchema.optional(),
		githubWebhook: GithubWebhookSubscriptionSchema.optional(),
		connectionScope: z.enum(["tenant", "user"]).default("tenant"),
		personalDelegation: PersonalSubscriptionBindingSchema.optional(),
		resourceDelegationIds: z.array(z.uuid()).max(20).optional(),
		tediId: z.uuid(),
		skillId: z.uuid(),
		skillRevision: z.number().int().positive(),
		// A provider may deny push subscriptions to shared calendars. Polling is explicit.
		deliveryMode: z.enum(["push", "poll"]).default("push"),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (input.adapter === "mcp_events") {
			if (!input.mcpEvents)
				ctx.addIssue({
					code: "custom",
					message: "MCP event subscriptions name an app and event",
					path: ["mcpEvents"],
				});
			if (input.resourceKey !== undefined)
				ctx.addIssue({
					code: "custom",
					message: "Use mcpEvents.eventName as the resource key",
					path: ["resourceKey"],
				});
			if (input.connectionScope !== "tenant")
				ctx.addIssue({
					code: "custom",
					message: "MCP event subscriptions use an organization connection",
					path: ["connectionScope"],
				});
		} else {
			if (!input.resourceKey)
				ctx.addIssue({
					code: "custom",
					message: "Provider subscriptions require a resource key",
					path: ["resourceKey"],
				});
			if (input.mcpEvents)
				ctx.addIssue({
					code: "custom",
					message: "Only mcp_events subscriptions take MCP event settings",
					path: ["mcpEvents"],
				});
		}
		if (input.adapter === "github_webhook") {
			if (
				!input.githubWebhook ||
				!GithubWebhookResourceKeySchema.safeParse(input.resourceKey).success
			)
				ctx.addIssue({
					code: "custom",
					message:
						"GitHub webhooks require owner/repository and event settings",
					path: ["githubWebhook"],
				});
			if (input.deliveryMode !== "push" || input.connectionScope !== "tenant")
				ctx.addIssue({
					code: "custom",
					message:
						"GitHub webhooks use push delivery and an organization connection",
					path: ["deliveryMode"],
				});
		} else if (input.githubWebhook) {
			ctx.addIssue({
				code: "custom",
				message: "Only GitHub webhooks take GitHub settings",
				path: ["githubWebhook"],
			});
		}

		if (input.connectionScope === "user" && !input.personalDelegation)
			ctx.addIssue({
				code: "custom",
				message: "Personal subscriptions require exact owner consent",
				path: ["personalDelegation"],
			});
		if (
			input.connectionScope === "tenant" &&
			(input.personalDelegation || input.resourceDelegationIds?.length)
		)
			ctx.addIssue({
				code: "custom",
				message: "Personal consent is not an organization connection",
				path: ["personalDelegation"],
			});
	});
export const ProviderEventIdSchema = z.object({ id: z.uuid() }).strict();
export const ProviderEventStatusSchema = z.object({
	id: z.uuid(),
	organizationId: z.string(),
	adapter: ProviderEventAdapterSchema,
	providerId: z.string(),
	connectionInstanceId: z.string().nullable(),
	resourceKey: z.string(),
	mcpAppId: z.string().nullable(),
	maxWakesPerHour: z.number().int().nullable(),
	wakeWindowStartedAt: z.string().nullable(),
	wakeWindowCount: z.number().int(),
	connectionScope: z.enum(["tenant", "user"]),
	personalOwnerUserId: z.string().nullable(),
	workspaceId: z.string().nullable(),
	workspaceResourceId: z.string().nullable(),
	delegationId: z.string().nullable(),
	executionToolId: z.string().nullable(),
	resourceDelegationIds: z.array(z.string()),
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
