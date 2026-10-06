import { describe, expect, it } from "vite-plus/test";
import type { SessionBrokerRpc } from "./session-broker";
import {
	mountSessionBroker,
	PRODUCT_SESSION_BROKER_POLICIES,
} from "./mount-session-broker";

const INTENT = "intent_123456789012345678901234";

function broker(): SessionBrokerRpc {
	return {
		async createIntent() {
			return {
				authorizeUrl: `https://auth.tedix.dev/tedix/session/authorize?intent=${INTENT}`,
				expiresAt: Math.floor(Date.now() / 1000) + 60,
				intentId: INTENT,
			};
		},
		async exchangeCode() {
			return { kind: "logout" };
		},
	};
}

describe("mountSessionBroker", () => {
	it("keeps OS and CLI product sessions distinct", () => {
		expect(PRODUCT_SESSION_BROKER_POLICIES.os.productCookie).not.toBe(
			PRODUCT_SESSION_BROKER_POLICIES.cli.productCookie,
		);
		expect(mountSessionBroker("os", broker()).productCookie).toBe(
			"__Host-tedix-os-session",
		);
		expect(mountSessionBroker("cli", broker()).productCookie).toBe(
			"__Host-tedix-cli-session",
		);
	});

	it("admits a directory handoff from one OS origin to a tenant OS", async () => {
		const response = await mountSessionBroker("os", broker()).start({
			operation: "issue_session",
			redirectPath: "/workspaces",
			request: new Request(
				"https://beta.os.tedix.dev/auth/session-broker/start",
				{
					headers: {
						Referer: "https://acme.os.tedix.dev/canvas",
						"Sec-Fetch-Site": "same-site",
					},
				},
			),
			tenantId: "T-beta",
		});
		expect(response.status).toBe(302);
	});

	it("rejects the retired Dashboard origin as a tenant OS handoff", async () => {
		const mounted = mountSessionBroker("os", broker());
		const trusted = await mounted.start({
			operation: "issue_session",
			redirectPath: "/",
			request: new Request(
				"https://beta.os.tedix.dev/auth/session-broker/start",
				{
					headers: {
						Referer: "https://app.tedix.dev/organizations/acme",
						"Sec-Fetch-Site": "same-site",
					},
				},
			),
			tenantId: "T-beta",
		});
		expect(trusted.status).toBe(403);

		const rejected = await mounted.start({
			operation: "issue_session",
			redirectPath: "/",
			request: new Request(
				"https://beta.os.tedix.dev/auth/session-broker/start",
				{
					headers: {
						Referer: "https://attacker.example/",
						"Sec-Fetch-Site": "cross-site",
					},
				},
			),
			tenantId: "T-beta",
		});
		expect(rejected.status).toBe(403);
	});

	it("admits an OS directory handoff into a tenant CMS admin", async () => {
		const response = await mountSessionBroker("cms", broker()).start({
			operation: "issue_session",
			redirectPath: "/_emdash/admin",
			request: new Request(
				"https://acme.cms.tedix.dev/_emdash/api/auth/session-broker/start",
				{
					headers: {
						Referer: "https://acme.os.tedix.dev/canvas",
						"Sec-Fetch-Site": "same-site",
					},
				},
			),
			tenantId: "T-acme",
		});
		expect(response.status).toBe(302);
	});

	it("rejects the retired Dashboard origin as a tenant CMS handoff", async () => {
		const response = await mountSessionBroker("cms", broker()).start({
			operation: "issue_session",
			redirectPath: "/_emdash/admin",
			request: new Request(
				"https://acme.cms.tedix.dev/_emdash/api/auth/session-broker/start",
				{
					headers: {
						Referer: "https://app.tedix.dev/organizations/acme",
						"Sec-Fetch-Site": "same-site",
					},
				},
			),
			tenantId: "T-acme",
		});
		expect(response.status).toBe(403);
	});

	it("mounts a distinct host-only Docs session policy", async () => {
		const mounted = mountSessionBroker("docs", broker());
		const trusted = await mounted.start({
			operation: "issue_session",
			redirectPath: "/guide",
			request: new Request(
				"https://acme-help.docs.tedix.dev/auth/session-broker/start",
				{
					headers: {
						Referer: "https://acme-help.docs.tedix.dev/guide",
						"Sec-Fetch-Site": "same-origin",
					},
				},
			),
			tenantId: "T-acme",
		});
		expect(trusted.status).toBe(302);
		expect(mounted.productCookie).toBe("__Host-tedix-docs-session");
	});
});
