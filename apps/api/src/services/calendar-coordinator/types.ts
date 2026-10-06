/** Calendar data deliberately excludes titles, attendees, bodies and booking links. */
export type AdapterKind = "google" | "microsoft";
export type Interval = { start: string; end: string };
export type CalendarRoute = {
	key: string;
	adapter: AdapterKind;
	providerId: string;
	connectionScope: "tenant" | "user";
	connectionInstanceId: string;
	deliveryMode?: "push" | "poll";
	delegationId?: string;
	calendarId: string;
	workspaceResourceId: string;
};
export type CalendarInfo = {
	id: string;
	name: string;
	timeZone: string | null;
	canRead: boolean;
	canWrite: boolean;
	ownerEmail: string | null;
	conditionalWrites: boolean;
};
export type CalendarEvent = {
	id: string;
	revision: string;
	sourceIdentity: string;
	interval: Interval;
	busy: boolean;
	cancelled: boolean;
	ownership: string | null;
	privateBlocker: boolean;
};
export type Snapshot = {
	route: CalendarRoute;
	complete: boolean;
	events: CalendarEvent[];
	calendar: CalendarInfo;
	errors: string[];
};
export type Mirror = {
	id: string;
	sourceKey: string;
	sourceRouteKey: string;
	sourceEventId: string;
	destinationKey: string;
	eventId: string;
	revision: string;
	ownership: string;
	interval: Interval;
};
export type Action = {
	id: string;
	kind: "create" | "update" | "delete";
	sourceKey: string;
	sourceRouteKey: string;
	sourceEventId: string;
	sourceRevision: string | null;
	destinationKey: string;
	destinationEventId: string;
	expectedDestinationRevision: string | null;
	ownership: string;
	before: Interval | null;
	after: Interval | null;
	compensatesActionId?: string;
	deleteReason?: "cancelled_or_free" | "moved_outside_window";
	expectedSourceInterval?: Interval;
};
export type Plan = {
	id: string;
	configurationId: string;
	configurationRevision: number;
	purpose: "reconcile" | "compensate";
	originalPlanId?: string;
	window: Interval;
	complete: boolean;
	createdAt: string;
	actions: Action[];
	conflicts: string[];
	/** Snapshot revisions fence the whole preview, including newly created conflicts. */
	snapshotFingerprints: Record<string, string>;
};
export type Configuration = {
	id: string;
	workspaceId: string;
	organizationId: string;
	ownerUserId: string;
	revision: number;
	mode: "preview" | "active";
	windowMode?: "rolling" | "fixed";
	rollingDays?: number;
	timeZone: string;
	window: Interval;
	tediId: string;
	skillId: string;
	skillRevision: number;
	subscriptionIds?: string[];
	calendars: CalendarRoute[];
	actions: Action["kind"][];
};
export type Mutation = {
	actionId: string;
	compensationEligible?: boolean;
	state: "intent" | "confirmed" | "uncertain" | "conflict";
	eventId: string;
	revision: string | null;
	error: string | null;
};
export type Receipt = {
	planId: string;
	outcome: "confirmed" | "partial" | "conflict";
	mutations: Mutation[];
};
export interface CalendarAdapter {
	readonly kind: AdapterKind;
	readonly conditionalWrites: boolean;
	listCalendars(): Promise<CalendarInfo[]>;
	snapshot(route: CalendarRoute, window: Interval): Promise<Snapshot>;
	get(route: CalendarRoute, eventId: string): Promise<CalendarEvent | null>;
	findOwned(
		route: CalendarRoute,
		ownership: string,
		window: Interval,
	): Promise<CalendarEvent[]>;
	create(route: CalendarRoute, action: Action): Promise<CalendarEvent>;
	update(route: CalendarRoute, action: Action): Promise<CalendarEvent>;
	remove(route: CalendarRoute, action: Action): Promise<void>;
}
export async function digest(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(bytes), (n) =>
		n.toString(16).padStart(2, "0"),
	).join("");
}
export function validInterval(interval: Interval): boolean {
	return (
		Number.isFinite(Date.parse(interval.start)) &&
		Date.parse(interval.start) < Date.parse(interval.end)
	);
}
export function sameInterval(a: Interval, b: Interval): boolean {
	return (
		Date.parse(a.start) === Date.parse(b.start) &&
		Date.parse(a.end) === Date.parse(b.end)
	);
}
export function owned(event: CalendarEvent, marker: string): boolean {
	return (
		event.ownership === marker &&
		event.busy &&
		!event.cancelled &&
		event.privateBlocker
	);
}
/** No arbitrary next-link origin may receive the account's bearer token. */
export async function requestJson(
	token: string,
	url: string,
	init: RequestInit = {},
): Promise<Record<string, unknown> | null> {
	const response = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(15_000),
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...init.headers,
		},
	});
	if (response.status === 404 || response.status === 410) return null;
	if (!response.ok)
		throw new Error(`Calendar request failed (${response.status})`);
	if (response.status === 204) return {};
	return (await response.json()) as Record<string, unknown>;
}
/** Resolve midnight in an IANA zone without assuming a day is 24 hours. Reject nonexistent midnight. */
export function localMidnight(date: string, timeZone: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
		throw new Error("Invalid all-day date");
	const target = Date.parse(`${date}T00:00:00Z`);
	const format = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	let candidate = target;
	for (let n = 0; n < 5; n++) {
		const parts = Object.fromEntries(
			format.formatToParts(candidate).map((p) => [p.type, p.value]),
		);
		const local = Date.parse(
			`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
		);
		if (local === target) return new Date(candidate).toISOString();
		candidate += target - local;
	}
	throw new Error("All-day boundary cannot be resolved in calendar time zone");
}
function dateInZone(value: Date, timeZone: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
			.formatToParts(value)
			.map((p) => [p.type, p.value]),
	);
	return `${parts.year}-${parts.month}-${parts.day}`;
}
/** Calendar days, rather than elapsed 24h chunks, preserve the approved horizon across DST. */
export function approvedRollingDays(
	window: Interval,
	timeZone: string,
): number {
	const days =
		(Date.parse(`${dateInZone(new Date(window.end), timeZone)}T00:00:00Z`) -
			Date.parse(`${dateInZone(new Date(window.start), timeZone)}T00:00:00Z`)) /
		86400_000;
	const result = Math.max(1, days);
	if (!Number.isInteger(result) || result > 90)
		throw new Error(
			"Rolling calendar horizon must be between 1 and 90 local days",
		);
	return result;
}
export function effectiveCalendarConfiguration(
	config: Configuration,
	now = new Date(),
): Configuration {
	if (config.windowMode === "fixed") return config;
	const days =
		config.rollingDays ?? approvedRollingDays(config.window, config.timeZone);
	if (!Number.isInteger(days) || days < 1 || days > 90)
		throw new Error("Invalid approved rolling horizon");
	const today = dateInZone(now, config.timeZone);
	const end = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400_000)
		.toISOString()
		.slice(0, 10);
	return {
		...config,
		window: {
			start: localMidnight(today, config.timeZone),
			end: localMidnight(end, config.timeZone),
		},
	};
}
