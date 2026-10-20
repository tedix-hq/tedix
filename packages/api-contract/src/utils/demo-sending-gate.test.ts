import { describe, expect, it } from "vite-plus/test";
import { isCardScheduleField } from "./card-schedule";
import {
	DEMO_SENDING_OFF_MESSAGE,
	demoSendingBlock,
} from "./demo-sending-gate";

describe("demo sending gate", () => {
	it.each([
		["tediEmail/sendEmail", {}],
		["tediEmail/replyEmail", {}],
		["workInteractions/recordDraftDelivery", {}],
		["workInteractions/outbound/submit", {}],
		["workInteractions/outbound/act", { action: "approve_send" }],
		["workInteractions/outbound/act", { action: "approve_manual" }],
	])("blocks %s as sending", (procedure, input) => {
		expect(demoSendingBlock(procedure, input)).toEqual({
			reason: "send",
			message: DEMO_SENDING_OFF_MESSAGE,
		});
	});

	it.each([
		["osWorkspaces/schedules/allowPersonalRead", {}],
		["workInteractions/respond", { scheduledFor: "2026-11-01T09:00:00Z" }],
		[
			"workInteractions/respond",
			{ metadata: { remindAt: "2026-11-01T09:00:00Z" } },
		],
	])("blocks %s as scheduling", (procedure, input) => {
		expect(demoSendingBlock(procedure, input)?.reason).toBe("schedule");
	});

	it.each([
		["workInteractions/outbound/act", { action: "edit" }],
		["workInteractions/outbound/act", { action: "reject" }],
		["workInteractions/outbound/list", {}],
		["osWorkspaces/schedules/list", {}],
		["workInteractions/respond", { body: "Useful" }],
		["workInteractions/listInbox", {}],
	])("lets %s run locally", (procedure, input) => {
		expect(demoSendingBlock(procedure, input)).toBeNull();
	});

	it("recognises the same schedule fields as cards do", () => {
		for (const field of [
			"dueAt",
			"scheduledFor",
			"remind_at",
			"reminderDate",
		]) {
			expect(isCardScheduleField(field)).toBe(true);
			expect(
				demoSendingBlock("workInteractions/respond", {
					[field]: "2030-01-01T09:00:00Z",
				})?.reason,
			).toBe("schedule");
		}
	});

	it("accepts dotted procedure paths", () => {
		expect(
			demoSendingBlock("outbound.act", { action: "approve_send" }),
		).not.toBeNull();
	});
});
