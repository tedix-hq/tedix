import { strict as assert } from "node:assert";
import { buildTediCompletionHandler } from "./mcp-mount";

const handler = buildTediCompletionHandler({
	conversationsList: async () => ({
		conversations: [
			{ sessionKey: "agent:main:main" },
			{ sessionKey: "agent:main:cmo" },
			{ sessionKey: undefined },
		],
	}),
	listArtifactFiles: async () => ({
		// Live DO shape: plain string paths. Object entries stay tolerated.
		files: [
			"memory/MEMORY.md",
			"memory/daily/2026-07-27.md",
			{ name: "SOUL.md" },
		],
	}),
});

// session_key candidates from conversation summaries, filtered by partial.
let result = await handler({
	ref: { type: "ref/prompt", name: "compose" },
	argument: { name: "session_key", value: "agent:main:c" },
});
assert.deepEqual(result.values, ["agent:main:cmo"]);

// Artifact paths for path/prefix arguments (path ?? name fallback).
result = await handler({
	ref: { type: "ref/prompt", name: "compose" },
	argument: { name: "path", value: "memory/" },
});
assert.deepEqual(result.values, [
	"memory/MEMORY.md",
	"memory/daily/2026-07-27.md",
]);

// Unknown arguments yield no suggestions.
result = await handler({
	ref: { type: "ref/prompt", name: "compose" },
	argument: { name: "target", value: "c" },
});
assert.deepEqual(result.values, []);

// A failing candidate source degrades to no suggestions, never throws.
const failing = buildTediCompletionHandler({
	conversationsList: async () => {
		throw new Error("DO unavailable");
	},
});
result = await failing({
	ref: { type: "ref/prompt", name: "compose" },
	argument: { name: "session_key", value: "" },
});
assert.deepEqual(result.values, []);

console.log("Tedi MCP completion handler tests passed.");
