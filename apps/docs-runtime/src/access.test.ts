import { validateToken } from "@tedix/auth/jwt";
import type { SessionBrokerRpc } from "@tedix/auth/session-broker";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { authorizeDocsSiteRequest, handleDocsSessionBroker } from "./access";
import { contentFreeDocsException, docsLogger } from "./log";
import type { RuntimeDocsSite } from "./serving";

vi.mock("@tedix/auth/jwt", () => ({ validateToken: vi.fn() }));

const validate = vi.mocked(validateToken);
const env = {
	DESCOPE_PROJECT_ID: "project",
	DESCOPE_BASE_URL: "https://auth.tedix.dev",
};
const site: RuntimeDocsSite = {
	id: "site-1",
	orgSlug: "tedix",
	slug: "acme-help",
	status: "active",
	accessMode: "organization",
	activeBuildId: "build-1",
	descopeTenantId: "org_tedix",
};

describe("organization Docs access", () => {
	beforeEach(() => validate.mockReset());

	it("redirects an anonymous browser through the host-local session broker", async () => {
		const response = await authorizeDocsSiteRequest(
			new Request("https://acme-help.docs.tedix.dev/guide"),
			env,
			site,
		);
		expect(response?.status).toBe(302);
		const location = new URL(response?.headers.get("Location") ?? "");
		expect(location.origin + location.pathname).toBe(
			"https://acme-help.docs.tedix.dev/auth/session-broker/start",
		);
		expect(location.searchParams.get("redirect_to")).toBe("/guide");
	});

	it("accepts a valid session only for the site's organization", async () => {
		validate.mockResolvedValue({
			dct: "org_tedix",
			iat: 1,
			exp: 2,
			iss: "issuer",
			aud: "project",
		});
		await expect(
			authorizeDocsSiteRequest(
				new Request("https://acme-help.docs.tedix.dev/", {
					headers: { Cookie: "__Host-tedix-docs-session=valid-session" },
				}),
				env,
				site,
			),
		).resolves.toBeNull();
	});

	it("rejects a bearer token scoped to another organization", async () => {
		validate.mockResolvedValue({
			dct: "org_other",
			iat: 1,
			exp: 2,
			iss: "issuer",
			aud: "project",
		});
		const response = await authorizeDocsSiteRequest(
			new Request("https://acme-help.docs.tedix.dev/", {
				headers: { Authorization: "Bearer other-session" },
			}),
			env,
			site,
		);
		expect(response?.status).toBe(403);
	});

	it("keeps credential content out of structured failure diagnostics", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			docsLogger.error("Private docs session validation failed", {
				event: "docs.session.validation_failed",
				siteId: site.id,
				failure: contentFreeDocsException(
					new TypeError("bearer-secret", {
						cause: new RangeError("session-secret"),
					}),
				),
			});
			expect(log).toHaveBeenCalledWith({
				component: "docs-runtime",
				message: "Private docs session validation failed",
				event: "docs.session.validation_failed",
				siteId: "site-1",
				failure: { name: "TypeError", cause: { name: "RangeError" } },
			});
			expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|key=|stack/i);
		} finally {
			log.mockRestore();
		}
	});
});

describe("Docs session broker", () => {
	it("derives the tenant from the resolved site and keeps the return path same-origin", async () => {
		const createIntent = vi.fn(async () => ({
			authorizeUrl:
				"https://auth.tedix.dev/tedix/session/authorize?intent=intent_123456789012345678901234",
			expiresAt: Math.floor(Date.now() / 1000) + 60,
			intentId: "intent_123456789012345678901234",
		}));
		const broker: SessionBrokerRpc = {
			createIntent,
			exchangeCode: vi.fn(),
		};
		const response = await handleDocsSessionBroker(
			new Request(
				"https://acme-help.docs.tedix.dev/auth/session-broker/start?tenant_id=attacker&redirect_to=%2Fguide%3Ftab%3Dapi",
				{ headers: { "Sec-Fetch-Site": "same-origin" } },
			),
			{ ...env, DOCS_SESSION_BROKER: broker },
			site,
		);

		expect(response?.status).toBe(302);
		expect(createIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				redirectPath: "/guide?tab=api",
				targetOrigin: "https://acme-help.docs.tedix.dev",
				tenantId: "org_tedix",
			}),
		);
	});
});
