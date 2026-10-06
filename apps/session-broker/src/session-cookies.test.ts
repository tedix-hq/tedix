import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import {
	appendRotatedRefreshCookie,
	expireRefreshAndSessionCookies,
} from "./session-cookies";

function rotatedCookies(hostname: string) {
	const headers = new Headers();
	appendRotatedRefreshCookie(
		headers,
		{
			refreshToken: "refresh-next",
			sessionToken: `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 }))}.signature`,
			refreshCookieMaxAge: 1200,
		},
		hostname,
	);
	return headers.getSetCookie();
}

describe("installation-local broker cookies", () => {
	it.each([undefined, "invalid", "9999999999", -1])(
		"bounds an invalid or expired session hint: %s",
		(exp) => {
			const headers = new Headers();
			appendRotatedRefreshCookie(
				headers,
				{
					refreshToken: "refresh-next",
					sessionToken: `e30.${btoa(JSON.stringify({ exp }))}.signature`,
				},
				"auth.example.com",
			);
			expect(
				headers
					.getSetCookie()
					.find(
						(cookie) =>
							cookie.startsWith("DS=") && !cookie.includes("Max-Age=0"),
					),
			).toContain("Max-Age=1;");
		},
	);
	it.each([
		"auth.example.com",
		"login.jason.example",
		"auth.tedix.dev.attacker.example",
	])("scopes rotation and expiry only to %s", (hostname) => {
		const cookies = rotatedCookies(hostname);
		for (const name of ["DSR", "TEDIX_DSR", "DS"]) {
			const expired = cookies.filter(
				(cookie) =>
					cookie.startsWith(`${name}=`) && cookie.includes("Max-Age=0"),
			);
			expect(expired).toHaveLength(2);
			expect(
				expired.filter((cookie) => !cookie.includes("Domain=")),
			).toHaveLength(1);
			expect(
				expired.filter((cookie) => cookie.includes(`Domain=${hostname};`)),
			).toHaveLength(1);
		}
		const active = cookies.filter((cookie) => !cookie.includes("Max-Age=0"));
		expect(active).toHaveLength(3);
		expect(active.find((cookie) => cookie.startsWith("DSR="))).toContain(
			`Domain=${hostname};`,
		);
		expect(active.find((cookie) => cookie.startsWith("DSR="))).toContain(
			"Max-Age=1200",
		);
		expect(
			active.find((cookie) => cookie.startsWith("TEDIX_DSR=")),
		).not.toContain("Domain=");
		expect(active.find((cookie) => cookie.startsWith("DS="))).not.toContain(
			"Domain=",
		);
		for (const cookie of cookies) {
			expect(cookie).toContain("HttpOnly");
			expect(cookie).toContain("Secure");
			expect(cookie).toContain("SameSite=Lax");
			expect(cookie).toContain("Path=/");
			expect(cookie).not.toContain("Domain=.tedix.dev");
			expect(cookie).not.toContain("Domain=auth.tedix.dev;");
		}
	});

	it("preserves managed cookie identities and legacy cleanup", () => {
		const cookies = rotatedCookies("auth.tedix.dev");
		for (const name of ["DSR", "TEDIX_DSR", "DS"]) {
			const expired = cookies.filter(
				(cookie) =>
					cookie.startsWith(`${name}=`) && cookie.includes("Max-Age=0"),
			);
			expect(expired).toHaveLength(3);
			expect(
				expired.some((cookie) => cookie.includes("Domain=.tedix.dev;")),
			).toBe(true);
			expect(
				expired.some((cookie) => cookie.includes("Domain=auth.tedix.dev;")),
			).toBe(true);
			expect(expired.some((cookie) => !cookie.includes("Domain="))).toBe(true);
		}
		expect(
			cookies.find((cookie) => cookie.startsWith("DSR=refresh-next")),
		).toContain("Domain=auth.tedix.dev;");
	});

	it("uses the same installation scopes for logout and recovery", () => {
		const headers = new Headers();
		expireRefreshAndSessionCookies(headers, "auth.example.com");
		const expired = headers.getSetCookie();
		expect(expired).toEqual(
			rotatedCookies("auth.example.com").filter((cookie) =>
				cookie.includes("Max-Age=0"),
			),
		);
		expect(expired.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
	});

	it.each([
		"https://auth.example.com",
		"https://auth.tedix.dev.attacker.example",
	])("does not admit an unconfigured host: %s", async (origin) => {
		const response = await SELF.fetch(
			`${origin}/tedix/session/authorize?intent=${"a".repeat(43)}`,
			{
				headers: {
					"Sec-Fetch-Dest": "document",
					"X-Forwarded-Host": "auth.tedix.dev",
				},
				redirect: "manual",
			},
		);
		expect(response.status).toBe(404);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(response.headers.get("Location")).toBeNull();
	});
});
