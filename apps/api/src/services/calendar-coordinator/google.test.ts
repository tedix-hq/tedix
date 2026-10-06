import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { googleBlocker, googleCalendarAdapter, googleEvent } from "./google";
import type { Action, CalendarRoute } from "./types";
const route: CalendarRoute = {
	key: "a",
	adapter: "google",
	providerId: "p",
	connectionScope: "tenant",
	connectionInstanceId: "slot",
	calendarId: "calendar@test.invalid",
	workspaceResourceId: "resource",
};
const action: Action = {
	id: "a",
	kind: "create",
	sourceKey: "s",
	sourceRouteKey: "source",
	sourceEventId: "event",
	sourceRevision: "r",
	destinationKey: "a",
	destinationEventId: "t123",
	expectedDestinationRevision: '"etag"',
	ownership: "marker",
	before: null,
	after: { start: "2026-10-03T10:00:00Z", end: "2026-10-03T11:00:00Z" },
};
afterEach(() => vi.unstubAllGlobals());
describe("Google calendar adapter", () => {
	it("uses private opaque Busy with no attendees, reminders or information copied", () => {
		expect(googleBlocker(action)).toEqual({
			id: "t123",
			summary: "Busy",
			visibility: "private",
			transparency: "opaque",
			start: { dateTime: action.after!.start },
			end: { dateTime: action.after!.end },
			attendees: [],
			reminders: { useDefault: false },
			extendedProperties: { private: { tedixCoordinator: "marker" } },
		});
	});
	it("keeps original recurring occurrence identity after move", () => {
		const raw = {
			id: "occ",
			etag: "r",
			recurringEventId: "series",
			originalStartTime: { dateTime: "2026-10-01T10:00:00Z" },
			start: { dateTime: action.after!.start },
			end: { dateTime: action.after!.end },
		};
		expect(googleEvent(raw, "UTC").sourceIdentity).toBe(
			"series:2026-10-01T10:00:00Z",
		);
	});
	it("expands recurrence, includes deletions, and follows every bounded page", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					id: route.calendarId,
					summary: "Test",
					accessRole: "owner",
					timeZone: "UTC",
				}),
			)
			.mockResolvedValueOnce(Response.json({ items: [], nextPageToken: "two" }))
			.mockResolvedValueOnce(Response.json({ items: [] }));
		vi.stubGlobal("fetch", fetch);
		const s = await googleCalendarAdapter("secret").snapshot(route, {
			start: "2026-10-01T00:00:00Z",
			end: "2026-10-10T00:00:00Z",
		});
		expect(s.complete).toBe(true);
		expect(fetch.mock.calls[1]![0]).toContain("singleEvents=true");
		expect(fetch.mock.calls[1]![0]).toContain("showDeleted=true");
		expect(fetch.mock.calls[2]![0]).toContain("pageToken=two");
	});
	it("sets If-Match and sendUpdates=none for conditional delete", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetch);
		await googleCalendarAdapter("secret").remove(route, action);
		expect(fetch.mock.calls[0]![0]).toContain("sendUpdates=none");
		expect(fetch.mock.calls[0]![1].headers["If-Match"]).toBe('"etag"');
	});
});

describe("fresh provider authority on pagination", () => {
	it("stops before the next HTTP request when consent expires between pages", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					id: route.calendarId,
					accessRole: "owner",
					timeZone: "UTC",
				}),
			)
			.mockResolvedValueOnce(
				Response.json({ items: [], nextPageToken: "page-two" }),
			);
		vi.stubGlobal("fetch", fetch);
		const authorize = vi
			.fn()
			.mockResolvedValueOnce("fresh-one")
			.mockResolvedValueOnce("fresh-two")
			.mockRejectedValueOnce(new Error("delegation revoked"));
		await expect(
			googleCalendarAdapter("old-token", authorize).snapshot(route, {
				start: "2026-10-01T00:00:00Z",
				end: "2026-10-10T00:00:00Z",
			}),
		).rejects.toThrow("revoked");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[0]![1].headers.Authorization).toBe(
			"Bearer fresh-one",
		);
		expect(fetch.mock.calls[1]![1].headers.Authorization).toBe(
			"Bearer fresh-two",
		);
	});
});
