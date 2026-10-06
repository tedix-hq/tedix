import { describe, expect, it } from "vite-plus/test";
import { resolveCorsOrigin } from "./cors";

describe("resolveCorsOrigin", () => {
	it("accepts exact origins and HTTPS subdomains", () => {
		const policy = {
			exactOrigins: new Set(["https://os.tedix.dev"]),
			httpsSubdomainSuffixes: ["tedix.tech"],
		};
		expect(resolveCorsOrigin("https://os.tedix.dev", policy)).toBe(
			"https://os.tedix.dev",
		);
		expect(resolveCorsOrigin("https://api.tedix.tech", policy)).toBe(
			"https://api.tedix.tech",
		);
	});

	it("does not match apexes or deceptive suffixes", () => {
		const policy = { httpsSubdomainSuffixes: ["tedix.dev"] };
		expect(resolveCorsOrigin("https://tedix.dev", policy)).toBeNull();
		expect(resolveCorsOrigin("https://evil-tedix.dev", policy)).toBeNull();
	});

	it("allows only real localhost names when opted in", () => {
		const policy = { allowLocalhost: true };
		expect(resolveCorsOrigin("http://localhost:3000", policy)).toBe(
			"http://localhost:3000",
		);
		expect(resolveCorsOrigin("https://localhost.evil.test", policy)).toBeNull();
	});
});
