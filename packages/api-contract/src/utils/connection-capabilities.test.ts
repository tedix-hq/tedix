import { describe, expect, it } from "vite-plus/test";
import {
	ConnectionCapabilitySchema,
	type ConnectionProvider,
} from "../schemas/connections";
import {
	buildConnectionSetupUrl,
	projectConnectionCapabilities,
} from "./connection-capabilities";

const provider: ConnectionProvider = {
	appId: "mail",
	name: "Mail",
	description: null,
	enabled: true,
	availableScopes: [],
	logoUrl: null,
	connectionType: "oauth",
	registrationMode: "pre_registered",
	tokenScope: "tenant",
	supportedScopes: ["tenant", "user"],
	recommendedScope: "tenant",
	referencedByOrg: true,
	credentialProfile: {
		scopeGroups: [
			{ id: "read", label: "Read", scopes: ["mail.read"] },
			{ id: "send", label: "Send", scopes: ["mail.send"] },
		],
	},
};
const connected = {
	provider,
	scope: "tenant" as const,
	accountState: "present" as const,
	connection: {
		appId: "mail",
		providerName: "Mail",
		status: "connected" as const,
		connectedAt: null,
		tokenExpiresAt: null,
		scopes: ["mail.read"],
		tokenScope: "tenant" as const,
	},
};

describe("connection capability projection", () => {
	it("separates read and send from actual grants without requiring advertised scopes", () => {
		expect(
			projectConnectionCapabilities(connected).map((c) => c.state),
		).toEqual(["connected", "not_configured"]);
	});
	it("links every unconfigured capability to exact provider, scope and required grant", () => {
		for (const scope of ["tenant", "user"] as const) {
			for (const capability of projectConnectionCapabilities({
				...connected,
				scope,
				accountState: "missing",
				connection: null,
				connectionInstanceId: "slot",
			})) {
				const url = new URL(capability.setupUrl, "https://example.test");
				expect(url.pathname).toBe(
					scope === "user" ? "/account/connections" : "/admin/connections",
				);
				expect(url.searchParams.get("connect")).toBe("mail");
				expect(url.searchParams.get("scopes")).toBe(
					capability.requiredScopes.join(","),
				);
				expect(url.searchParams.get("connectionInstanceId")).toBe("slot");
				expect(
					ConnectionCapabilitySchema.safeParse({
						...capability,
						setupUrl: undefined,
					}).success,
				).toBe(false);
			}
		}
	});
	it("distinguishes expired credentials, unsupported ownership and unavailable verification", () => {
		expect(
			projectConnectionCapabilities({
				...connected,
				accountState: "expired",
			}).every((c) => c.state === "needs_reauth"),
		).toBe(true);
		expect(
			projectConnectionCapabilities({
				...connected,
				provider: { ...provider, supportedScopes: ["tenant"] },
				scope: "user",
			}).every((c) => c.state === "not_supported"),
		).toBe(true);
		expect(
			projectConnectionCapabilities({
				...connected,
				accountState: "unknown",
				connection: null,
			}).every((c) => !c.verified && c.state !== "connected"),
		).toBe(true);
	});
	it("encodes untrusted provider selectors in internal setup links", () => {
		const url = new URL(
			buildConnectionSetupUrl({
				providerId: "a&connect=other",
				scopes: ["read write"],
			}),
			"https://example.test",
		);
		expect(url.searchParams.get("connect")).toBe("a&connect=other");
		expect(url.searchParams.get("scopes")).toBe("read write");
	});
});
