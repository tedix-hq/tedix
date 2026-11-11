import { describe, expect, it } from "vite-plus/test";
import { assertConnectReturnUrl } from "./outbound-oauth-settle";

const env = { OS_URL: "https://os.tedix.dev" } as never;

describe("connect return URL", () => {
	it("accepts the callback page on the launcher and tenant hosts", () => {
		for (const url of [
			"https://os.tedix.dev/oauth/callback",
			"https://acme.os.tedix.dev/oauth/callback",
		]) {
			expect(assertConnectReturnUrl(env, url)).toBe(url);
		}
	});

	it("refuses other origins, paths and URL tricks", () => {
		for (const url of [
			"https://evil.example/oauth/callback",
			"https://os.tedix.dev.evil.example/oauth/callback",
			"https://evil.example/?x=https://os.tedix.dev/oauth/callback",
			"https://os.tedix.dev/admin",
			"https://os.tedix.dev/oauth/callback/../../admin",
			"https://os.tedix.dev/oauth/callback?next=https://evil.example",
			"https://os.tedix.dev/oauth/callback#x",
			"https://user:pass@os.tedix.dev/oauth/callback",
			"http://os.tedix.dev/oauth/callback",
			"javascript:alert(1)",
		]) {
			expect(() => assertConnectReturnUrl(env, url), url).toThrow();
		}
	});
});
