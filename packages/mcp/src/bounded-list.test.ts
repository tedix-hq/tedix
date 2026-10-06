import { describe, expect, it } from "vite-plus/test";
import {
	collectBoundedMcpList,
	MCP_LIST_MAX_ITEMS,
	MCP_LIST_MAX_PAGES,
} from "./bounded-list";

describe("collectBoundedMcpList", () => {
	it("walks every page of a well-behaved server and reports it complete", async () => {
		const pages = [
			{ items: [{ name: "a" }], nextCursor: "p2" },
			{ items: [{ name: "b" }], nextCursor: "p3" },
			{ items: [{ name: "c" }] },
		];
		const seen: (string | undefined)[] = [];
		let index = 0;
		const result = await collectBoundedMcpList<{ name: string }>((cursor) => {
			seen.push(cursor);
			return Promise.resolve(pages[index++]);
		});

		expect(result).toEqual({
			items: [{ name: "a" }, { name: "b" }, { name: "c" }],
			truncated: false,
		});
		expect(seen).toEqual([undefined, "p2", "p3"]);
	});

	it("stops a hostile server that never stops handing out fresh cursors", async () => {
		let pages = 0;
		const result = await collectBoundedMcpList<{ name: string }>(() => {
			pages += 1;
			return Promise.resolve({
				items: [{ name: `tool_${pages}` }],
				nextCursor: `cursor-${pages}`,
			});
		});

		expect(pages).toBe(MCP_LIST_MAX_PAGES);
		expect(result.truncated).toBe(true);
		expect(result.items).toHaveLength(MCP_LIST_MAX_PAGES);
	});

	it("stops a server that replays one constant cursor forever", async () => {
		let pages = 0;
		const result = await collectBoundedMcpList<{ name: string }>(() => {
			pages += 1;
			return Promise.resolve({
				items: [{ name: "same_tool" }],
				nextCursor: "stuck",
			});
		});

		expect(pages).toBeLessThanOrEqual(MCP_LIST_MAX_PAGES);
		expect(result.truncated).toBe(true);
	});

	it("bounds retained entries independently of the page count", async () => {
		const page = {
			items: Array.from({ length: 1_000 }, (_, i) => ({ name: `t${i}` })),
			nextCursor: "next",
		};
		let cursor = 0;
		const result = await collectBoundedMcpList<{ name: string }>(() =>
			Promise.resolve({ ...page, nextCursor: `next-${cursor++}` }),
		);

		expect(result.items).toHaveLength(MCP_LIST_MAX_ITEMS);
		expect(result.truncated).toBe(true);
	});

	it("bounds a catalog by size when a server returns few but enormous tools", async () => {
		const schema = "x".repeat(600_000);
		let cursor = 0;
		const result = await collectBoundedMcpList<{ name: string; blob: string }>(
			() =>
				Promise.resolve({
					items: [{ name: `t${cursor}`, blob: schema }],
					nextCursor: `next-${cursor++}`,
				}),
		);

		expect(result.truncated).toBe(true);
		expect(result.items.length).toBeLessThan(MCP_LIST_MAX_PAGES);
	});

	it("treats an empty-string cursor as a real cursor and a null one as the end", async () => {
		const cursors: (string | undefined)[] = [];
		const result = await collectBoundedMcpList<{ name: string }>((cursor) => {
			cursors.push(cursor);
			return Promise.resolve(
				cursors.length === 1
					? { items: [{ name: "a" }], nextCursor: "" }
					: { items: [{ name: "b" }], nextCursor: null },
			);
		});

		expect(cursors).toEqual([undefined, ""]);
		expect(result).toEqual({
			items: [{ name: "a" }, { name: "b" }],
			truncated: false,
		});
	});
});

describe("collectBoundedMcpList bounds overrides", () => {
	it("stops at a caller-supplied page cap and reports truncation", async () => {
		let pages = 0;
		const result = await collectBoundedMcpList<{ name: string }>(
			() => {
				pages += 1;
				return Promise.resolve({
					items: [{ name: `t${pages}` }],
					nextCursor: `c${pages}`,
				});
			},
			{ maxPages: 3 },
		);

		expect(pages).toBe(3);
		expect(result).toEqual({
			items: [{ name: "t1" }, { name: "t2" }, { name: "t3" }],
			truncated: true,
		});
	});

	it("stops on the first repeated cursor without refetching it", async () => {
		const cursors: (string | undefined)[] = [];
		const sequence = ["a", "b", "a", "c"];
		const result = await collectBoundedMcpList<{ name: string }>((cursor) => {
			cursors.push(cursor);
			return Promise.resolve({
				items: [{ name: `p${cursors.length}` }],
				nextCursor: sequence[cursors.length - 1],
			});
		});

		expect(cursors).toEqual([undefined, "a", "b"]);
		expect(result.items).toHaveLength(3);
		expect(result.truncated).toBe(true);
	});
});
