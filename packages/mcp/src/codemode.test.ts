import { describe, expect, it } from "vite-plus/test";
import { isChatGptConnection } from "./codemode";

describe("ChatGPT presentation", () => {
	it("recognizes client metadata and the legacy User-Agent only on Connect", () => {
		const meta = {
			"io.modelcontextprotocol/clientInfo": { name: "ChatGPT", version: "1" },
		};
		expect(isChatGptConnection("connect", new Headers(), meta)).toBe(true);
		expect(
			isChatGptConnection(
				"connect",
				new Headers({ "User-Agent": "ChatGPT/1.0" }),
			),
		).toBe(true);
		expect(isChatGptConnection("other-app", new Headers(), meta)).toBe(false);
	});
	it.each(["Claude", "Codex", "tedix-cli", "generic-mcp-client"])(
		"preserves %s presentation",
		(name) => {
			expect(
				isChatGptConnection("connect", new Headers({ "User-Agent": name }), {
					"io.modelcontextprotocol/clientInfo": { name },
				}),
			).toBe(false);
		},
	);
});
