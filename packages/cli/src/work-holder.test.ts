import { describe, expect, test } from "bun:test";
import { renderWorkItemsTable, workItemHolderLabel } from "./work";

/**
 * `work list` used to print ID, KIND, DISPOSITION, RISK, PRI and TITLE — every
 * one of them a property of the record, none of them the question a second
 * agent arrives with, which is "is anybody in this right now". Finding that out
 * cost one `work attempts <id>` call per row, so nobody did it.
 */
describe("workItemHolderLabel", () => {
	test("keeps the harness prefix and clips the uuid", () => {
		expect(
			workItemHolderLabel({
				agentSession: "codex:01a0b1ad-b41d-7b22-acfd-61bba4daa3af",
				executorId: "agent:5eed0032",
			}),
		).toBe("codex:01a0b1ad");
		expect(
			workItemHolderLabel({
				agentSession: "claude-code:e477883d-1312-447b-b9eb-94791881f794",
				executorId: "agent:5eed0032",
			}),
		).toBe("claude-code:e477883d");
	});

	test("falls back to the executor when there is no session key", () => {
		expect(
			workItemHolderLabel({ agentSession: null, executorId: "tedi-cto" }),
		).toBe("tedi-cto");
	});

	test("renders an em dash when nobody holds it", () => {
		expect(workItemHolderLabel(null)).toBe("—");
		expect(workItemHolderLabel(undefined)).toBe("—");
	});

	test("never returns empty, so a column cannot silently vanish", () => {
		expect(workItemHolderLabel({})).toBe("held");
		expect(workItemHolderLabel({ agentSession: "", executorId: "" })).toBe(
			"held",
		);
	});

	test("survives a session key with no colon", () => {
		const label = workItemHolderLabel({ agentSession: "bare-session-key" });
		expect(label.length).toBeGreaterThan(0);
		expect(label.length).toBeLessThanOrEqual(22);
	});
});

describe("renderWorkItemsTable", () => {
	const row = {
		id: "5eed0036-0000-4000-8000-000000000036",
		workKind: "coding",
		disposition: "accepted",
		riskLevel: "medium",
		priority: "medium",
		title: "Give work list the executor and live-attempt state it omits",
	};

	test("shows HOLDER instead of PRI", () => {
		const table = renderWorkItemsTable([row], { enabled: false });
		expect(table).toContain("HOLDER");
		expect(table).not.toContain("PRI ");
	});

	test("names the holder when one exists", () => {
		const table = renderWorkItemsTable(
			[
				{
					...row,
					activeAttempt: {
						agentSession: "codex:01a0b1ad-b41d-7b22-acfd-61bba4daa3af",
						executorId: "agent:5eed0032",
					},
				},
			],
			{ enabled: false },
		);
		expect(table).toContain("codex:01a0b1ad");
	});

	test("an unheld row reads as unheld rather than blank", () => {
		const table = renderWorkItemsTable([{ ...row, activeAttempt: null }], {
			enabled: false,
		});
		expect(table).toContain("—");
	});

	test("tolerates a server that does not report holders at all", () => {
		// Field absent, not null: an older gateway. Must not throw or print
		// "undefined".
		const table = renderWorkItemsTable([row], { enabled: false });
		expect(table).not.toContain("undefined");
		expect(table).toContain(row.title.slice(0, 20));
	});
});
