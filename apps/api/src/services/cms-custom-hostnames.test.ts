import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	createCmsCustomHostname,
	createCmsDomainVerificationToken,
	cmsCustomHostnameTarget,
	cmsDomainVerificationName,
	deleteCmsCustomHostname,
	findCmsCustomHostname,
	getCmsCustomHostname,
	isCmsCustomHostnameReady,
	verifyCmsDnsChallenge,
	verifyCmsDnsTarget,
	verifyCmsDnsZoneApex,
} from "./cms-custom-hostnames";

const env = {
	CF_CMS_SAAS_ZONE_ID: "00000000000000000000000000000001",
	CF_CMS_HOSTNAMES_TOKEN: "scoped-test-token",
	CF_CMS_SAAS_TARGET_DOMAIN: "cms.tedix.dev",
};

afterEach(() => vi.unstubAllGlobals());

describe("CMS custom hostname provider", () => {
	it("fails closed without the scoped provider credential or target", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createCmsCustomHostname(
				{ ...env, CF_CMS_HOSTNAMES_TOKEN: "" },
				"blog.example.com",
			),
		).rejects.toThrow(/not configured/);
		expect(() =>
			cmsCustomHostnameTarget(
				{ ...env, CF_CMS_SAAS_TARGET_DOMAIN: "" },
				"alpha",
			),
		).toThrow(/not configured/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses only the zone-scoped token and exact provider identifiers", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: {
						id: "provider-a",
						hostname: "blog.example.com",
						status: "pending",
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: [
						{
							id: "provider-a",
							hostname: "blog.example.com",
							status: "active",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: {
						id: "provider-a",
						hostname: "blog.example.com",
						status: "active",
						ssl: { status: "active" },
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: { id: "provider-a", hostname: "blog.example.com" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createCmsCustomHostname(env, "blog.example.com"),
		).resolves.toMatchObject({
			id: "provider-a",
		});
		const createRequest = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(createRequest[0]).toContain(
			`/zones/${env.CF_CMS_SAAS_ZONE_ID}/custom_hostnames`,
		);
		expect(createRequest[1].headers).toMatchObject({
			Authorization: "Bearer scoped-test-token",
		});
		expect(JSON.parse(String(createRequest[1].body))).toEqual({
			hostname: "blog.example.com",
			ssl: { method: "txt", type: "dv" },
		});
		await expect(
			findCmsCustomHostname(env, "blog.example.com"),
		).resolves.toMatchObject({
			id: "provider-a",
		});
		expect(fetchMock.mock.calls[1]?.[0]).toContain(
			"hostname.exact=blog.example.com",
		);
		const active = await getCmsCustomHostname(env, "provider-a");
		expect(active && isCmsCustomHostnameReady(active)).toBe(true);
		fetchMock.mockResolvedValueOnce(
			Response.json({ success: true, result: { id: "provider-a" } }),
		);
		expect(
			await deleteCmsCustomHostname(env, "provider-a", "blog.example.com"),
		).toBe(true);
	});

	it("rejects a provider identity mismatch and platform hostnames", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					success: true,
					result: { id: "provider-a", hostname: "other.example.com" },
				}),
			),
		);
		await expect(
			createCmsCustomHostname(env, "blog.example.com"),
		).rejects.toThrow(/invalid identity/);
		await expect(createCmsCustomHostname(env, "os.tedix.dev")).rejects.toThrow(
			/Invalid CMS custom hostname/,
		);
	});
});

describe("CMS domain DNS proof", () => {
	it("requires a fresh challenge and the site's exact tenant CNAME", async () => {
		const token = createCmsDomainVerificationToken();
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		const hostname = "blog.example.com";
		const name = cmsDomainVerificationName(hostname);
		const target = cmsCustomHostnameTarget(env, "alpha");
		const fetchMock = vi.fn().mockImplementation((url: URL) => {
			const question = new URL(String(url));
			return Promise.resolve(
				Response.json({
					Status: 0,
					Answer:
						question.searchParams.get("type") === "TXT"
							? [{ name: `${name}.`, type: 16, data: `"${token}"` }]
							: [{ name: `${hostname}.`, type: 5, data: `${target}.` }],
				}),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(await verifyCmsDnsChallenge(hostname, token)).toBe(true);
		expect(await verifyCmsDnsTarget(hostname, target)).toBe(true);
		expect(await verifyCmsDnsTarget(hostname, "beta.cms.tedix.dev")).toBe(
			false,
		);
	});

	it("recognizes only the exact DNS zone apex for flattened CNAME setup", async () => {
		const fetchMock = vi.fn().mockImplementation((url: URL) => {
			const question = new URL(String(url));
			expect(question.searchParams.get("type")).toBe("SOA");
			return Promise.resolve(
				Response.json({
					Status: 0,
					Answer: [
						{
							name: "example.com.",
							type: 6,
							data: "ns1.example.com. hostmaster.example.com. 1 2 3 4 5",
						},
					],
				}),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(await verifyCmsDnsZoneApex("example.com")).toBe(true);
		expect(await verifyCmsDnsZoneApex("blog.example.com")).toBe(false);
	});
});
