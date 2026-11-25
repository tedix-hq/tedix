import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { describeMemoryConformance } from "./conformance";
import { McpMemoryAdapter } from "./memory-mcp";
import { recallMemory } from "./memory-review";

const require = createRequire(import.meta.url);
const backend = new Client({ name: "memory-conformance", version: "1.0.0" });
let directory: string;
let reviewClient: Client | undefined;
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "memory-conformance-"));
	await backend.connect(
		new StdioClientTransport({
			command: "node",
			args: [
				join(
					dirname(
						require.resolve("@modelcontextprotocol/server-memory/package.json"),
					),
					"dist/index.js",
				),
			],
			env: { MEMORY_FILE_PATH: join(directory, "conformance.jsonl") },
		}),
	);
});
afterAll(async () => {
	await reviewClient?.close();
	await backend.close();
	await rm(directory, { recursive: true, force: true });
});
const build = (scope = crypto.randomUUID()) =>
	new McpMemoryAdapter(
		(name, args) => backend.callTool({ name, arguments: args }),
		scope,
	);
describeMemoryConformance("MCP reference memory 2.2.1", build);

it("propagates external store errors without returning a local memory result", async () => {
	const memory = new McpMemoryAdapter(
		async () => ({
			isError: true,
			content: [{ type: "text", text: "store unavailable" }],
		}),
		"unavailable",
	);
	await expect(recallMemory(memory)).rejects.toThrow("store unavailable");
	await expect(
		memory.write({
			key: "tone",
			value: "formal",
			provenance: {
				actor: { kind: "agent", id: "example" },
				source: { surface: "test" },
			},
		}),
	).rejects.toThrow("store unavailable");
});

it("serves four review tools over the external store, restores approved memory and excludes rejected recall after restart", async () => {
	execFileSync("bun", ["run", "build"], {
		cwd: join(import.meta.dirname, ".."),
		stdio: "pipe",
	});
	const file = join(directory, "review.jsonl");
	const connect = async () => {
		const client = new Client({
			name: "memory-review-proof",
			version: "1.0.0",
		});
		await client.connect(
			new StdioClientTransport({
				command: "node",
				args: [
					join(import.meta.dirname, "../examples/memory-review-server.mjs"),
				],
				env: { MEMORY_FILE_PATH: file, MEMORY_REVIEW_SCOPE: "pilot" },
			}),
		);
		return client;
	};
	reviewClient = await connect();
	const tools = await reviewClient.listTools();
	expect(tools.tools.map((tool) => tool.name)).toEqual(
		expect.arrayContaining([
			"propose_memory",
			"approve_memory",
			"reject_memory",
			"rollback_memory",
			"recall_memory",
		]),
	);
	const call = async (name: string, args: Record<string, unknown>) => {
		const response = await reviewClient!.callTool({ name, arguments: args });
		expect(response.isError).not.toBe(true);
		return JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
	};
	const first = await call("propose_memory", { key: "tone", value: "formal" });
	expect(await call("recall_memory", {})).toEqual([]);
	await call("approve_memory", {
		revisionId: first.revision.revisionId,
		note: "Checked source",
	});
	const rejected = await call("propose_memory", {
		key: "tone",
		value: "rejected-secret",
	});
	const rejection = await call("reject_memory", {
		revisionId: rejected.revision.revisionId,
	});
	expect(rejection.statement.predicate.record).toMatchObject({
		operation: "reject_memory",
		outcome: "applied",
		actor: { id: "local-operator" },
	});
	const second = await call("propose_memory", { key: "tone", value: "casual" });
	await call("approve_memory", { revisionId: second.revision.revisionId });
	expect((await call("recall_memory", {}))[0].value).toBe("casual");
	const restored = await call("rollback_memory", {
		key: "tone",
		toRevisionId: first.revision.revisionId,
	});
	expect(restored.revision).toMatchObject({
		value: "formal",
		review: "approved",
		rolledBackFrom: first.revision.revisionId,
	});
	expect(restored.statement.predicate.record).toMatchObject({
		before: { revisionId: second.revision.revisionId },
		after: { revisionId: restored.revision.revisionId },
	});
	await reviewClient.close();
	reviewClient = await connect();
	expect(await call("recall_memory", { query: "rejected-secret" })).toEqual([]);
	expect((await call("recall_memory", {}))[0].value).toBe("formal");
	const denied = await reviewClient.callTool({
		name: "rollback_memory",
		arguments: { key: "tone", toRevisionId: rejected.revision.revisionId },
	});
	expect(denied.isError).toBe(true);
	expect((await call("recall_memory", {}))[0].value).toBe("formal");
	const malformed = await reviewClient.callTool({
		name: "propose_memory",
		arguments: { key: "bypass", value: "bad", review: "approved" },
	});
	expect(malformed.isError).toBe(true);
	// Separate adapters cannot see another scope even though the server is shared.
	expect(await recallMemory(build())).toEqual([]);
}, 15000);
