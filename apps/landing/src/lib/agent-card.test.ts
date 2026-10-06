import { describe, expect, it } from "vite-plus/test";
import {
	agentCardResponse,
	AGENT_CARD_PATH,
	LEGACY_AGENT_CARD_PATH,
	tedixAgentCard,
} from "./agent-card";
import { GET as legacyAgentCard } from "../pages/.well-known/ai-agent.json";

describe("Tedix public Agent Card", () => {
	it("uses the canonical A2A 1.0 shape with an honest MCP custom binding", () => {
		expect(AGENT_CARD_PATH).toBe("/.well-known/agent-card.json");
		expect(LEGACY_AGENT_CARD_PATH).toBe("/.well-known/ai-agent.json");
		expect(tedixAgentCard).toMatchObject({
			name: "Tedix",
			supportedInterfaces: [
				{
					url: "https://tedix-unified.mcp.tedix.dev/mcp",
					protocolBinding:
						"https://modelcontextprotocol.io/specification/2026-07-28",
					protocolVersion: "1.0",
				},
			],
			capabilities: {
				streaming: false,
				pushNotifications: false,
				extendedAgentCard: false,
			},
			defaultInputModes: ["text/plain", "application/json"],
			defaultOutputModes: ["text/plain", "application/json"],
		});
	});

	it("advertises only deliberately public platform skills", () => {
		expect(tedixAgentCard.skills.map(({ id }) => id)).toEqual([
			"coordinate-digital-workers",
			"discover-mcp-apps",
		]);
		expect(JSON.stringify(tedixAgentCard)).not.toMatch(
			/cto|principalId|organizationId|tediId|policyPackId/,
		);
	});

	it("serves the registered A2A media type with bounded public caching", async () => {
		const response = agentCardResponse();
		expect(response.headers.get("content-type")).toBe(
			"application/a2a+json; charset=utf-8",
		);
		expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
		expect(await response.json()).toEqual(tedixAgentCard);
	});

	it("permanently redirects the legacy custom discovery path", async () => {
		const response = await legacyAgentCard({
			url: new URL(`https://tedix.dev${LEGACY_AGENT_CARD_PATH}`),
		} as never);
		expect(response.status).toBe(308);
		expect(response.headers.get("location")).toBe(
			`https://tedix.dev${AGENT_CARD_PATH}`,
		);
	});
});
