import { describe, expect, it } from "vite-plus/test";
import { isChatGptConnection } from "./codemode";

describe("ChatGPT presentation", () => {
	it.each([
		"https://chatgpt.com/oauth/client.json",
		"https://chatgpt.com/oauth/fictional-connector/client.json",
	])(
		"recognizes the verified OAuth client %s without host hints",
		(clientId) => {
			const headers = new Headers({ "x-tedix-auth-client-id": clientId });
			expect(isChatGptConnection("connect", headers)).toBe(true);
			expect(isChatGptConnection("other-app", headers)).toBe(false);
		},
	);
	it.each([
		"https://claude.ai/oauth/client.json",
		"https://chatgpt.com.attacker.test/oauth/client.json",
		"https://chatgpt.com@attacker.test/oauth/client.json",
		"https://chatgpt.com/oauth/client.json?fake=true",
		"http://chatgpt.com/oauth/client.json",
	])(
		"does not identify an unrelated OAuth client %s as ChatGPT",
		(clientId) => {
			expect(
				isChatGptConnection(
					"connect",
					new Headers({ "x-tedix-auth-client-id": clientId }),
				),
			).toBe(false);
		},
	);
	it("recognizes the OpenAI scanner User-Agent without client metadata", () => {
		expect(
			isChatGptConnection(
				"connect",
				new Headers({ "User-Agent": "openai-mcp/1.0.0" }),
			),
		).toBe(true);
	});
	it.each(["ChatGPT", "openai-mcp"])(
		"recognizes %s client metadata and the legacy User-Agent only on Connect",
		(name) => {
			const meta = {
				"io.modelcontextprotocol/clientInfo": { name, version: "1" },
			};
			expect(isChatGptConnection("connect", new Headers(), meta)).toBe(true);
			expect(
				isChatGptConnection(
					"connect",
					new Headers({ "User-Agent": "ChatGPT/1.0" }),
				),
			).toBe(true);
			expect(isChatGptConnection("other-app", new Headers(), meta)).toBe(false);
		},
	);
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
