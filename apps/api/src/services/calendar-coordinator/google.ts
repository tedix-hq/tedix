import {
	localMidnight,
	requestJson,
	validInterval,
	type Action,
	type CalendarAdapter,
	type CalendarEvent,
	type CalendarInfo,
	type CalendarRoute,
	type Interval,
	type Snapshot,
} from "./types";
const root = "https://www.googleapis.com/calendar/v3";
type Wire = Record<string, any>;
export function googleEvent(raw: Wire, timeZone: string): CalendarEvent {
	const boundary = (value: Wire) =>
		value?.dateTime
			? new Date(value.dateTime).toISOString()
			: localMidnight(value.date, value.timeZone ?? timeZone);
	const interval =
		raw.status === "cancelled" && !raw.end
			? { start: "1970-01-01T00:00:00Z", end: "1970-01-01T00:00:01Z" }
			: { start: boundary(raw.start), end: boundary(raw.end) };
	if (!raw.id || !raw.etag || !validInterval(interval))
		throw new Error("Incomplete Google event revision or time bounds");
	return {
		id: raw.id,
		revision: raw.etag,
		sourceIdentity: raw.recurringEventId
			? `${raw.recurringEventId}:${
					raw.originalStartTime?.dateTime ??
					raw.originalStartTime?.date ??
					(() => {
						throw new Error("Recurring event lacks original occurrence");
					})()
				}`
			: raw.id,
		interval,
		busy:
			raw.transparency !== "transparent" &&
			!raw.attendees?.some(
				(a: Wire) => a.self && a.responseStatus === "declined",
			),
		cancelled: raw.status === "cancelled",
		privateBlocker:
			raw.visibility === "private" &&
			raw.transparency === "opaque" &&
			!raw.attendees?.length &&
			raw.reminders?.useDefault === false &&
			!raw.reminders?.overrides?.length,
		ownership: raw.extendedProperties?.private?.tedixCoordinator ?? null,
	};
}
export function googleBlocker(action: Action): Wire {
	if (!action.after) throw new Error("Missing blocker interval");
	return {
		id: action.destinationEventId,
		summary: "Busy",
		visibility: "private",
		transparency: "opaque",
		start: { dateTime: action.after.start },
		end: { dateTime: action.after.end },
		attendees: [],
		reminders: { useDefault: false },
		extendedProperties: { private: { tedixCoordinator: action.ownership } },
	};
}
export function googleCalendarAdapter(
	token: string,
	authorize?: () => Promise<string>,
): CalendarAdapter {
	const path = (r: CalendarRoute) =>
		`${root}/calendars/${encodeURIComponent(r.calendarId)}/events`;
	const read = async (url: string, init?: RequestInit) =>
		(await requestJson(
			authorize ? await authorize() : token,
			url,
			init,
		)) as Wire | null;
	const getCalendar = async (id: string): Promise<CalendarInfo> => {
		const raw = await read(
			`${root}/users/me/calendarList/${encodeURIComponent(id)}`,
		);
		if (!raw) throw new Error("Selected Google calendar is unavailable");
		return {
			id: raw.id,
			name: raw.summary ?? raw.id,
			timeZone: raw.timeZone ?? "UTC",
			canRead: ["reader", "writer", "owner"].includes(raw.accessRole),
			canWrite: ["writer", "owner"].includes(raw.accessRole),
			ownerEmail: raw.primary ? raw.id : null,
			conditionalWrites: true,
		};
	};
	const snapshot = async (
		route: CalendarRoute,
		window: Interval,
	): Promise<Snapshot> => {
		const calendar = await getCalendar(route.calendarId);
		const events: CalendarEvent[] = [];
		let page: string | undefined;
		for (let n = 0; n < 100; n++) {
			const q = new URLSearchParams({
				timeMin: window.start,
				timeMax: window.end,
				singleEvents: "true",
				showDeleted: "true",
				maxResults: "2500",
			});
			if (page) q.set("pageToken", page);
			const raw = await read(`${path(route)}?${q}`);
			if (!raw || !Array.isArray(raw.items))
				throw new Error("Google snapshot is incomplete");
			for (const item of raw.items)
				events.push(googleEvent(item, calendar.timeZone ?? "UTC"));
			page = raw.nextPageToken;
			if (!page) return { route, calendar, events, complete: true, errors: [] };
		}
		throw new Error(
			"Google snapshot pagination exceeded the bounded read; no cleanup permitted",
		);
	};
	return {
		kind: "google",
		conditionalWrites: true,
		async listCalendars() {
			const result: CalendarInfo[] = [];
			let page: string | undefined;
			for (let n = 0; n < 100; n++) {
				const raw = await read(
					`${root}/users/me/calendarList?maxResults=250${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
				);
				if (!raw || !Array.isArray(raw.items))
					throw new Error("Google calendar inventory incomplete");
				for (const r of raw.items)
					result.push({
						id: r.id,
						name: r.summary ?? r.id,
						timeZone: r.timeZone ?? "UTC",
						canRead: ["reader", "writer", "owner"].includes(r.accessRole),
						canWrite: ["writer", "owner"].includes(r.accessRole),
						ownerEmail: r.primary ? r.id : null,
						conditionalWrites: true,
					});
				page = raw.nextPageToken;
				if (!page) return result;
			}
			throw new Error("Google calendar inventory exceeds bounded read");
		},
		snapshot,
		async get(r, id) {
			const raw = await read(`${path(r)}/${encodeURIComponent(id)}`);
			return raw
				? googleEvent(raw, (await getCalendar(r.calendarId)).timeZone ?? "UTC")
				: null;
		},
		async findOwned(r, marker, window) {
			const s = await snapshot(r, window);
			return s.events.filter((e) => e.ownership === marker);
		},
		async create(r, a) {
			const raw = await read(`${path(r)}?sendUpdates=none`, {
				method: "POST",
				body: JSON.stringify(googleBlocker(a)),
			});
			if (!raw) throw new Error("Create returned no event");
			return googleEvent(raw, "UTC");
		},
		async update(r, a) {
			if (!a.expectedDestinationRevision)
				throw new Error("Update requires exact destination revision");
			const body = googleBlocker(a);
			delete body.id;
			const raw = await read(
				`${path(r)}/${encodeURIComponent(a.destinationEventId)}?sendUpdates=none`,
				{
					method: "PATCH",
					headers: { "If-Match": a.expectedDestinationRevision },
					body: JSON.stringify(body),
				},
			);
			if (!raw) throw new Error("Update returned no event");
			return googleEvent(raw, "UTC");
		},
		async remove(r, a) {
			if (!a.expectedDestinationRevision)
				throw new Error("Delete requires exact destination revision");
			await read(
				`${path(r)}/${encodeURIComponent(a.destinationEventId)}?sendUpdates=none`,
				{
					method: "DELETE",
					headers: { "If-Match": a.expectedDestinationRevision },
				},
			);
		},
	};
}
