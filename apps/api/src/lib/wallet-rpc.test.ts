import { describe, expect, it } from "vite-plus/test";
import { walletRpc } from "./wallet-rpc";

describe("walletRpc", () => {
	it("calls the organization's wallet object directly with the MCP Worker's request", async () => {
		const seen: { name?: string; url?: string; body?: string } = {};
		const WALLET = {
			idFromName: (name: string) => {
				seen.name = name;
				return name;
			},
			get: () => ({
				fetch: async (url: string, init: RequestInit) => {
					seen.url = url;
					seen.body = init.body as string;
					return Response.json({ allowed: true });
				},
			}),
		} as unknown as DurableObjectNamespace;
		const result = await walletRpc({ WALLET }).wallet("org-1", "release", {
			holdId: "hold-1",
		});
		expect(result).toEqual({ allowed: true });
		// The same object the MCP Worker's walletStub addresses.
		expect(seen).toEqual({
			name: "wallet:v1:org-1",
			url: "https://wallet.internal/wallet/release",
			body: JSON.stringify({ holdId: "hold-1" }),
		});
	});

	it("fails on a wallet error status and falls back to the MCP Worker without the binding", async () => {
		const WALLET = {
			idFromName: (name: string) => name,
			get: () => ({ fetch: async () => new Response("no", { status: 503 }) }),
		} as unknown as DurableObjectNamespace;
		await expect(
			walletRpc({ WALLET }).wallet("org-1", "budget-spend", { budgetIds: [] }),
		).rejects.toThrow("Wallet status 503");
		const MCP_SERVICE = { wallet: async () => "via mcp" };
		expect(
			await walletRpc({ MCP_SERVICE }).wallet("org-1", "release", {
				holdId: "h",
			}),
		).toBe("via mcp");
		expect(() => walletRpc({})).toThrow("WALLET or MCP_SERVICE");
	});
});
