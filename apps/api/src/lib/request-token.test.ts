import { describe, expect, it } from "vite-plus/test";
import { extractRequestToken } from "./request-token";

describe("extractRequestToken", () => {
	it("prefers an explicit Bearer credential over browser cookies", () => {
		const headers = new Headers({
			Authorization: "Bearer api-token",
			Cookie: "DS=session-token; id_token=legacy-token",
		});
		expect(extractRequestToken((name) => headers.get(name))).toBe("api-token");
	});

	it("uses the canonical DS cookie when a legacy cookie is also present", () => {
		const headers = new Headers({
			Cookie: "id_token=legacy-token; DS=session-token",
		});
		expect(extractRequestToken((name) => headers.get(name))).toBe(
			"session-token",
		);
	});

	it("rejects the legacy id_token cookie", () => {
		expect(
			extractRequestToken((name) =>
				new Headers({ Cookie: "id_token=legacy-token" }).get(name),
			),
		).toBeNull();
	});

	it("rejects malformed and absent credentials", () => {
		expect(
			extractRequestToken((name) =>
				new Headers({ Authorization: "Basic value" }).get(name),
			),
		).toBeNull();
		expect(extractRequestToken(() => null)).toBeNull();
	});
});
