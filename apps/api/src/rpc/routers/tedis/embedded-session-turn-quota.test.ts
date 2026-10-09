import { describe, expect, it, vi } from "vite-plus/test";
import { verifyGatewayBrowserToken } from "@tedix/auth/gateway-browser-token";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({ getOrganization: vi.fn() }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.getOrganization,
	getOrganizationByDescopeId: vi.fn(),
}));
vi.mock("./helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("./helpers")>()),
	getProvisioningConfig: () => ({
		workerUrl: "https://acme-operator.tedi.example",
	}),
}));

import { issueEmbeddedSession } from "./gateway";

const TEDI = "55555555-5555-4555-8555-555555555555";
const ORG = "22222222-2222-4222-8222-222222222222";
const SECRET = "quota-secret";
const tedi = { id: TEDI, organizationId: ORG, slug: "acme-operator" } as never;
const context = {
	env: { SECRETS_MASTER_KEY: SECRET },
} as unknown as BaseContext;
const input = {
	allowedOrigin: "https://staging.acme.example",
	conversationId: "11111111-1111-4111-8111-111111111111",
	hostOrganizationId: "8042",
	hostUserId: "6190",
};
const organization = (tediWidget?: Record<string, unknown>) => ({
	id: ORG,
	descopeTenantId: "tenant-acme",
	metadata: tediWidget ? { tediWidget } : {},
});
const claimsOf = async (token: string) =>
	verifyGatewayBrowserToken(token, { expectedTediId: TEDI, secret: SECRET });

describe("embedded session turn quota claims", () => {
	it("omits the ceilings when nothing is configured, so the runtime applies its defaults", async () => {
		mocks.getOrganization.mockResolvedValue(organization());
		const claims = await claimsOf(
			(await issueEmbeddedSession(context, tedi, input)).token,
		);
		expect(claims.visitorTurnsPerHour).toBeUndefined();
		expect(claims.originTurnsPerHour).toBeUndefined();
	});

	it("signs the customer organization's widget config into the session", async () => {
		mocks.getOrganization.mockResolvedValue(
			organization({
				version: 1,
				turnQuota: { visitorTurnsPerHour: 20, originTurnsPerHour: 300 },
			}),
		);
		const claims = await claimsOf(
			(await issueEmbeddedSession(context, tedi, input)).token,
		);
		expect(claims.visitorTurnsPerHour).toBe(20);
		expect(claims.originTurnsPerHour).toBe(300);
	});

	it("lets an installation-level quota override the organization's, field by field", async () => {
		mocks.getOrganization.mockResolvedValue(
			organization({
				version: 1,
				turnQuota: { visitorTurnsPerHour: 20, originTurnsPerHour: 300 },
			}),
		);
		const claims = await claimsOf(
			(
				await issueEmbeddedSession(context, tedi, {
					...input,
					turnQuota: { visitorTurnsPerHour: 5 },
				})
			).token,
		);
		expect(claims.visitorTurnsPerHour).toBe(5);
		// The installation policy is the whole policy: an unset field there
		// means the runtime default, not the organization's number.
		expect(claims.originTurnsPerHour).toBeUndefined();
	});
});
