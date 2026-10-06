import { describe, it, expect, vi } from "vite-plus/test";
import {
	microsoftBlocker,
	microsoftCalendarAdapter,
	microsoftEvent,
	microsoftNextLink,
} from "./microsoft";
import { removalConfirmed, type Action } from "./types";
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
	it("uses conditional PATCH for update and private free release, never physical DELETE", async () => {
		const raw = {
			id: "id",
			"@odata.etag": "next",
			start: { dateTime: "2026-10-03T10:00:00Z", timeZone: "UTC" },
			end: { dateTime: "2026-10-03T11:00:00Z", timeZone: "UTC" },
		};
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify(raw)));
		try {
			const adapter = microsoftCalendarAdapter("token");
			const change = {
				...action,
				expectedDestinationRevision: "old",
				before: action.after,
			};
			await adapter.update({ calendarId: "calendar" } as any, change);
			fetcher.mockResolvedValue(new Response(JSON.stringify(raw)));
			await adapter.remove({ calendarId: "calendar" } as any, change);
			for (const call of fetcher.mock.calls) {
				expect(call[1]?.method).toBe("PATCH");
				expect(new Headers(call[1]?.headers).get("If-Match")).toBe("old");
			}
			const body = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
			expect(body).toMatchObject({
				showAs: "free",
				sensitivity: "private",
				isReminderOn: false,
				attendees: [],
			});
			expect(body.singleValueExtendedProperties[0].value).toBe("marker");
			const released = microsoftEvent({ ...raw, ...body });
			expect(removalConfirmed(adapter, released, change)).toBe(true);
			expect(
				removalConfirmed(adapter, { ...released, revision: "old" }, change),
			).toBe(false);
			expect(
				removalConfirmed(adapter, { ...released, ownership: "other" }, change),
			).toBe(false);
			expect(
				removalConfirmed(
					adapter,
					{ ...released, releasedBlocker: false },
					change,
				),
			).toBe(false);
			expect(removalConfirmed(adapter, null, change)).toBe(false);
		} finally {
			fetcher.mockRestore();
		}
	});
	it("propagates a stale conditional PATCH conflict without an unconditional retry", async () => {
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("conflict", { status: 412 }));
		try {
			await expect(
				microsoftCalendarAdapter("token").remove(
					{ calendarId: "calendar" } as any,
					{ ...action, expectedDestinationRevision: "stale" },
				),
			).rejects.toThrow();
			expect(fetcher).toHaveBeenCalledTimes(1);
		} finally {
			fetcher.mockRestore();
		}
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
				"https://graph.microsoft.com/v1.0/me/calendarview?$skip=2",
				"/v1.0/me/calendarView",
			),
		).toContain("calendarview");
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
