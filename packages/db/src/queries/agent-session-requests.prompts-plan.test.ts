import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { getAgentSessionRequestPrompts } from "./agent-session-requests";

const ORG = "org-example";
const USER = "user-ada";
const STATUSES = ["pending", "processed", "failed"] as const;

type EventRow = {
	organizationId: string;
	userId: string;
	harness: string;
	sessionKey: string;
	kind: "prompt" | "turn";
	status: (typeof STATUSES)[number];
	sourceAt: string;
	sourceKey: string;
	body: string;
};
type RequestRow = {
	id: string;
	organizationId: string;
	userId: string;
	harness: string;
	sessionKey: string;
	sourceAt: string;
};

const at = (minute: number) =>
	`2026-11-09T${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;

/** One owner with many sessions, as on the day the old statement read 74k rows per call. */
function fixture(statistics: boolean) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const events: EventRow[] = [];
	const requests: RequestRow[] = [];
	const event = (
		row: Omit<EventRow, "sourceKey" | "body"> & { key?: string },
	) =>
		events.push({
			...row,
			sourceKey: row.key ?? `event-${String(events.length).padStart(5, "0")}`,
			body: `body ${events.length}`,
		});
	const request = (row: Omit<RequestRow, "id">) =>
		requests.push({ ...row, id: `request-${requests.length}` });
	const own = { organizationId: ORG, userId: USER, harness: "claude-code" };

	// Twenty busy sessions of the same owner: a prompt, then three turns, each
	// minute; statuses vary so every status holds the newest prompt somewhere.
	for (let session = 0; session < 20; session++) {
		const sessionKey = `session-${session}`;
		for (let minute = 0; minute < 40; minute++) {
			event({
				...own,
				sessionKey,
				kind: minute % 4 === 0 ? "prompt" : "turn",
				status:
					STATUSES[(session + minute) % 7 === 0 ? 2 : minute > 32 ? 0 : 1],
				sourceAt: at(minute),
			});
		}
		// A request sent with a prompt, one recorded between two prompts and one
		// from before the session's first prompt.
		request({ ...own, sessionKey, sourceAt: at(8) });
		request({ ...own, sessionKey, sourceAt: at(38) });
		request({ ...own, sessionKey, sourceAt: "2026-11-09T09:00:00.000Z" });
	}
	// Two prompts and a turn at the same time: the highest key wins, whatever
	// the status of each.
	for (const [key, kind, status] of [
		["tie-a", "prompt", "processed"],
		["tie-c", "prompt", "failed"],
		["tie-b", "prompt", "pending"],
		["tie-z", "turn", "processed"],
	] as const)
		event({
			...own,
			sessionKey: "session-tie",
			kind,
			status,
			sourceAt: at(5),
			key,
		});
	request({ ...own, sessionKey: "session-tie", sourceAt: at(5) });
	request({ ...own, sessionKey: "session-tie", sourceAt: at(30) });
	// Only turns: there is no prompt to recover.
	event({
		...own,
		sessionKey: "session-turns",
		kind: "turn",
		status: "processed",
		sourceAt: at(1),
	});
	request({ ...own, sessionKey: "session-turns", sourceAt: at(2) });
	// The same session key under another harness, owner and organization.
	for (const other of [
		{ ...own, harness: "codex" },
		{ ...own, userId: "user-grace" },
		{ ...own, organizationId: "org-other" },
	]) {
		event({
			...other,
			sessionKey: "session-0",
			kind: "prompt",
			status: "processed",
			sourceAt: at(9),
		});
		request({ ...other, sessionKey: "session-0", sourceAt: at(10) });
	}

	const insertEvent = sqlite.prepare(
		"INSERT INTO agent_session_events (id, organization_id, user_id, harness, session_key, kind, body, source_at, source_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	for (const [index, row] of events.entries())
		insertEvent.run(
			`event-id-${index}`,
			row.organizationId,
			row.userId,
			row.harness,
			row.sessionKey,
			row.kind,
			row.body,
			row.sourceAt,
			row.sourceKey,
			row.status,
		);
	const insertRequest = sqlite.prepare(
		"INSERT INTO agent_session_requests (id, organization_id, user_id, harness, session_key, kind, text, status, source_at, source_key, status_changed_at) VALUES (?, ?, ?, ?, ?, 'request', 'Example', 'open', ?, ?, ?)",
	);
	for (const row of requests)
		insertRequest.run(
			row.id,
			row.organizationId,
			row.userId,
			row.harness,
			row.sessionKey,
			row.sourceAt,
			row.id,
			row.sourceAt,
		);
	if (statistics) sqlite.exec("ANALYZE; ANALYZE sqlite_schema;");

	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes('"agent_session_events"'))
					plans.push(
						sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail))
							.join(" | "),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	return { db, plans, events, requests };
}

/** The rule the single statement expressed: newest prompt at or before the request, highest key on a tie. */
function expectedPrompt(request: RequestRow, events: readonly EventRow[]) {
	const prompts = events
		.filter(
			(event) =>
				event.organizationId === request.organizationId &&
				event.userId === request.userId &&
				event.harness === request.harness &&
				event.sessionKey === request.sessionKey &&
				event.kind === "prompt" &&
				event.sourceAt <= request.sourceAt,
		)
		.sort(
			(a, b) =>
				b.sourceAt.localeCompare(a.sourceAt) ||
				b.sourceKey.localeCompare(a.sourceKey),
		);
	return prompts[0]?.body ?? null;
}

describe.each([
	{ statistics: "no statistics", analysed: false },
	{ statistics: "statistics", analysed: true },
])("original prompts of session requests with $statistics", ({ analysed }) => {
	it("returns the same prompt as before for every request of the owner", async () => {
		const { db, events, requests } = fixture(analysed);
		const own = requests.filter(
			(row) => row.organizationId === ORG && row.userId === USER,
		);
		// More than one statement's worth of ids, plus rows of another owner.
		expect(own.length).toBeGreaterThan(50);
		const prompts = await getAgentSessionRequestPrompts(db, {
			organizationId: ORG,
			userId: USER,
			ids: requests.map((row) => row.id),
		});
		expect(
			Object.fromEntries(prompts.map((row) => [row.id, row.message])),
		).toEqual(
			Object.fromEntries(
				own.map((row) => [row.id, expectedPrompt(row, events)]),
			),
		);
		const byId = new Map(prompts.map((row) => [row.id, row.message]));
		const tie = events.find((event) => event.sourceKey === "tie-c")!;
		const [sameTime, later, noPrompt] = requests.filter(
			(row) =>
				row.userId === USER &&
				row.organizationId === ORG &&
				row.harness === "claude-code" &&
				(row.sessionKey === "session-tie" ||
					row.sessionKey === "session-turns"),
		);
		expect(byId.get(sameTime!.id)).toBe(tie.body);
		expect(byId.get(later!.id)).toBe(tie.body);
		expect(byId.get(noPrompt!.id)).toBeNull();
	});

	it("seeks each session's prompt time by status and reads the body at that time", async () => {
		const { db, plans, requests } = fixture(analysed);
		await getAgentSessionRequestPrompts(db, {
			organizationId: ORG,
			userId: USER,
			ids: requests.slice(0, 8).map((row) => row.id),
		});
		// The requests by id; one seek per event status, bounded by the session
		// and stopping at the first prompt; the body at one exact time. The only
		// sort orders the prompts sharing that time by key.
		const SESSION =
			"USING INDEX idx_agent_session_events_session_order (organization_id=? AND user_id=? AND harness=? AND session_key=? AND status=?";
		expect(plans).toEqual([
			[
				"SEARCH agent_session_requests USING INDEX sqlite_autoindex_agent_session_requests_1 (id=?)",
				"CORRELATED SCALAR SUBQUERY 4",
				`SEARCH agent_session_events ${SESSION} AND source_at=?)`,
				...STATUSES.flatMap((_, index) => [
					`CORRELATED SCALAR SUBQUERY ${index + 1}`,
					`SEARCH request_prompt_time_event ${SESSION} AND source_at<?)`,
				]),
				"USE TEMP B-TREE FOR ORDER BY",
			].join(" | "),
		]);
	});
});
