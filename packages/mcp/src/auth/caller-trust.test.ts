import { describe, expect, it } from "vite-plus/test";
import {
	CALLER_TRUST_HEADER,
	callerBelongsToOrganization,
	parseCallerTrustTier,
	resolveCallerTrustTier,
	stripMemberOnlyInjectFields,
} from "./caller-trust";

describe("caller trust tier", () => {
	it("exports a stable header contract", () => {
		expect(CALLER_TRUST_HEADER).toBe("x-tedix-caller-trust");
		expect(parseCallerTrustTier("member")).toBe("member");
		expect(parseCallerTrustTier("tedi")).toBe("tedi");
		expect(parseCallerTrustTier("foreign")).toBe("foreign");
		expect(parseCallerTrustTier("owner")).toBeNull();
		expect(parseCallerTrustTier(null)).toBeNull();
	});

	it("tiers a same-org human user, oauth session, and org credential as member", () => {
		for (const authType of [
			"user",
			"oauth",
			"apiKey",
			"m2m",
			"external_agent",
		]) {
			expect(
				resolveCallerTrustTier(
					{ authType, userId: "user_1", organizationId: "org_1" },
					"org_1",
				),
			).toBe("member");
		}
		expect(
			resolveCallerTrustTier(
				{
					authType: "service",
					kernel: true,
					userId: "user_1",
					organizationId: "org_1",
				},
				"org_1",
			),
		).toBe("member");
	});

	it("tiers a same-org tedi credential as tedi", () => {
		expect(
			resolveCallerTrustTier(
				{ authType: "tedi", tediId: "tedi_1", organizationId: "org_1" },
				"org_1",
			),
		).toBe("tedi");
		expect(
			resolveCallerTrustTier(
				{ authType: "service", tediId: "tedi_1", organizationId: "org_1" },
				"org_1",
			),
		).toBe("tedi");
	});

	it("tiers cross-org, unknown-org, and anonymous callers as foreign", () => {
		expect(
			resolveCallerTrustTier(
				{ authType: "user", userId: "user_1", organizationId: "org_2" },
				"org_1",
			),
		).toBe("foreign");
		expect(
			resolveCallerTrustTier(
				{ authType: "tedi", tediId: "tedi_1", organizationId: "org_2" },
				"org_1",
			),
		).toBe("foreign");
		expect(
			resolveCallerTrustTier({ authType: "user", userId: "user_1" }, "org_1"),
		).toBe("foreign");
		expect(
			resolveCallerTrustTier(
				{ authType: "user", userId: "user_1", organizationId: "org_1" },
				undefined,
			),
		).toBe("foreign");
		expect(resolveCallerTrustTier({ authType: "anonymous" }, "org_1")).toBe(
			"foreign",
		);
		expect(resolveCallerTrustTier(undefined, "org_1")).toBe("foreign");
	});

	it("accepts a verified multi-org grant and a platform operator", () => {
		expect(
			resolveCallerTrustTier(
				{
					authType: "oauth",
					userId: "user_1",
					organizationId: "org_home",
					verifiedMultiOrgOrganizations: [{ organizationId: "org_1" }],
				},
				"org_1",
			),
		).toBe("member");
		expect(
			resolveCallerTrustTier(
				{
					authType: "oauth",
					userId: "admin",
					organizationId: "org_platform",
					scopes: ["platform:admin"],
				},
				"org_1",
			),
		).toBe("member");
		expect(
			callerBelongsToOrganization({ organizationId: "org_1" }, "org_1"),
		).toBe(true);
		expect(
			callerBelongsToOrganization({ organizationId: "org_1" }, undefined),
		).toBe(false);
	});

	it("strips learning_mode and metadata unless the caller is a member", () => {
		const params = { text: "hi", learning_mode: "off", metadata: { a: 1 } };
		expect(stripMemberOnlyInjectFields(params, "member")).toEqual(params);
		expect(stripMemberOnlyInjectFields(params, "tedi")).toEqual({ text: "hi" });
		expect(stripMemberOnlyInjectFields(params, "foreign")).toEqual({
			text: "hi",
		});
		expect(params.learning_mode).toBe("off");
	});
});
