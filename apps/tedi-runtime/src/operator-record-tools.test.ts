import type { Tool } from "ai";
import assert from "node:assert/strict";
import { operatorRecordTools } from "./operator-record-tools";

const trace: string[] = [];
let admitted = true;
const api = {
	async fetch(request: Request) {
		trace.push("authorize");
		assert.equal(request.headers.get("X-Tedix-Tedi-Id"), "tedi");
		assert.equal(request.headers.get("X-Tedix-Organization-Id"), "org");
		const body = (await request.json()) as { json: Record<string, unknown> };
		assert.equal(body.json.homeRunId, "home");
		assert.equal(body.json.runId, "child");
		assert.equal(body.json.userId, undefined);
		return admitted
			? Response.json({ json: { source: body.json.source, text: "admitted" } })
			: Response.json(
					{
						json: {
							defined: false,
							code: "FORBIDDEN",
							message: "No active member delegation",
						},
					},
					{ status: 403 },
				);
	},
};
const tools = operatorRecordTools({
	env: { API_URL: "https://api.example", API_SERVICE: api } as unknown as Pick<
		Cloudflare.Env,
		"API_URL" | "API_SERVICE"
	>,
	tediId: "tedi",
	organizationId: "org",
	homeRunId: "home",
	runId: "child",
	workItemId: "work",
	executeMcp: async (name, args) => {
		if (name === "tedix_mcp_search_tools") {
			trace.push("discovery");
			return {
				result: [
					{
						callable: "google_calendar_example.list_events",
						authorized: true,
						annotations: { readOnlyHint: true },
					},
				],
			};
		}
		trace.push("provider");
		return JSON.stringify(args);
	},
});
const options = { toolCallId: "call", messages: [], context: undefined };
const calendar = tools.read_operator_calendar! as Tool<
	{ timeMin: string; timeMax: string },
	unknown
>;
assert.ok(calendar.execute);
const args = {
	timeMin: "2026-10-24T00:00:00Z",
	timeMax: "2026-10-26T00:00:00Z",
};
const code = await calendar.execute(args, options);
assert.deepEqual(trace, ["authorize", "discovery", "provider"]);
assert.match(String(code), /google_calendar_example.list_events/);
assert.match(String(code), /"calendarId":"primary"/);
trace.length = 0;
admitted = false;
await assert.rejects(async () => {
	await calendar.execute!(args, options);
});
assert.deepEqual(
	trace,
	["authorize"],
	"a denied member delegation never reaches provider credentials",
);
trace.length = 0;
await assert.rejects(async () => {
	await calendar.execute!(
		{ ...args, timeMax: "2027-01-01T00:00:00Z" },
		options,
	);
}, /at most 31 days/);
assert.deepEqual(trace, []);
console.log(
	"operator-record-tools authorization and provider-read boundary passed",
);
