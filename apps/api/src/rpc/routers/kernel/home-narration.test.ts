import { describe, expect, it } from "vite-plus/test";
import {
	collapseHomeDelegationNarration,
	homeNarrationMetadata,
	readHomeNarrationClass,
} from "./home-narration";

type Row = { id: string; childRunId: string | null; payload: unknown };

function row(input: {
	id: string;
	childRunId?: string | null;
	narration?:
		| "delegation_ack"
		| "delegation_status_only"
		| "turn_canceled_delegated";
	metadata?: Record<string, unknown>;
}): Row {
	return {
		id: input.id,
		childRunId: input.childRunId ?? null,
		payload: {
			role: "assistant",
			content: "…",
			metadata: {
				...input.metadata,
				...(input.narration ? homeNarrationMetadata(input.narration) : {}),
			},
		},
	};
}

describe("readHomeNarrationClass", () => {
	it("reads a stamped class off the event payload", () => {
		expect(
			readHomeNarrationClass(
				row({ id: "a", narration: "delegation_ack" }).payload,
			),
		).toBe("delegation_ack");
	});

	it("returns null for unstamped rows and for unknown values", () => {
		expect(readHomeNarrationClass(row({ id: "a" }).payload)).toBeNull();
		expect(
			readHomeNarrationClass({ metadata: { homeNarration: "something_else" } }),
		).toBeNull();
		expect(readHomeNarrationClass(null)).toBeNull();
		expect(readHomeNarrationClass({})).toBeNull();
	});
});

describe("collapseHomeDelegationNarration", () => {
	it("leaves unstamped rows alone", () => {
		const rows = [
			row({ id: "user" }),
			row({ id: "answer", childRunId: "child-1" }),
		];
		expect(collapseHomeDelegationNarration(rows).size).toBe(0);
	});

	it("blanks the ack (it owns the receipt) and drops the later restatement", () => {
		const rows = [
			row({ id: "ack", childRunId: "child-1", narration: "delegation_ack" }),
			row({
				id: "completion",
				childRunId: "child-1",
				narration: "delegation_status_only",
			}),
		];
		const dispositions = collapseHomeDelegationNarration(rows);
		expect(dispositions.get("ack")).toBe("blank");
		expect(dispositions.get("completion")).toBe("drop");
	});

	it("keeps a real relayed child answer renderable and drops the ack beside it", () => {
		const rows = [
			row({ id: "ack", childRunId: "child-1", narration: "delegation_ack" }),
			// Unstamped: the child returned a final assistant message, so this turn
			// carries the delegation's actual return value — and, rendering anyway,
			// it owns the receipt.
			row({ id: "result", childRunId: "child-1" }),
		];
		const dispositions = collapseHomeDelegationNarration(rows);
		expect(dispositions.get("ack")).toBe("drop");
		expect(dispositions.has("result")).toBe(false);
	});

	it("picks the unstamped carrier regardless of page order (no createdAt tie-break dependency)", () => {
		const forward = collapseHomeDelegationNarration([
			row({ id: "answer", childRunId: "child-3" }),
			row({
				id: "restatement",
				childRunId: "child-3",
				narration: "delegation_status_only",
			}),
		]);
		const reversed = collapseHomeDelegationNarration([
			row({
				id: "restatement",
				childRunId: "child-3",
				narration: "delegation_status_only",
			}),
			row({ id: "answer", childRunId: "child-3" }),
		]);
		expect(forward.get("restatement")).toBe("drop");
		expect(reversed.get("restatement")).toBe("drop");
	});

	it("BLANKS rather than drops a narration row that is the only carrier of its delegation", () => {
		// Live shape: a `needs_approval` ack carries no delegation metadata and is
		// not stamped, so the dispatch-failure message is the first — and only —
		// row Tedix OS can build a receipt from. Dropping it would delete the
		// delegation from the transcript.
		const rows = [
			row({ id: "approval-ack" }),
			row({
				id: "dispatch-failed",
				childRunId: "child-9",
				narration: "delegation_status_only",
			}),
		];
		const dispositions = collapseHomeDelegationNarration(rows);
		expect(dispositions.get("dispatch-failed")).toBe("blank");
	});

	it("blanks a narration row with no child-run linkage at all", () => {
		const rows = [
			row({ id: "canceled", narration: "turn_canceled_delegated" }),
		];
		expect(collapseHomeDelegationNarration(rows).get("canceled")).toBe("blank");
	});

	it("keys the carrier off payload metadata when the column is unset", () => {
		const rows = [
			row({
				id: "ack",
				metadata: { childRunId: "child-2" },
				narration: "delegation_ack",
			}),
			row({
				id: "completion",
				metadata: { childRunId: "child-2" },
				narration: "delegation_status_only",
			}),
		];
		const dispositions = collapseHomeDelegationNarration(rows);
		expect(dispositions.get("ack")).toBe("blank");
		expect(dispositions.get("completion")).toBe("drop");
	});

	it("scopes the carrier per child run", () => {
		const rows = [
			row({ id: "ack-a", childRunId: "child-a", narration: "delegation_ack" }),
			row({ id: "ack-b", childRunId: "child-b", narration: "delegation_ack" }),
			row({
				id: "done-a",
				childRunId: "child-a",
				narration: "delegation_status_only",
			}),
			row({
				id: "done-b",
				childRunId: "child-b",
				narration: "delegation_status_only",
			}),
		];
		const dispositions = collapseHomeDelegationNarration(rows);
		expect(dispositions.get("ack-a")).toBe("blank");
		expect(dispositions.get("ack-b")).toBe("blank");
		expect(dispositions.get("done-a")).toBe("drop");
		expect(dispositions.get("done-b")).toBe("drop");
	});
});
