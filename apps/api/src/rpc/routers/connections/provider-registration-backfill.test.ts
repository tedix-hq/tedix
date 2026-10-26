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
import { TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID } from "@tedix/auth/oauth-client-registration";
import { apiKeyContext, userContext } from "../../test-context";
import { auditOutboundAppRecord } from "./provider-discovery";

const mocks = vi.hoisted(() => ({ loadAllApplications: vi.fn() }));
vi.mock("../../../lib/descope-management", () => ({
	getDescopeManagement: () => ({
		management: {
			outboundApplication: {
				loadAllApplications: mocks.loadAllApplications,
			},
		},
	}),
}));

const { recordProviderRegistration } = await import("./discovery-user");

const reviewBy = new Date(Date.now() + 90 * 86_400_000)
	.toISOString()
	.slice(0, 10);
const dcrException = {
	justification: "Upstream offers no client ID metadata document support.",
	reviewBy,
};
const apps = [
	{
		id: "dcr-app",
		name: "Video MCP",
		useDcr: true,
		authorizationUrl: "https://a.example/authorize",
	},
	{
		id: "static-app",
		name: "Search MCP",
		clientId: "static-1",
		authorizationUrl: "https://b.example/authorize",
	},
	{
		id: "cimd-app",
		name: "Crawl MCP",
		clientId: TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID,
		authorizationUrl: "https://c.example/authorize",
	},
];

const operator = () =>
	createRouterClient(
		{ record: recordProviderRegistration },
		{ context: apiKeyContext({ scopes: ["platform:admin"] }) },
	);

let record: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	mocks.loadAllApplications.mockResolvedValue({ ok: true, data: apps });
	vi.spyOn(providers, "listConnectionProviders").mockResolvedValue([]);
	record = vi
		.spyOn(providers, "recordConnectionProviderRegistration")
		.mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe("recording registration provenance for existing providers", () => {
	it("records a DCR provider with a fresh exception", async () => {
		await expect(
			operator().record({
				appId: "dcr-app",
				provenance: "dcr_managed",
				dcrException,
			}),
		).resolves.toEqual({
			appId: "dcr-app",
			providerId: "dcr-app",
			provenance: "dcr_managed",
			dcrReviewBy: reviewBy,
		});
		expect(record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: "dcr-app",
				provenance: "dcr_managed",
				dcrException: expect.objectContaining({ reviewBy }),
			}),
		);
	});

	it.each([
		[
			"a DCR provenance without an exception",
			{ appId: "dcr-app", provenance: "dcr_managed" },
		],
		[
			"a past review date",
			{
				appId: "dcr-app",
				provenance: "dcr_managed",
				dcrException: { ...dcrException, reviewBy: "2020-01-01" },
			},
		],
		[
			"a provenance the Descope app contradicts",
			{ appId: "dcr-app", provenance: "pre_registered" },
		],
		[
			"claiming CIMD for a static client",
			{ appId: "static-app", provenance: "cimd" },
		],
		[
			"an exception on a non-DCR provenance",
			{ appId: "cimd-app", provenance: "cimd", dcrException },
		],
		["an unknown app", { appId: "missing", provenance: "cimd" }],
	] as const)("refuses %s", async (_label, input) => {
		await expect(operator().record(input as never)).rejects.toBeDefined();
		expect(record).not.toHaveBeenCalled();
	});

	it("accepts a static client as direct DCR only with an exception", async () => {
		await operator().record({
			appId: "static-app",
			provenance: "dcr_direct",
			dcrException,
		});
		expect(record).toHaveBeenCalledTimes(1);
	});

	it("refuses anyone without platform authority", async () => {
		const client = createRouterClient(
			{ record: recordProviderRegistration },
			{
				context: userContext({
					userRole: "admin",
					permissions: ["integrations:manage", "settings:manage"],
				}),
			},
		);
		await expect(
			client.record({ appId: "cimd-app", provenance: "cimd" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(record).not.toHaveBeenCalled();
	});
});

describe("DCR exception audit", () => {
	const dcrApp = { id: "dcr-app", name: "Video MCP", useDcr: true };
	const template = (exception?: { reviewBy: string }) =>
		({
			id: "dcr-app",
			name: "Video MCP",
			description: "",
			icon: "",
			category: "infrastructure",
			type: "oauth",
			requiredScopes: [],
			supportedScopes: ["tenant", "user"],
			recommendedScope: "user",
			registrationProvenance: "dcr_managed",
			...(exception
				? {
						dcrException: {
							justification: dcrException.justification,
							reviewBy: exception.reviewBy,
							recordedAt: "2026-01-01T00:00:00.000Z",
							recordedBy: null,
						},
					}
				: {}),
		}) as const;
	const codes = (result: ReturnType<typeof auditOutboundAppRecord>) =>
		result.issues.map((issue) => issue.code);

	it("warns when a DCR provider has no exception", () => {
		const result = auditOutboundAppRecord({
			app: dcrApp,
			referencedByOrg: true,
			today: "2026-10-26",
		});
		expect(codes(result)).toContain("dcr_exception_missing");
		expect(result.settings.dcrReviewBy).toBeNull();
	});

	it("reports the review date and warns only once it has passed", () => {
		const current = auditOutboundAppRecord({
			app: dcrApp,
			referencedByOrg: true,
			providerTemplate: template({ reviewBy: "2026-10-26" }) as never,
			today: "2026-10-26",
		});
		expect(current.settings).toMatchObject({
			registrationProvenance: "dcr_managed",
			dcrReviewBy: "2026-10-26",
		});
		expect(codes(current)).not.toContain("dcr_exception_review_overdue");
		const overdue = auditOutboundAppRecord({
			app: dcrApp,
			referencedByOrg: true,
			providerTemplate: template({ reviewBy: "2026-10-25" }) as never,
			today: "2026-10-26",
		});
		expect(codes(overdue)).toContain("dcr_exception_review_overdue");
		expect(codes(overdue)).not.toContain("dcr_exception_missing");
	});

	it("flags a static client recorded as direct DCR", () => {
		const result = auditOutboundAppRecord({
			app: { id: "static-app", name: "Search MCP", clientId: "static-1" },
			referencedByOrg: true,
			providerTemplate: {
				...template(),
				registrationProvenance: "dcr_direct",
			} as never,
			today: "2026-10-26",
		});
		expect(codes(result)).toContain("dcr_exception_missing");
	});
});
