/**
 * Sample-data demos (the fixture OS and `bun run-local --demo`) never leave the
 * machine. This is the single decision table for what counts as sending or
 * scheduling; the fixture server and the API both call it at the action layer.
 */
export const DEMO_SENDING_OFF_MESSAGE =
	"Sending is switched off in this sample-data demo. Nothing was sent or scheduled.";

export type DemoSendingBlock = {
	reason: "send" | "schedule";
	message: string;
};

const SEND_PROCEDURES = new Set([
	"sendEmail",
	"replyEmail",
	"recordDraftDelivery",
	"ackDelivery",
]);
const OUTBOUND_WRITES = new Set([
	"submit",
	"configure",
	"importSentStyle",
	"requestReview",
]);
const OUTBOUND_SEND_ACTIONS = new Set(["approve_send", "approve_manual"]);

// The reminder and due-date field names of `card-schedule.ts`. This module stays
// import-free so the Vite config can load it natively in the fixture lane.
const SCHEDULE_FIELDS = new Set([
	"due",
	"dueat",
	"duedate",
	"scheduled",
	"scheduledat",
	"scheduledfor",
	"scheduleddate",
	"remindat",
	"reminderat",
	"reminderdate",
]);

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const hasScheduleDate = (value: Record<string, unknown>): boolean =>
	Object.entries(value).some(
		([name, date]) =>
			SCHEDULE_FIELDS.has(name.replace(/[\s_-]/g, "").toLowerCase()) &&
			typeof date === "string" &&
			Number.isFinite(Date.parse(date)),
	);

/**
 * `procedure` is the router path joined with "/" (`workInteractions/outbound/act`).
 * Returns null for anything the demo may run, including review, editing and
 * feedback on drafts, which stay local.
 */
export function demoSendingBlock(
	procedure: string,
	input: unknown,
): DemoSendingBlock | null {
	const parts = procedure.split(/[/.]/).filter(Boolean);
	const leaf = parts.at(-1) ?? "";
	const block = (reason: DemoSendingBlock["reason"]): DemoSendingBlock => ({
		reason,
		message: DEMO_SENDING_OFF_MESSAGE,
	});
	if (SEND_PROCEDURES.has(leaf)) return block("send");
	if (parts.includes("outbound")) {
		if (OUTBOUND_WRITES.has(leaf)) return block("send");
		if (
			leaf === "act" &&
			OUTBOUND_SEND_ACTIONS.has(String(object(input).action))
		)
			return block("send");
	}
	if (parts.includes("schedules") && leaf !== "list") return block("schedule");
	if (leaf === "respond" || leaf === "create") {
		const body = object(input);
		if (
			hasScheduleDate(body) ||
			(leaf === "respond" && hasScheduleDate(object(body.metadata)))
		)
			return block("schedule");
	}
	return null;
}
