import { describe, expect, it } from "vite-plus/test";
import {
	cursorConfigSnippet,
	gatewayHealthSentence,
	gatewayUsageSentence,
} from "./app-gateway-overview";

describe("gateway overview copy", () => {
	it("describes connection checks in plain words", () => {
		expect(gatewayHealthSentence(null)).toBe("Not checked yet.");
		expect(gatewayHealthSentence({ status: "healthy", toolCount: 1 })).toBe(
			"Working. AI tools can reach 1 tool.",
		);
		expect(
			gatewayHealthSentence({ status: "issue", failed: 2, total: 14 }),
		).toBe("Not fully working: 2 of 14 checks failed.");
		expect(gatewayHealthSentence({ status: "error", message: "Offline" })).toBe(
			"The check could not run: Offline",
		);
	});

	it("reports usage only when the metric exists", () => {
		expect(gatewayUsageSentence(null, null)).toBeNull();
		expect(gatewayUsageSentence(0, null)).toBe(
			"Nobody has used it in the last 30 days.",
		);
		expect(gatewayUsageSentence(128, 95.6)).toBe(
			"Used in 128 sessions in the last 30 days; 96% finished without errors.",
		);
	});

	it("builds a Cursor config for the gateway address", () => {
		expect(
			JSON.parse(cursorConfigSnippet("acme-unified", "https://a.example/mcp")),
		).toEqual({
			mcpServers: { "acme-unified": { url: "https://a.example/mcp" } },
		});
	});
});
