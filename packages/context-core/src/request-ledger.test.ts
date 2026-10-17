import { describe, expect, it } from "vite-plus/test";
import {
	acceptedDoneEvidence,
	parseObservedRequests,
	parseReflectedMerges,
	parseLedgerMentions,
	parseLedgerLanes,
	requestReflectorInput,
	parseReflectedNewRows,
	parseReflectedUpdates,
	requestObserverInput,
} from "./request-ledger";

const TURN =
	"Pushed the fix as 4f2a9c1e on main. The dashboard now loads in **under two seconds**. See https://example.com/run/42.";

describe("parseObservedRequests", () => {
	it("keeps distinct requests and known cancelled refs", () => {
		const raw = `\`\`\`json
{"requests":[{"kind":"request","text":"  Add a  dark mode toggle "},{"kind":"bogus","text":"Fix the login page"},{"kind":"question","text":"add a dark mode toggle"}],"cancelled":["r1","r9"]}
\`\`\``;
		expect(parseObservedRequests(raw, new Set(["r1"]))).toEqual({
			requests: [
				{ kind: "request", text: "Add a dark mode toggle" },
				{ kind: "request", text: "Fix the login page" },
			],
			cancelled: ["r1"],
			answered: [],
		});
	});

	it("rejects a reply that is not the expected JSON", () => {
		expect(parseObservedRequests("no idea", new Set())).toBeNull();
		expect(parseObservedRequests('{"rows":[]}', new Set())).toBeNull();
	});

	it("names the open rows in the observer input", () => {
		expect(
			requestObserverInput("also ship it", [
				{ ref: "r1", text: "Fix the login page", status: "open" },
			]),
		).toContain("- ref=r1 [open] Fix the login page");
	});
});

describe("acceptedDoneEvidence", () => {
	it("accepts a SHA, a URL or a quote found in the turn", () => {
		expect(acceptedDoneEvidence("commit 4f2a9c1e", TURN)).toBe(
			"commit 4f2a9c1e",
		);
		expect(acceptedDoneEvidence("https://example.com/run/42", TURN)).toBe(
			"https://example.com/run/42",
		);
		expect(
			acceptedDoneEvidence(
				"the dashboard now loads in under two seconds",
				TURN,
			),
		).not.toBeNull();
	});

	it("rejects evidence the turn does not contain", () => {
		expect(acceptedDoneEvidence("commit 9999999a", TURN)).toBeNull();
		expect(acceptedDoneEvidence("Tests pass", TURN)).toBeNull();
		expect(acceptedDoneEvidence("", TURN)).toBeNull();
	});
});

describe("parseReflectedNewRows", () => {
	it("keeps only the agent's promises and open loops", () => {
		expect(
			parseReflectedNewRows(
				JSON.stringify({
					new: [
						{ kind: "promise", text: "Report the deploy result" },
						{ kind: "open_loop", text: "Codex lane on the docs page" },
						{ kind: "request", text: "Not owed by the agent" },
						{ kind: "promise", text: "report the deploy result" },
					],
				}),
			),
		).toEqual([
			{ kind: "promise", text: "Report the deploy result" },
			{ kind: "open_loop", text: "Codex lane on the docs page" },
		]);
		expect(parseReflectedNewRows("nope")).toEqual([]);
	});
});

describe("parseReflectedUpdates", () => {
	it("rejects every unquoted status change and unknown ref", () => {
		const raw = JSON.stringify({
			updates: [
				{ ref: "r1", status: "done", evidence: "4f2a9c1e" },
				{ ref: "r2", status: "done", evidence: "all good" },
				{ ref: "r3", status: "waiting_on_user", evidence: "needs a key" },
				{ ref: "r4", status: "done", evidence: "4f2a9c1e" },
				{ ref: "r3", status: "open" },
			],
		});
		expect(
			parseReflectedUpdates(raw, new Set(["r1", "r2", "r3"]), TURN),
		).toEqual([{ ref: "r1", status: "done", evidence: "4f2a9c1e" }]);
	});
});

it("extracts agent asks from summaries without treating them as promises", () => {
	expect(
		parseReflectedNewRows(
			JSON.stringify({
				new: [{ kind: "ask", text: "Approve the public README wording" }],
			}),
		),
	).toEqual([{ kind: "ask", text: "Approve the public README wording" }]);
});

it("reads the first complete JSON object despite a trailing model brace", () => {
	const answer =
		JSON.stringify({
			requests: [{ kind: "question", text: 'What does "{scope}" mean?' }],
		}) + "}";
	expect(parseObservedRequests(answer, new Set())?.requests).toEqual([
		{ kind: "question", text: 'What does "{scope}" mean?' },
	]);
	expect(parseObservedRequests('{"requests":[', new Set())).toBeNull();
});

it("requires a complete quote rather than an invented claim containing a real SHA", () => {
	expect(
		parseReflectedUpdates(
			JSON.stringify({
				updates: [
					{
						ref: "r1",
						status: "done",
						evidence: "Production verified in 4f2a9c1e",
					},
				],
			}),
			new Set(["r1"]),
			TURN,
		),
	).toEqual([]);
});

it("merges restatements into a canonical row but rejects approval/execution merges and cycles", () => {
	const rows = [
		{
			ref: "r1",
			text: "Publish the README update",
			kind: "request" as const,
			status: "done" as const,
		},
		{
			ref: "r2",
			text: "Ship the updated README",
			kind: "request" as const,
			status: "open" as const,
		},
		{
			ref: "r3",
			text: "Approve the README update",
			kind: "ask" as const,
			status: "waiting_on_user" as const,
		},
	];
	expect(
		parseReflectedMerges(
			JSON.stringify({
				merges: [
					{ ref: "r2", into: "r1", evidence: "Ship the updated README" },
					{ ref: "r3", into: "r1", evidence: "Approve the README update" },
					{ ref: "r1", into: "r2", evidence: "Publish the README update" },
				],
			}),
			rows,
		),
	).toEqual([{ ref: "r2", into: "r1", evidence: "Ship the updated README" }]);
	expect(
		parseReflectedMerges(
			JSON.stringify({
				merges: [
					{ ref: "r2", into: "r2", evidence: "Ship the updated README" },
				],
			}),
			rows,
		),
	).toEqual([]);
});

it("keeps full turn text and accepts only grounded mentions of known refs", () => {
	const turn =
		"Beginning: the pending deployment still needs verification.\n" +
		"middle ".repeat(2000) +
		"\nFinal: continue tomorrow.";
	expect(requestReflectorInput(turn, [])).toContain(turn);
	expect([
		...parseLedgerMentions(
			JSON.stringify({
				mentioned: [
					{
						ref: "r1",
						evidence: "the pending deployment still needs verification",
					},
					{ ref: "r2", evidence: "invented evidence" },
					{
						ref: "unknown",
						evidence: "the pending deployment still needs verification",
					},
				],
			}),
			new Set(["r1", "r2"]),
			turn,
		),
	]).toEqual(["r1"]);
});

it("retains all obligations from a long summary instead of silently cutting off after eight", () => {
	const obligations = Array.from({ length: 16 }, (_, i) => ({
		kind: "ask",
		text: `Approve the specific decision number ${i + 1}`,
	}));
	expect(
		parseReflectedNewRows(JSON.stringify({ new: obligations })),
	).toHaveLength(16);
});

it("accepts lane state only for known rows with quoted evidence", () => {
	const source =
		"The login deployment is running. The docs lane returned with a failure report.";
	expect([
		...parseLedgerLanes(
			JSON.stringify({
				lanes: [
					{
						ref: "r1",
						running: true,
						evidence: "The login deployment is running",
					},
					{
						ref: "r2",
						running: false,
						evidence: "The docs lane returned with a failure report",
					},
					{
						ref: "r3",
						running: false,
						evidence: "No lane is running for this request",
					},
					{
						ref: "unknown",
						running: true,
						evidence: "The login deployment is running",
					},
				],
			}),
			new Set(["r1", "r2", "r3"]),
			source,
		),
	]).toEqual([
		["r1", { running: true, evidence: "The login deployment is running" }],
		[
			"r2",
			{
				running: false,
				evidence: "The docs lane returned with a failure report",
			},
		],
	]);
});

it("accepts a duplicate merge's exact saved result quote", () => {
	const rows = [
		{
			ref: "r1",
			text: "Publish the requested guide",
			status: "done" as const,
			evidence: "The guide was published and read back.",
		},
		{
			ref: "r2",
			text: "Report the published guide result",
			status: "open" as const,
		},
	];
	expect(
		parseReflectedMerges(
			'{"merges":[{"ref":"r2","into":"r1","evidence":"The guide was published and read back."}]}',
			rows,
		),
	).toEqual([
		{
			ref: "r2",
			into: "r1",
			evidence: "The guide was published and read back.",
		},
	]);
});
