import { describe, expect, it } from "vite-plus/test";
import {
	acceptedDoneEvidence,
	parseObservedRequests,
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
	it("downgrades done without evidence and drops unknown refs", () => {
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
		).toEqual([
			{ ref: "r1", status: "done", evidence: "4f2a9c1e" },
			{ ref: "r2", status: "in_progress", evidence: null },
			{ ref: "r3", status: "waiting_on_user", evidence: "needs a key" },
		]);
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
