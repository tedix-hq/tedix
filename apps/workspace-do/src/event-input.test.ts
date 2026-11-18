import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	boundedEventInput,
	EVENT_INPUT_CHARS,
	SqlEventLedger,
	sumUsageTotals,
} from "./event-ledger";
import type { WorkspaceStorage } from "./runtime";

function memoryStorage(): WorkspaceStorage {
	const db = new Database(":memory:");
	return {
		exec: <T>(sql: string, ...params: unknown[]) =>
			db.query(sql).all(...(params as never[])) as T[],
		run: (sql, ...params) => {
			if (params.length) db.query(sql).run(...(params as never[]));
			else db.exec(sql);
		},
		get: () => undefined,
		put: () => {},
		delete: () => {},
	};
}

describe("boundedEventInput", () => {
	test("keeps a small payload as it is", () => {
		const input = { outputId: "o1", patch: "short" };
		expect(boundedEventInput(input)).toEqual(input);
		expect(boundedEventInput(undefined)).toBeUndefined();
	});

	test("replaces a 1.2 MB save with a small summary in each event", () => {
		const input = { outputId: "o1", content: "x".repeat(1_200_000) };
		const stored = JSON.stringify(boundedEventInput(input));
		expect(stored.length).toBeLessThan(EVENT_INPUT_CHARS);
		expect(JSON.parse(stored)).toEqual({
			truncated: true,
			chars: JSON.stringify(input).length,
			keys: ["outputId", "content"],
		});
		// Two events (step.started + approval.requested) now cost under 4 KB.
		expect(stored.length * 2).toBeLessThan(4_000);
	});
});

describe("usageByConversation", () => {
	test("sums finished replies per conversation and counts unpriced ones", () => {
		const ledger = new SqlEventLedger(memoryStorage(), () => {});
		const done = (turnId: string, usage?: Record<string, unknown>) => ({
			type: "assistant.done" as const,
			turnId,
			messageId: turnId,
			text: "ok",
			...(usage ? { usage: usage as never } : {}),
		});
		ledger.append(
			"a",
			done("t1", { inputTokens: 1000, outputTokens: 200, costUsd: 0.01 }),
		);
		ledger.append(
			"a",
			done("t2", { inputTokens: 500, outputTokens: 100, costUsd: 0.005 }),
		);
		ledger.append(
			"b",
			done("t3", {
				inputTokens: 300,
				outputTokens: 50,
				costUnavailable: "no price for this model",
			}),
		);
		// Progress receipts, imported replies and old zero rows are not counted.
		ledger.append("b", {
			type: "turn.usage",
			turnId: "t4",
			usage: { inputTokens: 9, outputTokens: 9 },
		});
		ledger.append("b", done("t5"));
		ledger.append("c", done("t6", { inputTokens: 0, outputTokens: 0 }));

		const usage = ledger.usageByConversation();
		expect(usage.get("a")?.inputTokens).toBe(1500);
		expect(usage.get("a")?.outputTokens).toBe(300);
		expect(usage.get("a")?.costUsd).toBeCloseTo(0.015);
		expect(usage.get("a")?.unpricedReplies).toBeUndefined();
		expect(usage.get("b")).toEqual({
			inputTokens: 300,
			outputTokens: 50,
			unpricedReplies: 1,
		});
		expect(usage.has("c")).toBe(false);

		const total = sumUsageTotals(usage.values());
		expect(total?.inputTokens).toBe(1800);
		expect(total?.outputTokens).toBe(350);
		expect(total?.costUsd).toBeCloseTo(0.015);
		expect(total?.unpricedReplies).toBe(1);
		expect(sumUsageTotals([])).toBeUndefined();
	});
});
