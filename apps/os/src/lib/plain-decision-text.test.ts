import { describe, expect, it } from "vite-plus/test";
import {
	plainAskerName,
	plainDecisionSource,
	plainDecisionText,
} from "./plain-decision-text";

describe("plain decision text", () => {
	it("names linked records instead of showing their IDs", () => {
		expect(
			plainDecisionText(
				"Work cbf08453 needs the signed terms before share 57e61f8a can open.",
			),
		).toBe("The linked task needs the signed terms before the share can open.");
	});

	it("drops traces, hashes, actor IDs, machine names and error codes", () => {
		const text = plainDecisionText(
			"The pilot check failed (trace 894b5978-1c2d-4e5f-8a9b-0c1d2e3f4a5b, E151103) external_agent:7e2202f0-ce78-46de-8a49-4505bd534d83 pat@Pats-Laptop.local sha256:9f8e7d6c5b4a39281706f5e4d3c2b1a0.",
		);
		expect(text).toBe("The pilot check failed.");
		expect(text).not.toMatch(/[0-9a-f]{8}|E151103|\.local|sha256/);
	});

	it("keeps code in backticks but hides internal operation names", () => {
		expect(plainDecisionText("Run `shares.update` then `bun run push`.")).toBe(
			"Run the requested change then `bun run push`.",
		);
	});

	it("formats ISO timestamps for people", () => {
		expect(plainDecisionText("Captured 2026-11-04T02:15:00.000Z.")).not.toMatch(
			/T02:15|\.000Z/,
		);
	});

	it("keeps words, numbers and years that only look like hex", () => {
		expect(plainDecisionText("Decide by 2026 for 12 accounts in cafe")).toBe(
			"Decide by 2026 for 12 accounts in cafe",
		);
	});

	it("removes notes agents leave for each other from the source", () => {
		expect(
			plainDecisionSource(
				"The pilot needs the signed terms. Then dispatch this Work to a lane admitted for the Willowbrook org.\n\nSee [the proposal](https://example.com/p).",
			),
		).toBe(
			"The pilot needs the signed terms.\n\nSee [the proposal](https://example.com/p).",
		);
	});

	it("drops sentences built on variable names but keeps product names", () => {
		expect(
			plainDecisionSource(
				'Set guestSkillReadSlots to ["research"]. Use actor_scope=user. Ask u/fable_kettle on the iPhone app.',
			),
		).toBe("Ask u/fable_kettle on the iPhone app.");
	});

	it("drops instructions a person cannot follow", () => {
		expect(
			plainDecisionSource(
				"The logs check needs Cloudflare read access. Please open this Work item and click Reply on this Needs-you card. Provide a current read-only comparison of the source and target counts for every logs table.",
			),
		).toBe("The logs check needs Cloudflare read access.");
	});

	it("names who asked without the transport", () => {
		expect(plainAskerName("Codex session")).toBe("Codex");
		expect(plainAskerName("Local coding agents (pat@Pats-Laptop.local)")).toBe(
			"Local coding agents",
		);
	});
});
