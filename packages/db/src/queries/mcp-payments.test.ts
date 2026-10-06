// @ts-nocheck - package test type dependencies are not part of the db tsconfig.
import { describe, expect, it } from "vite-plus/test";
import { sumSettledMcpPaymentAmount } from "./mcp-payments";

describe("sumSettledMcpPaymentAmount", () => {
	it("requires an organization scope for budget spend sums", async () => {
		await expect(
			sumSettledMcpPaymentAmount({} as never, {
				organizationId: "",
				appSlug: "tedix-unified",
				currency: "USDC",
				network: "solana-devnet",
				since: "2026-05-11 00:00:00",
				tediId: "5eed0038-0000-4000-8000-000000000038",
			}),
		).rejects.toThrow(
			"organizationId is required when summing MCP payment budget spend",
		);
	});
});
