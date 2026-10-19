import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";
import { removeOptimisticDeckCard } from "./optimistic-deck-decision";

const key = ["test-inbox"];
const row = (id: string) => ({ request: { id }, version: 1 });
describe("optimistic Deck decisions", () => {
	it("removes immediately and rolls back only the failed card across pages", () => {
		const client = new QueryClient();
		client.setQueryData(key, { data: [row("a"), row("b"), row("c")] });
		const infiniteKey = [...key, "earlier"];
		client.setQueryData(infiniteKey, {
			pages: [{ data: [row("a"), row("b")] }, { data: [row("c")] }],
			pageParams: [null, "cursor"],
		});
		const rollback = removeOptimisticDeckCard(client, [key], "a");
		expect(client.getQueryData(key)).toEqual({ data: [row("b"), row("c")] });
		removeOptimisticDeckCard(client, [key], "b");
		client.setQueryData(key, { data: [row("new"), row("c")] });
		rollback();
		expect(client.getQueryData(key)).toEqual({
			data: [row("a"), row("new"), row("c")],
		});
		expect(client.getQueryData(infiniteKey)).toEqual({
			pages: [{ data: [row("a")] }, { data: [row("c")] }],
			pageParams: [null, "cursor"],
		});
		rollback();
		expect((client.getQueryData(key) as { data: unknown[] }).data).toHaveLength(
			3,
		);
	});
	it("handles both approval identifiers and preserves unrelated detail records", () => {
		const client = new QueryClient();
		client.setQueryData(key, {
			data: [{ proposal: { id: "a" } }, { id: "b" }],
			nextCursor: "keep",
		});
		client.setQueryData(["detail", "a"], row("a"));
		const undo = removeOptimisticDeckCard(client, [key], "a");
		expect(client.getQueryData(key)).toEqual({
			data: [{ id: "b" }],
			nextCursor: "keep",
		});
		expect(client.getQueryData(["detail", "a"])).toEqual(row("a"));
		undo();
		expect(client.getQueryData(key)).toEqual({
			data: [{ proposal: { id: "a" } }, { id: "b" }],
			nextCursor: "keep",
		});
	});
});
