import { describe, expect, test } from "bun:test";
import {
	LIST_ROW_PROJECTION,
	renderWorkItemsTable,
	workItemHolderLabel,
} from "./work";

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

/**
 * The renderer and the projection are two halves of one feature. The
 * projection runs inside the Code Mode sandbox, and if it drops `activeAttempt`
 * every HOLDER cell reads "—" while the renderer tests above, which feed
 * synthetic rows, still pass. These run the real projection first.
 */
describe("LIST_ROW_PROJECTION", () => {
	const pick = new Function(`return ${LIST_ROW_PROJECTION}`)() as (
		row: Record<string, unknown>,
	) => Record<string, unknown>;

	const board = {
		id: "00785c0e-1111-4111-8111-111111111111",
		workKind: "coding",
		disposition: "accepted",
		riskLevel: "medium",
		priority: "medium",
		title: "a held item",
		projectId: null,
		createdAt: "2026-09-18T12:00:00.000Z",
		description: "x".repeat(4000),
		activeAttempt: {
			attemptId: "5eed0011-0000-4000-8000-000000000011",
			executorType: "external_agent",
			executorId: "5eed0032-0000-4000-8000-000000000032",
			agentSession: "claude-code:25b73c23-7b0a-4f95-b14b-dfc74bb596f7",
			startedAt: "2026-09-18T12:07:18.449Z",
			heartbeatAt: "2026-09-18T12:10:34.600Z",
			expiresAt: "2026-09-18T12:15:34.600Z",
		},
	};

	test("carries the holder through to the renderer", () => {
		const projected = pick(board);
		expect(renderWorkItemsTable([projected], { enabled: false })).toContain(
			"claude-code:25b73c23",
		);
	});

	test("keeps the holder narrow — page size is bounded by this projection", () => {
		const active = pick(board).activeAttempt as Record<string, unknown>;
		expect(Object.keys(active).sort()).toEqual(["agentSession", "executorId"]);
	});

	test("still drops the bulky fields it exists to drop", () => {
		const projected = pick(board);
		expect(projected.description).toBeUndefined();
		expect(JSON.stringify(projected).length).toBeLessThan(400);
	});

	test("an unheld row projects an explicit null", () => {
		expect(
			pick({ ...board, activeAttempt: undefined }).activeAttempt,
		).toBeNull();
	});
});
