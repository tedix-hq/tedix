import { describe, expect, it } from "vite-plus/test";
import {
	EARNED_DELEGATION_GOVERN_SCOPE,
	earnedDelegationEvidenceReviewerActor,
	governanceAuthorityActor,
	hasEarnedDelegationGovernanceAuthority,
	humanDispositionActor,
} from "./earned-delegation-access";

type AuthorityContext = Parameters<
	typeof hasEarnedDelegationGovernanceAuthority
>[0];
type ActorContext = Parameters<typeof governanceAuthorityActor>[0];

function authorityContext(
	overrides: Partial<AuthorityContext>,
): AuthorityContext {
	return {
		apiKey: undefined,
		authType: undefined,
		user: undefined,
		userRole: undefined,
		...overrides,
	};
}

function actorContext(overrides: Partial<ActorContext>): ActorContext {
	return {
		apiKey: undefined,
		authType: undefined,
		organizationId: undefined,
		user: undefined,
		userRole: undefined,
		...overrides,
	};
}

describe("earned delegation governance access", () => {
	it("allows only privileged humans or platform principals", () => {
		expect(
			hasEarnedDelegationGovernanceAuthority(
				authorityContext({ authType: "user", userRole: "owner" }),
			),
		).toBe(true);
		expect(
			hasEarnedDelegationGovernanceAuthority(
				authorityContext({ authType: "user", userRole: "admin" }),
			),
		).toBe(true);
		expect(
			hasEarnedDelegationGovernanceAuthority(
				authorityContext({ authType: "user", userRole: "member" }),
			),
		).toBe(false);
		expect(
			hasEarnedDelegationGovernanceAuthority(
				authorityContext({
					authType: "user",
					userRole: "member",
					user: { roles: ["platform-admin"] } as never,
				}),
			),
		).toBe(true);
	});

	it("requires a dedicated or platform scope for API keys", () => {
		for (const scope of [
			EARNED_DELEGATION_GOVERN_SCOPE,
			"platform:admin",
			"*",
		]) {
			expect(
				hasEarnedDelegationGovernanceAuthority(
					authorityContext({
						authType: "apikey",
						apiKey: { scopes: [scope] } as never,
					}),
				),
			).toBe(true);
		}
		expect(
			hasEarnedDelegationGovernanceAuthority(
				authorityContext({
					authType: "apikey",
					apiKey: { scopes: ["work:write"] } as never,
				}),
			),
		).toBe(false);
	});

	it("fails closed for machine and tedi auth modes", () => {
		for (const authType of [
			"tedi",
			"m2m",
			"service",
			"service-binding",
		] as const) {
			expect(
				hasEarnedDelegationGovernanceAuthority(authorityContext({ authType })),
			).toBe(false);
		}
	});

	it("uses the user subject and organization root as stable disposer identities", () => {
		expect(
			governanceAuthorityActor(
				actorContext({
					authType: "user",
					userRole: "owner",
					user: { sub: "user-1" } as never,
				}),
			),
		).toEqual({ type: "user", id: "user-1" });

		for (const keyId of ["key-1", "key-2"]) {
			expect(
				governanceAuthorityActor(
					actorContext({
						authType: "apikey",
						organizationId: "org-1",
						apiKey: {
							id: keyId,
							scopes: [EARNED_DELEGATION_GOVERN_SCOPE],
						} as never,
					}),
				),
			).toEqual({ type: "api_key", id: "organization:org-1" });
		}
	});

	it("does not mint an actor without a stable subject or organization", () => {
		expect(
			governanceAuthorityActor(
				actorContext({ authType: "user", userRole: "owner" }),
			),
		).toBeNull();
		expect(
			governanceAuthorityActor(
				actorContext({
					authType: "apikey",
					apiKey: {
						scopes: [EARNED_DELEGATION_GOVERN_SCOPE],
					} as never,
				}),
			),
		).toBeNull();
	});

	it("never permits an API key to dispose authority", () => {
		expect(
			humanDispositionActor(
				actorContext({
					authType: "apikey",
					organizationId: "org-1",
					apiKey: {
						id: "key-1",
						scopes: [EARNED_DELEGATION_GOVERN_SCOPE],
					} as never,
				}),
			),
		).toBeNull();
	});

	it("accepts a stable external-agent principal for evidence review only", () => {
		expect(
			earnedDelegationEvidenceReviewerActor({
				apiKey: undefined,
				authType: "service-binding",
				externalAgentPrincipalId: "external-principal-1",
				organizationId: "org-1",
				user: undefined,
				userRole: undefined,
			}),
		).toEqual({
			type: "external_agent",
			id: "external-principal-1",
		});
		expect(
			hasEarnedDelegationGovernanceAuthority(
				authorityContext({ authType: "service-binding" }),
			),
		).toBe(false);
		expect(
			humanDispositionActor(actorContext({ authType: "service-binding" })),
		).toBeNull();
	});
});
