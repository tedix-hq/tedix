import { describe, expect, it } from "vite-plus/test";
import { groundedRosterDecision } from "./grounded-roster";

const tedis = [
	{ id: "1", slug: "cto", name: "CTO", role: "Technology", status: "active" },
	{ id: "2", slug: "cfo", name: "CFO", role: "Finance", status: "ready" },
	{ id: "3", slug: "ops", name: "Ops", role: "Operations", status: "active" },
	{ id: "4", slug: "old", name: "Old", role: "Archive", status: "archived" },
];

describe("groundedRosterDecision", () => {
	it("answers an exact bounded roster request from live Home context", () => {
		const route = groundedRosterDecision("List exactly 2 active tedis", {
			tedis,
		});
		expect(route?.routeKind).toBe("answer_in_home");
		expect(route?.answer).toBe("- CTO — Technology\n- CFO — Finance");
		expect(route?.effortClass).toBe("single_read");
	});

	it("excludes inactive tedis", () => {
		const route = groundedRosterDecision("Show the active tedis", { tedis });
		expect(route?.answer).not.toContain("Old");
	});

	it("does not intercept explicit delegation", () => {
		expect(
			groundedRosterDecision(
				"Delegate to CTO and ask which active tedis can help",
				{
					tedis,
				},
			),
		).toBeNull();
	});

	it("does not become a general heuristic responder", () => {
		expect(
			groundedRosterDecision("Summarize this quarter", { tedis }),
		).toBeNull();
	});
});
