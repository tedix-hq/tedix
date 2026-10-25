import * as z from "zod";
import type { DelegationCapabilityPlan } from "./kernel-runtime";

export const OPERATOR_RECORD_TOOLS = [
	"read_operator_records",
	"read_home_messages",
	"memory_search",
	"read_operator_calendar",
	"read_operator_mail",
] as const;

/** A request ceiling; the API separately verifies the persisted member admission. */
export function hasOperatorRecordPlan(
	plan?: DelegationCapabilityPlan,
): boolean {
	return Boolean(
		plan?.requiredCapabilities.includes("operator.records.read") &&
		plan.missingCapabilities.length === 0 &&
		plan.allowedToolIds.length > 0 &&
		plan.allowedToolIds.every((id) =>
			OPERATOR_RECORD_TOOLS.includes(
				id as (typeof OPERATOR_RECORD_TOOLS)[number],
			),
		),
	);
}

export const ReadOperatorRecordsInputSchema = z.object({
	tediId: z.string().min(1),
	runId: z.string().min(1),
	homeRunId: z.string().min(1),
	workItemId: z.string().min(1),
	source: z.enum(["work", "home", "memory", "calendar", "mail"]),
	conversationId: z.string().min(1).max(256).optional(),
	query: z.string().max(500).optional(),
});
export const ReadOperatorRecordsOutputSchema = z.object({
	source: z.enum(["work", "home", "memory", "calendar", "mail"]),
	text: z.string(),
});
