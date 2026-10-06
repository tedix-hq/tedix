import { describe, expect, it } from "vite-plus/test";
import { requireAihEnv } from "./descope-aih-env";

describe("requireAihEnv", () => {
	it("preserves the configured Descope API origin", () => {
		expect(
			requireAihEnv({
				DESCOPE_PROJECT_ID: "project",
				DESCOPE_MANAGEMENT_KEY: "management-key",
				DESCOPE_BASE_URL: "https://auth.example.test",
			} as CloudflareEnv),
		).toEqual({
			DESCOPE_PROJECT_ID: "project",
			DESCOPE_MANAGEMENT_KEY: "management-key",
			DESCOPE_BASE_URL: "https://auth.example.test",
		});
	});

	it("fails closed when either management credential is absent", () => {
		expect(() =>
			requireAihEnv({ DESCOPE_PROJECT_ID: "project" } as CloudflareEnv),
		).toThrow(/not configured/);
		expect(() =>
			requireAihEnv({ DESCOPE_MANAGEMENT_KEY: "key" } as CloudflareEnv),
		).toThrow(/not configured/);
	});
});
