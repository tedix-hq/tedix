import { describe, expect, test } from "vite-plus/test";

import {
	deriveLeadIpHash,
	LEAD_IP_HASH_HEADER,
	NATIVE_FORM_SUBMIT_PATH,
	protectLeadFormIp,
} from "./lead-ip-hash";

const secret = "a".repeat(64);

function cloudflareRequest(path: string, ip = "203.0.113.42"): Request {
	const request = new Request(`https://tenant.cms.tedix.dev${path}`, {
		headers: {
			"CF-Connecting-IP": ip,
			[LEAD_IP_HASH_HEADER]: "h1:attacker",
		},
	});
	Object.defineProperty(request, "cf", { value: { colo: "MEX" } });
	return request;
}

describe("lead-form IP pseudonymization", () => {
	test("is deterministic, versioned, and tenant scoped", async () => {
		const first = await deriveLeadIpHash(secret, "alpha", "203.0.113.42");
		expect(first).toMatch(/^h1:[0-9a-f]{32}$/);
		expect(await deriveLeadIpHash(secret, "alpha", "203.0.113.42")).toBe(first);
		expect(await deriveLeadIpHash(secret, "beta", "203.0.113.42")).not.toBe(
			first,
		);
		expect(first).not.toContain("203.0.113.42");
	});

	test("overwrites spoofed values only for the exact submit route", async () => {
		const original = cloudflareRequest(NATIVE_FORM_SUBMIT_PATH);
		const secured = await protectLeadFormIp(original, {
			originalRequest: original,
			secret,
			slug: "alpha",
		});
		expect(secured).toBeInstanceOf(Request);
		expect((secured as Request).headers.get(LEAD_IP_HASH_HEADER)).toMatch(
			/^h1:[0-9a-f]{32}$/,
		);

		const other = cloudflareRequest(`${NATIVE_FORM_SUBMIT_PATH}/extra`);
		const neutralized = await protectLeadFormIp(other, {
			originalRequest: other,
			secret,
			slug: "alpha",
		});
		expect((neutralized as Request).headers.get(LEAD_IP_HASH_HEADER)).toBe("");
	});

	test("fails closed without a strong key", async () => {
		const original = cloudflareRequest(NATIVE_FORM_SUBMIT_PATH);
		for (const key of [undefined, "short"]) {
			const result = await protectLeadFormIp(original, {
				originalRequest: original,
				secret: key,
				slug: "alpha",
			});
			expect(result).toBeInstanceOf(Response);
			expect((result as Response).status).toBe(503);
			expect((result as Response).headers.get("Cache-Control")).toBe(
				"no-store",
			);
		}
	});

	test("does not trust a forwarded IP without Cloudflare request metadata", async () => {
		const request = new Request(
			`https://tenant.cms.tedix.dev${NATIVE_FORM_SUBMIT_PATH}`,
			{
				headers: {
					"CF-Connecting-IP": "203.0.113.42",
					[LEAD_IP_HASH_HEADER]: "h1:attacker",
				},
			},
		);
		const result = await protectLeadFormIp(request, {
			originalRequest: request,
			secret,
			slug: "alpha",
		});
		expect((result as Request).headers.get(LEAD_IP_HASH_HEADER)).toBe("");
	});
});

test("protects native Forms submission with the same tenant pseudonym", async () => {
	const original = cloudflareRequest(NATIVE_FORM_SUBMIT_PATH);
	const secured = await protectLeadFormIp(original, {
		originalRequest: original,
		secret,
		slug: "alpha",
	});
	expect((secured as Request).headers.get(LEAD_IP_HASH_HEADER)).toBe(
		await deriveLeadIpHash(secret, "alpha", "203.0.113.42"),
	);
});
