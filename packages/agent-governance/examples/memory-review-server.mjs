import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { McpMemoryAdapter } from "../dist/memory-mcp.js";
import {
	MEMORY_REVIEW_TOOLS,
	createMemoryReview,
	recallMemory,
} from "../dist/memory-review.js";

// This private stdio example gives its launching operator all four review tools.
// A shared host must authenticate the caller and authorize each decision itself.
if (
	!process.env.MEMORY_FILE_PATH ||
	!isAbsolute(process.env.MEMORY_FILE_PATH) ||
	!process.env.MEMORY_REVIEW_SCOPE
) {
	throw new Error(
		"Set MEMORY_FILE_PATH to an isolated absolute file and MEMORY_REVIEW_SCOPE to its scope",
	);
}
const require = createRequire(import.meta.url);
const backend = new Client({ name: "memory-review-backend", version: "0.1.0" });
await backend.connect(
	new StdioClientTransport({
		command: process.execPath,
		args: [
			join(
				dirname(
					require.resolve("@modelcontextprotocol/server-memory/package.json"),
				),
				"dist/index.js",
			),
		],
		env: { MEMORY_FILE_PATH: process.env.MEMORY_FILE_PATH },
	}),
);
const memory = new McpMemoryAdapter(
	(name, args) => backend.callTool({ name, arguments: args }),
	process.env.MEMORY_REVIEW_SCOPE,
);
const review = createMemoryReview(memory, {
	actor: { kind: "user", id: "local-operator" },
	source: { surface: "memory_review_stdio" },
});
await serveStdio(() => {
	const server = new McpServer({ name: "memory-review", version: "0.1.0" });
	for (const tool of MEMORY_REVIEW_TOOLS) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: fromJsonSchema(tool.inputSchema),
			},
			async (args) => {
				const result = await review(tool.name, args);
				return {
					isError: Boolean(result.error),
					content: [{ type: "text", text: JSON.stringify(result) }],
				};
			},
		);
	}
	server.registerTool(
		"recall_memory",
		{
			description: "Recall approved memory only.",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: { query: { type: "string" } },
				additionalProperties: false,
			}),
		},
		async (args) => ({
			content: [
				{
					type: "text",
					text: JSON.stringify(await recallMemory(memory, args.query)),
				},
			],
		}),
	);
	return server;
});
process.stdin.on("end", () => {
	void backend.close();
});
