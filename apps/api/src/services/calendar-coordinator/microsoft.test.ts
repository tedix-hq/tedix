import { describe, it, expect } from "vite-plus/test";
import {
	microsoftBlocker,
	microsoftCalendarAdapter,
	microsoftEvent,
	microsoftNextLink,
} from "./microsoft";
import type { Action } from "./types";
const action: Action = {
	id: "a",
	kind: "create",
	sourceKey: "s",
	sourceRouteKey: "source",
	sourceEventId: "event",
	sourceRevision: "r",
	destinationKey: "a",
	destinationEventId: "id",
	expectedDestinationRevision: null,
	ownership: "marker",
	before: null,
	after: { start: "2026-10-03T10:00:00Z", end: "2026-10-03T11:00:00Z" },
};
describe("Microsoft calendar adapter", () => {
	it("creates private busy holds with stable transaction ID, no guests or reminder", () => {
		const b = microsoftBlocker(action);
		expect(b.transactionId).toBe("marker");
		expect(b.sensitivity).toBe("private");
		expect(b.showAs).toBe("busy");
		expect(b.isReminderOn).toBe(false);
		expect(b.attendees).toEqual([]);
		expect(b.body.content).toBe("");
	});
	it("fails closed on risky conditional writes until real provider support is verified", async () => {
		const adapter = microsoftCalendarAdapter("token");
		expect(adapter.conditionalWrites).toBe(false);
		await expect(adapter.update({} as any, action)).rejects.toThrow(
			"not been verified",
		);
		await expect(adapter.remove({} as any, action)).rejects.toThrow(
			"not been verified",
		);
	});
	it("rejects bearer exfiltration nextLinks and changed calendar paths", () => {
		expect(() =>
			microsoftNextLink(
				"https://evil.invalid/v1.0/me/calendarView",
				"/v1.0/me/calendarView",
			),
		).toThrow("Unsafe");
		expect(() =>
			microsoftNextLink(
				"https://graph.microsoft.com/v1.0/me/other",
				"/v1.0/me/calendarView",
			),
		).toThrow("Unsafe");
		expect(
			microsoftNextLink(
				"https://graph.microsoft.com/v1.0/me/calendarView?$skip=2",
				"/v1.0/me/calendarView",
			),
		).toContain("$skip=2");
	});
	it("uses original occurrence time, preserves UTC, ignores declined events", () => {
		const raw = {
			id: "immutable",
			"@odata.etag": "revision",
			seriesMasterId: "series",
			originalStart: "2026-10-01T10:00:00Z",
			start: { dateTime: "2026-10-03T10:00:00", timeZone: "UTC" },
			end: { dateTime: "2026-10-03T11:00:00", timeZone: "UTC" },
			responseStatus: { response: "declined" },
		};
		const e = microsoftEvent(raw);
		expect(e.sourceIdentity).toBe("series:2026-10-01T10:00:00Z");
		expect(e.busy).toBe(false);
		expect(e.interval.start).toBe("2026-10-03T10:00:00.000Z");
	});
});
