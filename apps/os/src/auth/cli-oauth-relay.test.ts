import { encodeTedixCliOAuthRelayState } from "@tedix/auth/oauth-client-registration";
import { describe, expect, it } from "vite-plus/test";
import {
	buildCliOAuthRelayTarget,
	handleCliOAuthRelay,
} from "./cli-oauth-relay";

describe("CLI OAuth callback relay", () => {
	it("relays an authorization response only to the state-bound loopback port", () => {
		const state = encodeTedixCliOAuthRelayState("nonce_123", 49_152);
		const target = buildCliOAuthRelayTarget(
			`https://os.tedix.dev/cli/oauth/callback?code=code-1&state=${state}&iss=https%3A%2F%2Fauth.tedix.dev&ignored=drop-me`,
		);
		expect(target).toBe(
			"http://127.0.0.1:49152/callback?code=code-1&iss=https%3A%2F%2Fauth.tedix.dev&state=nonce_123.49152",
		);
	});

	it.each([
		"missing-port",
		"nonce.0",
		"nonce.65536",
		"nonce.not-a-port",
		"bad%2Fnonce.49152",
	])("rejects invalid relay state %s", (state) => {
		expect(
			buildCliOAuthRelayTarget(
				`https://os.tedix.dev/cli/oauth/callback?code=x&state=${state}`,
			),
		).toBeNull();
	});

	it("refuses non-GET methods and malformed callbacks", async () => {
		const method = handleCliOAuthRelay(
			new Request("https://os.tedix.dev/cli/oauth/callback", {
				method: "POST",
			}),
		);
		expect(method?.status).toBe(405);
		const malformed = handleCliOAuthRelay(
			new Request("https://os.tedix.dev/cli/oauth/callback?state=bad"),
		);
		expect(malformed?.status).toBe(400);
		expect(await malformed?.text()).toContain(
			"Invalid CLI OAuth callback state",
		);
	});
});
