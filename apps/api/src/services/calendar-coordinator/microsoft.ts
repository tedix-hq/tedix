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
const root = "https://graph.microsoft.com/v1.0";
const markerId =
	"String {4c0f777d-4588-4f32-a27b-72b1958b5108} Name TedixCoordinator";
type Wire = Record<string, any>;
export function microsoftEvent(raw: Wire): CalendarEvent {
	const bound = (v: Wire) => {
		if (v?.timeZone !== "UTC" && !/Z$|[+-]\d\d:\d\d$/.test(v?.dateTime ?? "")) {
			if (raw.isAllDay)
				return localMidnight(v.dateTime.slice(0, 10), v.timeZone);
			throw new Error("Microsoft did not return UTC time bounds");
		}
		return new Date(
			/Z$|[+-]\d\d:\d\d$/.test(v.dateTime) ? v.dateTime : `${v.dateTime}Z`,
		).toISOString();
	};
	const interval = { start: bound(raw.start), end: bound(raw.end) };
	if (!raw.id || !raw["@odata.etag"] || !validInterval(interval))
		throw new Error("Incomplete Microsoft event revision or bounds");
	if (raw.seriesMasterId && !raw.originalStart)
		throw new Error("Microsoft recurring occurrence lacks original start");
	return {
		id: raw.id,
		revision: raw["@odata.etag"],
		sourceIdentity: raw.seriesMasterId
			? `${raw.seriesMasterId}:${raw.originalStart}`
			: raw.id,
		interval,
		busy: raw.showAs !== "free" && raw.responseStatus?.response !== "declined",
		cancelled: raw.isCancelled === true,
		privateBlocker:
			raw.sensitivity === "private" &&
			raw.showAs === "busy" &&
			raw.isReminderOn === false &&
			!raw.attendees?.length,
		ownership:
			raw.singleValueExtendedProperties?.find((p: Wire) => p.id === markerId)
				?.value ?? null,
	};
}
export function microsoftBlocker(a: Action): Wire {
	if (!a.after) throw new Error("Missing blocker interval");
	return {
		subject: "Busy",
		sensitivity: "private",
		showAs: "busy",
		isReminderOn: false,
		attendees: [],
		body: { contentType: "text", content: "" },
		start: { dateTime: a.after.start, timeZone: "UTC" },
		end: { dateTime: a.after.end, timeZone: "UTC" },
		transactionId: a.ownership,
		singleValueExtendedProperties: [{ id: markerId, value: a.ownership }],
	};
}
export function microsoftNextLink(value: string, expectedPath: string): string {
	const url = new URL(value);
	if (
		url.origin !== "https://graph.microsoft.com" ||
		url.pathname !== expectedPath ||
		url.username ||
		url.password
	)
		throw new Error("Unsafe Microsoft pagination link");
	return url.toString();
}
export function microsoftCalendarAdapter(token: string): CalendarAdapter {
	const path = (r: CalendarRoute) =>
		`${root}/me/calendars/${encodeURIComponent(r.calendarId)}`;
	const read = async (url: string, init?: RequestInit) =>
		(await requestJson(token, url, {
			...init,
			headers: {
				Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"',
				...init?.headers,
			},
		})) as Wire | null;
	const info = (r: Wire): CalendarInfo => ({
		id: r.id,
		name: r.name ?? r.id,
		timeZone: null,
		canRead: true,
		canWrite: r.canEdit === true,
		ownerEmail: r.owner?.address ?? null,
		conditionalWrites: false,
	});
	const snapshot = async (r: CalendarRoute, w: Interval): Promise<Snapshot> => {
		const rawCalendar = await read(path(r));
		if (!rawCalendar)
			throw new Error("Selected Microsoft calendar unavailable");
		const q = new URLSearchParams({
			startDateTime: w.start,
			endDateTime: w.end,
			$top: "1000",
			$expand: `singleValueExtendedProperties($filter=id eq '${markerId}')`,
		});
		let next: string | undefined = `${path(r)}/calendarView?${q}`;
		const events: CalendarEvent[] = [];
		for (let n = 0; n < 100 && next; n++) {
			const raw = await read(next);
			if (!raw || !Array.isArray(raw.value))
				throw new Error("Microsoft snapshot incomplete");
			events.push(...raw.value.map(microsoftEvent));
			next = raw["@odata.nextLink"]
				? microsoftNextLink(
						raw["@odata.nextLink"],
						new URL(`${path(r)}/calendarView`).pathname,
					)
				: undefined;
		}
		if (next)
			throw new Error(
				"Microsoft snapshot exceeds bounded read; cleanup denied",
			);
		return {
			route: r,
			calendar: info(rawCalendar),
			complete: true,
			events,
			errors: [],
		};
	};
	return {
		kind: "microsoft",
		conditionalWrites: false,
		async listCalendars() {
			const result: CalendarInfo[] = [];
			let next: string | undefined = `${root}/me/calendars?$top=100`;
			for (let n = 0; n < 100 && next; n++) {
				const raw = await read(next);
				if (!raw || !Array.isArray(raw.value))
					throw new Error("Microsoft calendar inventory incomplete");
				result.push(...raw.value.map(info));
				next = raw["@odata.nextLink"]
					? microsoftNextLink(raw["@odata.nextLink"], "/v1.0/me/calendars")
					: undefined;
			}
			if (next)
				throw new Error("Microsoft calendar inventory exceeds bounded read");
			return result;
		},
		snapshot,
		async get(r, id) {
			const raw = await read(
				`${path(r)}/events/${encodeURIComponent(id)}?$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${markerId}')`)}`,
			);
			return raw ? microsoftEvent(raw) : null;
		},
		async findOwned(r, marker, w) {
			return (await snapshot(r, w)).events.filter(
				(e) => e.ownership === marker,
			);
		},
		async create(r, a) {
			const raw = await read(`${path(r)}/events`, {
				method: "POST",
				body: JSON.stringify(microsoftBlocker(a)),
			});
			if (!raw) throw new Error("Create returned no event");
			return microsoftEvent(raw);
		},
		async update() {
			throw new Error(
				"Microsoft conditional event updates have not been verified; activation is denied",
			);
		},
		async remove() {
			throw new Error(
				"Microsoft conditional event deletes have not been verified; activation is denied",
			);
		},
	};
}
