import { describe, expect, test } from "bun:test";
import type { Proposal } from "./learn-context";
import { proposalRequest, publishSource } from "./learn-proposals";

const now = new Date("2026-10-16T12:00:00.000Z");
const proposal: Proposal = {
	key: "setup",
	kind: "task",
	title: "Set up the workspace",
	reason: "Prepare the workspace",
	confidence: 0.9,
	sessions: 2,
	from: "2026-10-01",
	to: "2026-10-15",
	action: "create",
};
const request = (title: string) =>
	proposalRequest({ ...proposal, title }, "Member", "user", undefined, now);

describe("onboarding proposal expiry", () => {
	test("undated actions expire fourteen days after creation, ignoring evidence dates", () => {
		expect(request(proposal.title).expiresAt).toBe("2026-10-30T12:00:00.000Z");
	});
	test("dated actions expire after the named day, including dates beyond fourteen days", () => {
		for (const title of [
			"Prepare for 2026-11-02",
			"Prepare for November 2, 2026",
			"Prepare for Nov 2nd",
			"Prepare for 2 November 2026",
		])
			expect(request(title).expiresAt).toBe("2026-11-03T00:00:00.000Z");
	});
	test("invalid dates do not silently roll into a different month", () => {
		for (const title of [
			"Prepare for 2026-02-30",
			"Prepare for February 30, 2026",
		])
			expect(request(title).expiresAt).toBe("2026-10-30T12:00:00.000Z");
	});
	test("past-dated proposals never create a human request", async () => {
		let created = false;
		const source = publishSource([
			{ key: "past", request: request("Prepare for 2020-01-01") },
		]);
		const run = new Function("work", `return (${source})();`);
		expect(
			await run({
				create_work_interaction: () => {
					created = true;
				},
			}),
		).toEqual({ past: { skipped: "proposal date has passed" } });
		expect(created).toBe(false);
	});
});
