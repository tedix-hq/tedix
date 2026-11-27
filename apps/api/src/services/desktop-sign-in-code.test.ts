import { TEDIX_CLI_OAUTH_CLIENT_ID } from "@tedix/auth/oauth-client-registration";
import { describe, expect, it } from "vite-plus/test";
import { isFreshCliToken } from "./desktop-sign-in-code";

const jwt = (claims: Record<string, unknown>) =>
	`e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const now = Math.floor(Date.now() / 1000);
const cli = {
	iss: "https://api.descope.com/v1/apps/agentic/P1/RS1",
	azp: TEDIX_CLI_OAUTH_CLIENT_ID,
	iat: now - 60,
};

// The desktop app gets a full Tedix OS session from this token, so only the
// Tedix CLI's own recent login may be used; any other client's must not.
describe("desktop sign-in from the command-line tool's login", () => {
	it("accepts the Tedix CLI's recent token", () => {
		expect(isFreshCliToken(jwt(cli))).toBe(true);
	});
	it.each([
		["another app's token", { ...cli, azp: "https://example.com/client.json" }],
		["a browser session token", { ...cli, iss: "P1", azp: undefined }],
		["a token older than an hour", { ...cli, iat: now - 2 * 60 * 60 }],
	])("refuses %s", (_name, claims) => {
		expect(isFreshCliToken(jwt(claims))).toBe(false);
	});
});
