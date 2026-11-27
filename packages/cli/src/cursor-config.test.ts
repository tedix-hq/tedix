import { describe, expect, it } from "bun:test";
import {
	mergeCursorHooks,
	mergeCursorMcp,
	pruneCursorHooks,
} from "./cursor-config";

describe("mergeCursorMcp", () => {
	it("adds the Tedix server, keeps comments and other servers", () => {
		const text = `{
	// my servers
	"mcpServers": {
		"other": { "url": "https://example.com/mcp" }
	}
}
`;
		const next = mergeCursorMcp(text);
		expect(next).toContain("// my servers");
		expect(next).toContain("other");
		expect(next).toContain("https://connect.mcp.tedix.dev/mcp");
	});

	it("replaces an older Tedix address", () => {
		const text = `{"mcpServers":{"tedix":{"url":"https://old.example/mcp"}}}`;
		const next = mergeCursorMcp(text);
		expect(next).not.toContain("old.example");
		expect(next).toContain("connect.mcp.tedix.dev");
	});

	it("is a no-op when Tedix already points at the connect endpoint", () => {
		const text = `{"mcpServers":{"tedix":{"url":"https://connect.mcp.tedix.dev/mcp"}}}`;
		expect(mergeCursorMcp(text)).toBe(text);
	});

	it("builds the file from nothing", () => {
		const next = mergeCursorMcp("");
		expect(JSON.parse(next).mcpServers.tedix.url).toBe(
			"https://connect.mcp.tedix.dev/mcp",
		);
	});
});

describe("mergeCursorHooks / pruneCursorHooks", () => {
	it("writes the documented hooks.json shape and keeps foreign hooks", () => {
		const text = `{
	"version": 1,
	"hooks": {
		"stop": [{ "command": "./mine.sh" }]
	}
}
`;
		const next = mergeCursorHooks(text);
		const parsed = JSON.parse(next);
		expect(parsed.version).toBe(1);
		expect(parsed.hooks.stop[0].command).toBe("./mine.sh");
		expect(parsed.hooks.stop[1].command).toContain("tedix hooks status");
		expect(parsed.hooks.stop[1].command).toContain("--host cursor");
		expect(parsed.hooks.sessionStart[0].command).toContain(
			"tedix hooks session-start",
		);
		expect(parsed.hooks.beforeSubmitPrompt.length).toBe(1);
	});

	it("replaces only its own earlier entries", () => {
		const once = mergeCursorHooks("");
		const twice = mergeCursorHooks(once);
		const parsed = JSON.parse(twice);
		for (const entries of Object.values(parsed.hooks) as {
			command: string;
		}[][])
			expect(
				entries.filter((entry) =>
					entry.command.includes("tedix-managed-cursor-hook"),
				).length,
			).toBe(1);
	});

	it("removes only Tedix's commands", () => {
		const text = `{
	"version": 1,
	"hooks": {
		"stop": [
			{ "command": "./mine.sh" },
			{ "command": "tedix hooks status --host cursor || true # tedix-managed-cursor-hook" }
		]
	}
}
`;
		const next = pruneCursorHooks(text);
		const parsed = JSON.parse(next);
		expect(parsed.hooks.stop).toEqual([{ command: "./mine.sh" }]);
	});
});
