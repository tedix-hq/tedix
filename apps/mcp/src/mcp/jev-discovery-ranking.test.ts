import { describe, expect, it, vi } from "vite-plus/test";
import { rerankDiscoveryShortlist } from "./jev-discovery-ranking";

const rows = [
	{
		namespace: "work",
		tool: "list_items",
		meta: {
			authorized: true,
			name: "List work",
			description: "Find work items",
		},
	},
	{
		namespace: "work",
		tool: "delete_item",
		meta: {
			authorized: false,
			name: "Delete work",
			description: "Remove a work item",
		},
	},
	{
		namespace: "skills",
		tool: "work_triage",
		meta: {
			kind: "skill",
			name: "Work triage",
			description: "A recorded tenant procedure",
		},
	},
	{
		namespace: "work",
		tool: "get_item",
		meta: { authorized: true, name: "Get work", description: "Read one item" },
	},
];

describe("Jev Code Mode discovery ordering", () => {
	it("sends only authorized compact candidates and keeps unauthorized positions", async () => {
		const rank = vi.fn(async () => ({ rankedIds: ["skills.work_triage"] }));
		const result = await rerankDiscoveryShortlist(
			rows,
			"triage my work items",
			rank,
		);
		expect(rank).toHaveBeenCalledWith({
			query: "triage my work items",
			candidates: [
				{
					id: "work.list_items",
					kind: "tool",
					description: "List work\nFind work items",
				},
				{
					id: "skills.work_triage",
					kind: "skill",
					description: "Work triage\nA recorded tenant procedure",
				},
				{
					id: "work.get_item",
					kind: "tool",
					description: "Get work\nRead one item",
				},
			],
		});
		expect(result.usedJev).toBe(true);
		expect(result.entries.map((row) => row.tool)).toEqual([
			"work_triage",
			"delete_item",
			"list_items",
			"get_item",
		]);
	});

	it("does not call a model for an exact callable or short query", async () => {
		const rank = vi.fn(async () => ({ rankedIds: ["work.get_item"] }));
		expect(
			(await rerankDiscoveryShortlist(rows, "work.list_items", rank)).entries,
		).toBe(rows);
		expect((await rerankDiscoveryShortlist(rows, "list", rank)).entries).toBe(
			rows,
		);
		expect(rank).not.toHaveBeenCalled();
	});

	it("rejects invented and duplicate IDs without changing discovery", async () => {
		for (const rankedIds of [
			["work.delete_item"],
			["work.get_item", "work.get_item"],
		]) {
			const result = await rerankDiscoveryShortlist(
				rows,
				"triage my work items",
				async () => ({ rankedIds }),
			);
			expect(result).toEqual({ entries: rows, usedJev: false });
		}
	});

	it("keeps lexical order when judgment fails", async () => {
		const result = await rerankDiscoveryShortlist(
			rows,
			"triage my work items",
			async () => {
				throw new Error("unavailable");
			},
		);
		expect(result).toEqual({ entries: rows, usedJev: false });
	});
});
