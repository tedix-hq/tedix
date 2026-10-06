import assert from "node:assert/strict";
import { McpToolResultStore } from "./mcp-tool-results";

function memoryWorkspace() {
	const files = new Map<string, string>();
	return {
		files,
		workspace: {
			readFile: async (path: string) => files.get(path) ?? null,
			writeFile: async (path: string, content: string) =>
				void files.set(path, content),
			deleteFile: async (path: string) => files.delete(path),
			diffContent: async () => "",
		},
	};
}

const rejects = async (run: Promise<unknown>, pattern: RegExp) =>
	await assert.rejects(run, pattern);

{
	const store = new McpToolResultStore(memoryWorkspace().workspace);
	const retained = await store.retain({ rows: ["needle", "x".repeat(100)] });
	const page = await store.read({
		resultId: retained.resultId,
		query: "needle",
		limit: 30,
	});
	assert.equal((page as { resultId: string }).resultId, retained.resultId);
	assert.equal((page as { found: boolean }).found, true);
	assert.match(JSON.stringify(page), /external_mcp_result/);
}

{
	const first = new McpToolResultStore(memoryWorkspace().workspace);
	const second = new McpToolResultStore(memoryWorkspace().workspace);
	const retained = await first.retain({ secret: "only-first-conversation" });
	await rejects(
		second.read({ resultId: retained.resultId }),
		/not found or expired/,
	);
}

{
	const memory = memoryWorkspace();
	let now = 0;
	const store = new McpToolResultStore(memory.workspace, () => now);
	const retained = await store.retain({ rows: [1] });
	now = 24 * 60 * 60 * 1000;
	await rejects(
		store.read({ resultId: retained.resultId }),
		/not found or expired/,
	);
}

await rejects(
	new McpToolResultStore(memoryWorkspace().workspace).retain(
		"x".repeat(1_000_001),
	),
	/exceeds retention limit/,
);

{
	const memory = memoryWorkspace();
	memory.files.set(
		".tedix/mcp-results/index.json",
		JSON.stringify([{ id: "../../victim", createdAt: 0, chars: -1 }]),
	);
	await rejects(
		new McpToolResultStore(memory.workspace).retain({ safe: true }),
		/Corrupt MCP result index/,
	);
	assert.equal(memory.files.has("../../victim"), false);
}

{
	const store = new McpToolResultStore(memoryWorkspace().workspace);
	const refs = await Promise.all(
		Array.from({ length: 10 }, (_, index) => store.retain({ index })),
	);
	for (const ref of refs) {
		const page = await store.read({ resultId: ref.resultId });
		assert.equal((page as { resultId: string }).resultId, ref.resultId);
	}
}

{
	const memory = memoryWorkspace();
	let now = 1;
	const store = new McpToolResultStore(memory.workspace, () => now++);
	const refs = [];
	for (let index = 0; index < 21; index++)
		refs.push(await store.retain({ index }));
	await rejects(store.read({ resultId: refs[0]!.resultId }), /not found/);
	const page = await store.read({ resultId: refs[20]!.resultId });
	assert.equal((page as { resultId: string }).resultId, refs[20]!.resultId);
}

{
	const store = new McpToolResultStore(memoryWorkspace().workspace);
	const retained = await store.retain("a😀b");
	const first = (await store.read({
		resultId: retained.resultId,
		offset: 0,
		limit: 12,
	})) as { content: string };
	assert.doesNotMatch(first.content, /�/);
	const found = (await store.read({
		resultId: retained.resultId,
		query: "😀",
		limit: 2,
	})) as { found: true; offset: number; content: string; nextOffset: number };
	assert.equal(found.found, true);
	assert.doesNotMatch(found.content, /�/);
	const low = (await store.read({
		resultId: retained.resultId,
		offset: found.offset + 1,
		limit: 1,
	})) as { content: string; offset: number; nextOffset: number };
	assert.equal(low.offset, found.offset);
	assert.ok(low.nextOffset > found.offset);
	assert.doesNotMatch(low.content, /�/);
	const spaced = await store.read({
		resultId: retained.resultId,
		query: " 😀 ",
		limit: 10,
	});
	assert.equal((spaced as { found: boolean }).found, false);
	assert.equal((spaced as { query: string }).query, " 😀 ");
}

console.log("mcp-tool-results.test.ts: all assertions passed");
