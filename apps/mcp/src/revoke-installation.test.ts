import { afterEach, expect, it, vi } from "vite-plus/test";
import { revokeInstallation } from "./revoke-installation";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@tedix/api-client/internal", () => ({
	callRpc: rpc,
	serviceBindingFetch: (binding: unknown) => binding,
}));
afterEach(() => vi.resetAllMocks());

it("forwards a revocation proof only for the requested resource through the service binding", async () => {
	rpc.mockResolvedValue({ revoked: true });
	const binding = { fetch: vi.fn() };
	const request = new Request("https://connect.example.test/mcp/revoke", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			resourceUrl: "https://other.example/mcp",
			accessToken: "signed-proof",
			refreshToken: "refresh-token",
		}),
	});
	expect(
		await (
			await revokeInstallation(request, {
				API_SERVICE: binding,
			} as unknown as CloudflareEnv)
		).json(),
	).toEqual({ revoked: true });
	expect(rpc).toHaveBeenCalledWith(
		"organizations/revokeMcpInstallation",
		{
			resourceUrl: "https://connect.example.test/mcp",
			accessToken: "signed-proof",
			refreshToken: "refresh-token",
		},
		expect.objectContaining({
			fetch: binding,
			headers: { "X-Service-Binding": "true" },
		}),
	);
	rpc.mockRejectedValueOnce(new Error("provider unavailable"));
	expect(
		(
			await revokeInstallation(
				new Request(request.url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						accessToken: "proof",
						refreshToken: "refresh",
					}),
				}),
				{ API_SERVICE: binding } as unknown as CloudflareEnv,
			)
		).status,
	).toBe(503);
});
