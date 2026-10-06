import { describe, expect, test } from "bun:test";

describe("connection provider installation seeds", () => {
	test("Google templates defer callback routing to the installation without changing OAuth settings", async () => {
		const previousAssetsUrl = process.env.ASSETS_URL;
		process.env.ASSETS_URL = "https://assets.installation.example";
		try {
			const { CONNECTION_PROVIDER_SEEDS } =
				await import("./seed-connection-providers");
			for (const id of [
				"google-analytics",
				"google-gmail",
				"google-calendar",
				"google-drive",
				"google-sheets",
				"google-chat",
			]) {
				const seed = CONNECTION_PROVIDER_SEEDS.find(
					(provider) => provider.id === id,
				);
				expect(seed, id).toBeDefined();
				const oauth = JSON.parse(JSON.stringify(seed!.oauthConfig));
				expect(oauth).not.toHaveProperty("callbackDomain");
				expect(oauth.authorizationUrl).toBe(
					"https://accounts.google.com/o/oauth2/v2/auth",
				);
				expect(oauth.tokenUrl).toBe("https://oauth2.googleapis.com/token");
				expect(oauth.pkce).toBe(true);
				expect(oauth.accessType).toBe("offline");
				expect(oauth.prompt).toEqual(["select_account", "consent"]);
				expect(seed!.requiredScopes.length).toBeGreaterThan(0);
				if (id !== "google-analytics") {
					expect(oauth.authorizationUrlParams).toEqual(oauth.tokenUrlParams);
					expect(oauth.authorizationUrlParams[0].key).toBe("resource");
				}
			}
		} finally {
			if (previousAssetsUrl === undefined) delete process.env.ASSETS_URL;
			else process.env.ASSETS_URL = previousAssetsUrl;
		}
	});
});
