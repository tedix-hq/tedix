import { createRouterClient } from "@orpc/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import * as providers from "@tedix/db/queries/connection-providers";
import * as auth from "@tedix/auth/connection-providers";
import * as connectionDiscovery from "@tedix/auth/connection-discovery";
import * as policy from "./policy-resolution";
import * as discovery from "./provider-discovery";
import * as registration from "./provider-registration";
import { userContext } from "../../test-context";
import { createProviderFromMcp } from "./provider-management";
import { createProvider } from "./credentials-tedi";

const router = { createProvider, createProviderFromMcp };
const admin = () =>
	createRouterClient(router, {
		context: userContext({
			userRole: "admin",
			permissions: ["integrations:manage"],
		}),
	});

const reviewBy = new Date(Date.now() + 90 * 86_400_000)
	.toISOString()
	.slice(0, 10);
const dcrException = {
	justification: "Upstream offers no client ID metadata document support.",
	reviewBy,
};

function discovered(mode: "cimd" | "dcr") {
	return {
		config: {
			name: "Example MCP",
			authorizationUrl: "https://auth.example.com/authorize",
			tokenUrl: "https://auth.example.com/token",
			pkce: true,
			...(mode === "cimd"
				? { clientId: "https://tedix.example/client.json", useDcr: false }
				: { useDcr: true, dcrUrl: "https://auth.example.com/register" }),
		},
		discovery: {
			mcpEndpointUrl: "https://mcp.example.com/mcp",
			protectedResourceMetadataUrl: null,
			resource: "https://mcp.example.com/mcp",
			authorizationServer: "https://auth.example.com",
			authorizationServerMetadataUrl:
				"https://auth.example.com/.well-known/oauth-authorization-server",
			authorizationUrl: "https://auth.example.com/authorize",
			tokenUrl: "https://auth.example.com/token",
			revocationUrl: null,
			registrationMode: mode,
			clientIdMetadataDocumentSupported: mode === "cimd",
			dcrUrl: mode === "cimd" ? null : "https://auth.example.com/register",
			scopesSupported: [],
			authorizationServerScopesSupported: [],
			codeChallengeMethodsSupported: ["S256"],
			tokenEndpointAuthMethodsSupported: ["client_secret_post"],
			authorizationResponseIssParameterSupported: true,
		},
		warnings: [],
	} as never;
}

let upsert: ReturnType<typeof vi.spyOn>;
let register: ReturnType<typeof vi.spyOn>;
let record: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.spyOn(discovery, "resolveConnectionProviderTemplate").mockResolvedValue(
		undefined,
	);
	vi.spyOn(policy, "enforceConnectionProviderIssuerPin").mockResolvedValue(
		undefined as never,
	);
	vi.spyOn(providers, "pinConnectionProviderIssuer").mockResolvedValue();
	vi.spyOn(providers, "createConnectionProviderOwnership").mockResolvedValue();
	vi.spyOn(registration, "loadExistingStaticOAuthProvider").mockResolvedValue(
		null,
	);
	record = vi
		.spyOn(providers, "recordConnectionProviderRegistration")
		.mockResolvedValue();
	upsert = vi
		.spyOn(auth, "upsertConnectionProviderWithId")
		.mockImplementation(async (id) => ({ id, status: "created" }));
	register = vi
		.spyOn(registration, "registerMcpOAuthClientForDescope")
		.mockResolvedValue({
			clientId: "dcr-client",
			clientSecret: "dcr-secret",
			tokenEndpointAuthMethod: "client_secret_post",
		});
});
afterEach(() => vi.restoreAllMocks());

describe("DCR only as a recorded exception", () => {
	it("refuses a provider without CIMD support before anything is registered", async () => {
		vi.spyOn(
			connectionDiscovery,
			"discoverMcpConnectionProvider",
		).mockResolvedValue(discovered("dcr"));
		for (const exception of [
			undefined,
			{ ...dcrException, reviewBy: "2020-01-01" },
			{
				...dcrException,
				reviewBy: new Date(Date.now() + 400 * 86_400_000)
					.toISOString()
					.slice(0, 10),
			},
		]) {
			await expect(
				admin().createProviderFromMcp({
					mcpEndpointUrl: "https://mcp.example.com/mcp",
					connectionType: "oauth",
					...(exception ? { dcrException: exception } : {}),
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		await expect(
			admin().createProviderFromMcp({
				mcpEndpointUrl: "https://mcp.example.com/mcp",
				connectionType: "oauth",
				staticOAuthClientPolicy: "re_register_static",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(upsert).not.toHaveBeenCalled();
		expect(register).not.toHaveBeenCalled();
		expect(record).not.toHaveBeenCalled();
	});

	it("records the exception on the Descope-managed and the direct fallback path", async () => {
		vi.spyOn(
			connectionDiscovery,
			"discoverMcpConnectionProvider",
		).mockResolvedValue(discovered("dcr"));
		const managed = await admin().createProviderFromMcp({
			mcpEndpointUrl: "https://mcp.example.com/mcp",
			connectionType: "oauth",
			dcrException,
		});
		expect(register).not.toHaveBeenCalled();
		expect(record).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: managed.appId,
				provenance: "dcr_managed",
				dcrException: expect.objectContaining({
					...dcrException,
					recordedAt: expect.any(String),
				}),
			}),
		);

		upsert
			.mockRejectedValueOnce(new Error("E152006 dynamic client registration"))
			.mockImplementation(async (id: string) => ({ id, status: "created" }));
		const direct = await admin().createProviderFromMcp({
			mcpEndpointUrl: "https://mcp.example.com/mcp",
			connectionType: "oauth",
			dcrException,
		});
		expect(register).toHaveBeenCalledTimes(1);
		// Stored as useDcr:false, but recorded as a dynamically registered client.
		expect(upsert).toHaveBeenLastCalledWith(
			direct.appId,
			expect.objectContaining({ clientId: "dcr-client", useDcr: false }),
			expect.anything(),
		);
		expect(record).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: direct.appId,
				provenance: "dcr_direct",
				dcrException: expect.objectContaining(dcrException),
			}),
		);
	});

	it("records a CIMD provider without an exception", async () => {
		vi.spyOn(
			connectionDiscovery,
			"discoverMcpConnectionProvider",
		).mockResolvedValue(discovered("cimd"));
		const result = await admin().createProviderFromMcp({
			mcpEndpointUrl: "https://mcp.example.com/mcp",
			connectionType: "oauth",
		});
		expect(record).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: result.appId,
				provenance: "cimd",
				dcrException: null,
			}),
		);
	});

	it("requires the exception for an explicit useDcr provider and records it", async () => {
		const create = vi
			.spyOn(auth, "createConnectionProvider")
			.mockResolvedValue({ id: "explicit-dcr" });
		const config = {
			name: "Explicit",
			type: "oauth" as const,
			useDcr: true,
			dcrUrl: "https://auth.example.com/register",
		};
		await expect(admin().createProvider(config)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(create).not.toHaveBeenCalled();
		await admin().createProvider({ ...config, dcrException });
		expect(create).toHaveBeenCalledWith(
			expect.anything(),
			expect.not.objectContaining({ dcrException: expect.anything() }),
		);
		expect(record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: "explicit-dcr",
				provenance: "dcr_managed",
				dcrException: expect.objectContaining(dcrException),
			}),
		);
	});
});
