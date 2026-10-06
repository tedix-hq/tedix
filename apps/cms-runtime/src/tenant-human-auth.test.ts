import { describe, expect, it } from "vite-plus/test";
import {
	CMS_HUMAN_ASSERTION_HEADER,
	CMS_HUMAN_IDENTITY_HEADER,
	deriveTenantHumanAuthKey,
	forwardCmsHumanAssertion,
	hasAttestedCmsHumanIdentity,
	mintCmsHumanAssertion,
} from "./tenant-human-auth";
import { withCmsProductSession } from "./session-broker";

const identity = {
	siteId: "site-one",
	slug: "acme",
	bundleEtag: "bundle-sha",
	tenantId: "org_acme",
	subject: "user-one",
	email: "editor@example.com",
	name: "Editor",
	role: 40 as const,
};

const target = "https://acme.cms.tedix.dev/_emdash/api/content?locale=de";

function request(attestation: string, input = identity) {
	return new Request(target, {
		method: "GET",
		headers: {
			"X-Tedix-CMS-Forwarded-User-Auth": attestation,
			[CMS_HUMAN_IDENTITY_HEADER]: btoa(JSON.stringify(input)),
			[CMS_HUMAN_ASSERTION_HEADER]: "forged",
		},
	});
}

describe("tenant human assertion boundary", () => {
	it("refreshes site authority only for an attested human identity", () => {
		expect(hasAttestedCmsHumanIdentity(request("shared"), "shared")).toBe(true);
		for (const [candidate, secret] of [
			[request("wrong"), "shared"],
			[request("shared"), undefined],
			[request("shared"), ""],
			[new Request(target), "shared"],
		] as const) {
			expect(hasAttestedCmsHumanIdentity(candidate, secret)).toBe(false);
		}
		const missingIdentity = request("shared");
		missingIdentity.headers.delete(CMS_HUMAN_IDENTITY_HEADER);
		expect(hasAttestedCmsHumanIdentity(missingIdentity, "shared")).toBe(false);
		const blankIdentity = request("shared");
		blankIdentity.headers.set(CMS_HUMAN_IDENTITY_HEADER, "  ");
		expect(hasAttestedCmsHumanIdentity(blankIdentity, "shared")).toBe(false);
	});

	it("neutralizes public identity and assertion headers before tenant dispatch", () => {
		const publicRequest = request("wrong");
		const normalized = withCmsProductSession(publicRequest, "shared");
		expect(normalized.headers.get(CMS_HUMAN_IDENTITY_HEADER)).toBe("");
		expect(normalized.headers.get(CMS_HUMAN_ASSERTION_HEADER)).toBe("");
		expect(normalized.headers.get("X-Tedix-CMS-Forwarded-User-Auth")).toBe("");
	});
	it("uses a domain-separated key for the exact site and immutable bundle", async () => {
		const key = await deriveTenantHumanAuthKey({
			sharedToken: "shared",
			...identity,
		});
		expect(key).toBeTruthy();
		expect(key).not.toBe("shared");
		expect(key).not.toBe(
			await deriveTenantHumanAuthKey({
				sharedToken: "shared",
				...identity,
				bundleEtag: "other",
			}),
		);
		expect(key).not.toBe(
			await deriveTenantHumanAuthKey({
				sharedToken: "shared",
				...identity,
				siteId: "other",
			}),
		);
	});

	it("mints only for an attested caller and strips a supplied assertion", async () => {
		const original = request("shared");
		const key = (await deriveTenantHumanAuthKey({
			sharedToken: "shared",
			...identity,
		}))!;
		const forwarded = await forwardCmsHumanAssertion({
			original,
			tenantRequest: original,
			sharedToken: "shared",
			key,
			expected: identity,
		});
		const assertion = forwarded.headers.get(CMS_HUMAN_ASSERTION_HEADER);
		expect(assertion).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		expect(forwarded.headers.get(CMS_HUMAN_IDENTITY_HEADER)).toBe("");
		const encoded = assertion!.split(".")[0]!;
		const claims = JSON.parse(
			atob(encoded.replace(/-/g, "+").replace(/_/g, "/")),
		);
		expect(claims).toMatchObject({
			siteId: "site-one",
			role: 40,
			method: "GET",
			path: "/_emdash/api/content?locale=de",
		});
		expect(claims.exp - claims.iat).toBe(30);
	});

	it("fails closed on a forged attestation, wrong tenant, or inactive bundle", async () => {
		const key = (await deriveTenantHumanAuthKey({
			sharedToken: "shared",
			...identity,
		}))!;
		for (const [original, expected, activeKey] of [
			[request("wrong"), identity, key],
			[request("shared"), { ...identity, tenantId: "org_other" }, key],
			[request("shared"), identity, undefined],
		] as const) {
			const forwarded = await forwardCmsHumanAssertion({
				original,
				tenantRequest: original,
				sharedToken: "shared",
				key: activeKey,
				expected,
			});
			expect(forwarded.headers.get(CMS_HUMAN_ASSERTION_HEADER)).toBe("");
		}
	});

	it("binds the signed payload to method and exact query", async () => {
		const key = (await deriveTenantHumanAuthKey({
			sharedToken: "shared",
			...identity,
		}))!;
		const signed = await mintCmsHumanAssertion({
			key,
			identity,
			request: new Request(target, { method: "POST" }),
			now: 100,
		});
		const claims = JSON.parse(
			atob(signed.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
		);
		expect(claims).toMatchObject({
			method: "POST",
			path: "/_emdash/api/content?locale=de",
			iat: 100,
			exp: 130,
		});
	});
});
