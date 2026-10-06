import { describe, expect, test } from "bun:test";
import { resolveCloudflareCliToken } from "./cli-auth";

describe("installation CLI credentials", () => {
	test("explicit token takes precedence without invoking Wrangler", async () => {
		expect(
			await resolveCloudflareCliToken(
				{ CLOUDFLARE_API_TOKEN: " explicit " },
				async () => {
					throw new Error("must not run");
				},
			),
		).toBe("explicit");
	});
	test("accepts supported OAuth and API tokens", async () => {
		for (const type of ["oauth", "api_token"])
			expect(
				await resolveCloudflareCliToken({}, async () =>
					JSON.stringify({ type, token: "private-token" }),
				),
			).toBe("private-token");
	});
	test("rejects key/email and malformed output without exposing secrets", async () => {
		for (const response of [
			JSON.stringify({
				type: "api_key",
				key: "secret-key",
				email: "private-email",
			}),
			"secret-token invalid-json",
			JSON.stringify({ type: "other", token: "secret-token" }),
			JSON.stringify({ type: "oauth", token: "" }),
			"null",
		]) {
			try {
				await resolveCloudflareCliToken({}, async () => response);
				throw new Error("expected rejection");
			} catch (error) {
				const text = String(error);
				expect(text).toContain("bunx wrangler login");
				expect(text).not.toContain("secret-");
				expect(text).not.toContain("private-email");
			}
		}
	});
	test("redacts command errors including captured output and cause", async () => {
		try {
			await resolveCloudflareCliToken({}, async () => {
				throw Object.assign(new Error("token-secret"), {
					stdout: "token-secret",
					stderr: "token-secret",
				});
			});
			throw new Error("expected rejection");
		} catch (error) {
			expect(String(error)).toContain("Could not read Wrangler");
			expect(String(error)).not.toContain("token-secret");
			expect((error as Error).cause).toBeUndefined();
		}
	});
});
