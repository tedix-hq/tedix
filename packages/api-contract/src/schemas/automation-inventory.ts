import * as z from "zod";

const count = z.number().int().nonnegative();
const switches = z.object({ enabled: count, disabled: count });
export const AutomationInventoryInputSchema = z
	.object({
		after: z
			.string()
			.min(1)
			.max(200)
			.optional()
			.describe("Organization ID from nextCursor."),
		limit: z.number().int().min(1).max(5).default(1),
	})
	.strict();
export const AutomationInventoryResultSchema = z.object({
	organizations: z.array(
		z.object({
			organizationId: z.string(),
			tediCronJobs: switches,
			osAppTriggers: switches.extend({ disabledSchedules: count }),
			recurringWork: switches,
			commitmentWakesPending: count,
			workDueByKind: z
				.record(z.string(), count)
				.describe("Pending rows by kind; omitted kinds have zero rows."),
			mcpSubscriptions: count,
			factories: z.object({
				healthy: count,
				idle: count,
				paused: count,
				archived: count,
				failing: count,
				not_firing: count,
				pending: count,
			}),
			cmsTenantSites: count,
			disabledSchedules: count,
		}),
	),
	nextCursor: z.string().nullable(),
});
