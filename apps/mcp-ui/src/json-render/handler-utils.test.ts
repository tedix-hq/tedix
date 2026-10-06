import { createStateStore } from "@json-render/react";
import { describe, expect, it } from "vite-plus/test";
import { buildTedixActionHandlers } from "./handler-utils";

describe("state-backed filter and sort actions", () => {
	it("filters a separate source into a nested target, mirrors the trimmed query, and resets", async () => {
		const rows = [{ name: "Alpha" }, { name: "Beta" }, { name: "Alphabet" }];
		const store = createStateStore({
			source: rows,
			view: { rows: [], query: "" },
			items: ["untouched"],
		});
		const handlers = buildTedixActionHandlers(store);
		const params = {
			statePath: "/view/rows",
			sourceStatePath: "/source",
			queryStatePath: "/view/query",
			field: "name",
		};
		await handlers.filter({ ...params, value: " ALPHA " });
		expect(store.getSnapshot()).toEqual({
			source: rows,
			view: { rows: [rows[0], rows[2]], query: "ALPHA" },
			items: ["untouched"],
		});
		await handlers.filter({ ...params, value: "alpha", mode: "eq" });
		expect(store.getSnapshot().view).toEqual({
			rows: [rows[0]],
			query: "alpha",
		});
		await handlers.filter({ ...params, value: "  " });
		expect(store.getSnapshot()).toEqual({
			source: rows,
			view: { rows, query: "" },
			items: ["untouched"],
		});
	});

	it("sorts numeric values in both directions into a separate target without changing the source", async () => {
		const rows = [
			{ details: { rank: 10 } },
			{ details: { rank: 2 } },
			{ details: { rank: 1 } },
		];
		const store = createStateStore({
			source: rows,
			result: [],
			items: ["untouched"],
		});
		const handlers = buildTedixActionHandlers(store);
		const params = {
			statePath: "/result",
			sourceStatePath: "/source",
			field: "details.rank",
		};
		await handlers.sort({ ...params, direction: "asc" });
		expect(store.getSnapshot()).toEqual({
			source: rows,
			result: [rows[2], rows[1], rows[0]],
			items: ["untouched"],
		});
		await handlers.sort({ ...params, direction: "desc" });
		expect(store.getSnapshot()).toEqual({
			source: rows,
			result: [rows[0], rows[1], rows[2]],
			items: ["untouched"],
		});
	});

	it("defaults filtering to items and the complete source, then sorts the current target", async () => {
		const rows = [{ name: "item 10" }, { name: "other" }, { name: "item 2" }];
		const store = createStateStore({ allItems: rows, items: [] });
		const handlers = buildTedixActionHandlers(store);
		await handlers.filter({ field: "name", value: "item" });
		expect(store.getSnapshot().items).toEqual([rows[0], rows[2]]);
		await handlers.sort({ field: "name" });
		expect(store.getSnapshot()).toEqual({
			allItems: rows,
			items: [rows[2], rows[0]],
		});
		await handlers.filter({ value: "" });
		expect(store.getSnapshot()).toEqual({ allItems: rows, items: rows });
	});

	it("uses items for a non-string target and filters it when there is no complete source", async () => {
		const rows = [{ name: "item 10" }, { name: "item 2" }, { name: "other" }];
		const store = createStateStore({ items: rows });
		const handlers = buildTedixActionHandlers(store);
		await handlers.filter({ statePath: 42, field: "name", value: "item" });
		await handlers.sort({ statePath: null, field: "name" });
		expect(store.getSnapshot().items).toEqual([rows[1], rows[0]]);
	});
});
