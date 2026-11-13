import { expect, test } from "bun:test";
import { planDelta } from "./delta";
import { fromWire, renderRow, toWire } from "./rows";
import { RemoteWorkspaceStore } from "./target";

test("delta plans inserts, replacements and deletions without depending on row order", () => {
	expect(
		planDelta(
			[
				{ id: "a", title: "old" },
				{ id: "b", title: "delete" },
				{ id: "c", title: "same" },
			],
			[
				{ title: "same", id: "c" },
				{ id: "d", title: "new" },
				{ title: "changed", id: "a" },
			],
		),
	).toEqual([
		{ before: { id: "a", title: "old" }, after: { title: "changed", id: "a" } },
		{ before: { id: "b", title: "delete" }, after: null },
		{ before: null, after: { id: "d", title: "new" } },
	]);
	expect(() => planDelta([{ id: "a" }, { id: "a" }], [])).toThrow("unique ids");
});

test("delta preserves blob contents and nulls through the authenticated remote route", async () => {
	const before = {
		id: "row",
		body: new Uint8Array([0, 128, 255]),
		label: null,
	};
	const after = { ...before, label: "new" };
	const store = new RemoteWorkspaceStore(
		"https://fixture.invalid",
		{
			mode: "tedix",
			headers: async () => ({ Authorization: "Bearer fixture" }),
		},
		{ organizationId: "fixture", workspaceId: "one" },
		(async (url, init) => {
			expect(String(url)).toBe(
				"https://fixture.invalid/admin/migration/workspaces/fixture/one/delta",
			);
			const body = JSON.parse(String(init?.body));
			expect(renderRow(fromWire(body.changes[0].before))).toBe(
				renderRow(before),
			);
			expect(body.changes[0].after).toEqual(toWire(after));
			return Response.json({
				batchId: body.batchId,
				table: body.table,
				rowCount: 1,
				status: "imported",
				importGeneration: 8,
			});
		}) as typeof fetch,
	);
	expect(
		await store.applyDelta({
			batchId: "delta:fixture",
			table: "os_outputs",
			importGeneration: 7,
			freezeRef: "fixture:freeze",
			changes: [{ before, after }],
		}),
	).toMatchObject({ importGeneration: 8 });
});
