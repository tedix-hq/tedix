import { describe, expect, it } from "vite-plus/test";
import { mcpToolsListResultTransform } from "../index";
import {
	decodeToolsListCursor,
	encodeToolsListCursor,
	paginateSortedToolsList,
	TOOLS_LIST_PAGE_SIZE,
} from "./tools-list-pagination";

/** Zero-padded names so byte order == numeric order. */
function makeTools(count: number): Array<{ name: string }> {
	return Array.from({ length: count }, (_, i) => ({
		name: `tool_${String(i).padStart(4, "0")}`,
	}));
}

describe("tools-list cursor codec", () => {
	it("round-trips a tool name through an opaque base64 cursor", () => {
		const cursor = encodeToolsListCursor("run_skill_workflow");
		expect(cursor).not.toContain("run_skill_workflow");
		expect(decodeToolsListCursor(cursor)).toBe("run_skill_workflow");
	});

	it("rejects garbage, foreign base64, and empty-string cursors", () => {
		expect(decodeToolsListCursor("!!!not-base64!!!")).toBeUndefined();
		expect(decodeToolsListCursor(btoa("some-other-token"))).toBeUndefined();
		expect(decodeToolsListCursor("")).toBeUndefined();
	});
});

describe("paginateSortedToolsList", () => {
	it("returns a surface at/under the page size whole, with no nextCursor", () => {
		const tools = makeTools(TOOLS_LIST_PAGE_SIZE);
		const page = paginateSortedToolsList(tools, undefined);
		expect(page).toEqual({ ok: true, tools });
	});

	it("pages a large surface with no overlap and no gaps", () => {
		const tools = makeTools(TOOLS_LIST_PAGE_SIZE * 2 + 50);
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = paginateSortedToolsList(tools, cursor);
			if (!page.ok) throw new Error("unexpected invalid cursor");
			seen.push(...page.tools.map((tool) => tool.name));
			cursor = page.nextCursor;
			pages += 1;
		} while (cursor !== undefined);
		expect(pages).toBe(3);
		expect(seen).toEqual(tools.map((tool) => tool.name));
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("flags undecodable and non-string cursors as invalid", () => {
		const tools = makeTools(10);
		expect(paginateSortedToolsList(tools, "not-a-cursor")).toEqual({
			ok: false,
		});
		expect(paginateSortedToolsList(tools, 42)).toEqual({ ok: false });
	});

	it("returns an empty terminal page when the cursor is past the end", () => {
		const tools = makeTools(5);
		const page = paginateSortedToolsList(
			tools,
			encodeToolsListCursor("tool_9999"),
		);
		expect(page).toEqual({ ok: true, tools: [] });
	});

	it("serves a list containing a nameless entry whole instead of paginating", () => {
		const tools = [...makeTools(3), {} as { name: string }];
		const page = paginateSortedToolsList(tools, undefined, 2);
		expect(page).toEqual({ ok: true, tools });
	});
});

describe("mcpToolsListResultTransform pagination", () => {
	const bigCount = TOOLS_LIST_PAGE_SIZE + 50;

	function transform() {
		return mcpToolsListResultTransform(
			Array.from({ length: bigCount }, (_, i) => ({
				toolId: `tool_${String(i).padStart(4, "0")}`,
			})),
			undefined,
			new Headers({ "x-tedix-auth-type": "service" }),
		);
	}

	type TransformInput = Parameters<ReturnType<typeof transform>>[0];

	function listRequest(cursor?: unknown): TransformInput["request"] {
		return {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
			params: cursor === undefined ? {} : { cursor },
		} as TransformInput["request"];
	}

	function listResponse(tools: Array<{ name: string }>) {
		return {
			jsonrpc: "2.0",
			id: 1,
			result: { tools },
		} as TransformInput["response"];
	}

	// Unsorted input proves pagination anchors on the deterministic sort.
	const wireTools = makeTools(bigCount).reverse();

	function resultOf(message: unknown): {
		tools: Array<{ name: string }>;
		nextCursor?: string;
	} {
		const result = (message as { result?: unknown }).result;
		expect(result).toBeDefined();
		return result as { tools: Array<{ name: string }>; nextCursor?: string };
	}

	it("serves page 1 of a large surface at the page size with a nextCursor", () => {
		const message = transform()({
			request: listRequest(),
			response: listResponse(wireTools),
		});
		const result = resultOf(message);
		expect(result.tools).toHaveLength(TOOLS_LIST_PAGE_SIZE);
		expect(result.tools[0]?.name).toBe("tool_0000");
		expect(typeof result.nextCursor).toBe("string");
	});

	it("continues page 2 after the boundary with no overlap and no nextCursor at the end", () => {
		const page1 = resultOf(
			transform()({
				request: listRequest(),
				response: listResponse(wireTools),
			}),
		);
		const page2 = resultOf(
			transform()({
				request: listRequest(page1.nextCursor),
				response: listResponse(wireTools),
			}),
		);
		expect(page2.tools).toHaveLength(bigCount - TOOLS_LIST_PAGE_SIZE);
		expect(page2.tools[0]?.name).toBe(
			`tool_${String(TOOLS_LIST_PAGE_SIZE).padStart(4, "0")}`,
		);
		expect(page2.nextCursor).toBeUndefined();
		const page1Names = new Set(page1.tools.map((tool) => tool.name));
		for (const tool of page2.tools) {
			expect(page1Names.has(tool.name)).toBe(false);
		}
	});

	it("answers an invalid cursor with -32602", () => {
		const message = transform()({
			request: listRequest("definitely-not-a-cursor"),
			response: listResponse(wireTools),
		});
		expect(message).toMatchObject({
			id: 1,
			error: { code: -32602 },
		});
		expect("result" in (message as Record<string, unknown>)).toBe(false);
	});

	it("leaves a small surface untouched: full list, no nextCursor", () => {
		const smallTransform = mcpToolsListResultTransform(
			[{ toolId: "get_skill" }, { toolId: "list_skills" }],
			undefined,
			new Headers({ "x-tedix-auth-type": "service" }),
		);
		const message = smallTransform({
			request: listRequest(),
			response: listResponse([{ name: "list_skills" }, { name: "get_skill" }]),
		});
		const result = resultOf(message);
		expect(result.tools.map((tool) => tool.name)).toEqual([
			"get_skill",
			"list_skills",
		]);
		expect(result.nextCursor).toBeUndefined();
	});
});
