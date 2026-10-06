import { describe, expect, it } from "vite-plus/test";
import {
	EXTERNAL_AGENT_SCOPE_LIMIT,
	ExternalAgentSessionExchangeInputSchema,
} from "./external-agent-identity";

const VALID_INPUT = {
	organizationId: "11111111-1111-4111-8111-111111111111",
	principalId: "33333333-3333-4333-8333-333333333333",
	externalSessionKey: "codex:session",
	harness: "codex",
	harnessVersion: "1",
	modelProvider: "openai",
	modelId: "gpt-5.6",
	modelVersion: "2026-08-06",
	scopes: ["mcp:work.read"],
	mcpServerUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
};

describe("external-agent session exchange contract", () => {
	it("accepts the full exact-capability profile", () => {
		expect(
			ExternalAgentSessionExchangeInputSchema.safeParse({
				...VALID_INPUT,
				scopes: Array.from(
					{ length: 31 },
					(_, index) => `mcp:domain_${index}.read`,
				),
			}).success,
		).toBe(true);
	});

	it("rejects profiles above the bounded scope capacity", () => {
		expect(
			ExternalAgentSessionExchangeInputSchema.safeParse({
				...VALID_INPUT,
				scopes: Array.from(
					{ length: EXTERNAL_AGENT_SCOPE_LIMIT + 1 },
					(_, index) => `mcp:domain_${index}.read`,
				),
			}).success,
		).toBe(false);
	});

	it("accepts only the non-secret bootstrap payload", () => {
		expect(
			ExternalAgentSessionExchangeInputSchema.safeParse(VALID_INPUT).success,
		).toBe(true);
		expect(
			ExternalAgentSessionExchangeInputSchema.safeParse({
				...VALID_INPUT,
				rawApiKey: "sk_must_not_be_in_body",
			}).success,
		).toBe(false);
	});
});
