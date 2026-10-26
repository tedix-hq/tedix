import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ callApiRpc: vi.fn() }));
vi.mock("../lib/rpc", () => ({ callApiRpc: mocks.callApiRpc }));

const { attachExchangedToken } = await import("./token-exchange-pilot");

const tediHeaders = () => ({
	"X-Tedix-Tedi-Id": "00000000-0000-4000-8000-0000000000d1",
	"X-Tedix-Tedi-Scopes": "mcp:tedis.read tedis:read",
	"X-Tedix-Mcp-Tool-Id": "tedis__get_tedi",
	"X-Tedix-Org-Id": "00000000-0000-4000-8000-0000000000c1",
});
const input = (
	overrides: Partial<Parameters<typeof attachExchangedToken>[0]> = {},
) => ({
	env: { TOKEN_EXCHANGE_PILOT: "on" } as never,
	endpoint: "tedis/get",
	toolId: "tedis__get_tedi",
	config: { endpoint: "tedis/get" },
	headers: tediHeaders() as Record<string, string>,
	serviceBinding: true,
	callerOrganizationId: "00000000-0000-4000-8000-0000000000c1",
	...overrides,
});

beforeEach(() => {
	mocks.callApiRpc.mockReset().mockResolvedValue({
		status: 200,
		data: { accessToken: "exchanged.jwt.value" },
	});
});

describe("token exchange pilot at the MCP edge", () => {
	it.each([
		["the pilot is off", { env: {} as never }],
		["the call is not over the service binding", { serviceBinding: false }],
		["the caller is not a tedi", { headers: {} }],
		[
			"no tedi scopes are forwarded",
			{
				headers: {
					"X-Tedix-Tedi-Id": "00000000-0000-4000-8000-0000000000d1",
					"X-Tedix-Org-Id": "00000000-0000-4000-8000-0000000000c1",
				},
			},
		],
		[
			"a platform tedi addresses another organization",
			{ callerOrganizationId: "00000000-0000-4000-8000-0000000000c2" },
		],
		[
			"an external agent is calling",
			{
				headers: {
					...tediHeaders(),
					"X-Tedix-Caller-Type": "mcp-edge-external-agent",
				},
			},
		],
	] as const)("does nothing when %s", async (_label, overrides) => {
		const call = input(overrides as never);
		await expect(attachExchangedToken(call)).resolves.toBe(false);
		expect(mocks.callApiRpc).not.toHaveBeenCalled();
		expect(call.headers["X-Tedix-Exchanged-Token"]).toBeUndefined();
	});

	it("asks the broker for this procedure and the tool's scopes, then attaches the token", async () => {
		const call = input();
		await expect(attachExchangedToken(call)).resolves.toBe(true);
		expect(mocks.callApiRpc).toHaveBeenCalledWith(
			expect.anything(),
			"tokenExchange/exchange",
			{ endpoint: "tedis/get", scopes: expect.any(Array) },
			expect.objectContaining({ serviceBinding: true }),
		);
		const scopes = mocks.callApiRpc.mock.calls[0]![2].scopes as string[];
		expect(scopes.length).toBeGreaterThan(0);
		expect(scopes.every((scope) => scope.startsWith("mcp:"))).toBe(true);
		expect(call.headers["X-Tedix-Exchanged-Token"]).toBe("exchanged.jwt.value");
	});

	it("never forwards a previous token to the broker", async () => {
		const call = input({
			headers: { ...tediHeaders(), "X-Tedix-Exchanged-Token": "stale" },
		});
		await attachExchangedToken(call);
		const sent = mocks.callApiRpc.mock.calls[0]![3].headers as Record<
			string,
			string
		>;
		expect(sent["X-Tedix-Exchanged-Token"]).toBeUndefined();
	});

	it("sends no token while the API side of the pilot is off", async () => {
		mocks.callApiRpc.mockResolvedValue({ status: 404, data: {} });
		const call = input();
		await expect(attachExchangedToken(call)).resolves.toBe(false);
		expect(call.headers["X-Tedix-Exchanged-Token"]).toBeUndefined();
	});

	it("refuses the call when the broker refuses", async () => {
		mocks.callApiRpc.mockResolvedValue({ status: 403, data: {} });
		await expect(attachExchangedToken(input())).rejects.toMatchObject({
			name: "TokenExchangePilotError",
		});
	});
});
