import { describe, expect, it } from "vite-plus/test";
import { resolveAdaptiveConnectUserToken } from "./connections/policy-resolution";

/**
 * Descope's Adaptive Connect is called as `Bearer {projectId}:{userToken}` and
 * must act AS the user, so these handlers need that user's own session JWT.
 *
 * Bearer callers (Tedix OS, the CLI) send it in `Authorization`. The dashboard
 * is broker-only and sends no bearer at all — it authenticates with the `DS`
 * cookie, which carries the same JWT. Without the cookie fallback every OAuth
 * Connect button in the dashboard fails.
 */
describe("resolveAdaptiveConnectUserToken", () => {
	const headers = (init: Record<string, string>) => new Headers(init);

	it("takes the bearer token when one is present", () => {
		expect(
			resolveAdaptiveConnectUserToken(
				headers({ Authorization: "Bearer eyJbearer" }),
			),
		).toBe("eyJbearer");
	});

	it("falls back to the DS cookie when no bearer is sent", () => {
		expect(
			resolveAdaptiveConnectUserToken(headers({ Cookie: "DS=eyJcookie" })),
		).toBe("eyJcookie");
	});

	it("prefers the bearer over the cookie when both are present", () => {
		expect(
			resolveAdaptiveConnectUserToken(
				headers({ Authorization: "Bearer eyJbearer", Cookie: "DS=eyJcookie" }),
			),
		).toBe("eyJbearer");
	});

	it("reads DS from among other cookies", () => {
		expect(
			resolveAdaptiveConnectUserToken(
				headers({ Cookie: "DSR=eyJrefresh; DS=eyJcookie; other=x" }),
			),
		).toBe("eyJcookie");
	});

	// A non-JWT value must not reach Descope as a credential — the caller raises
	// its own 401 on null instead of letting the connect call fail opaquely.
	it("rejects a bearer that is not JWT-shaped, and does not fall through to a bad cookie", () => {
		expect(
			resolveAdaptiveConnectUserToken(
				headers({ Authorization: "Bearer sk_not_a_jwt" }),
			),
		).toBeNull();
	});

	it("falls back to the cookie when the bearer is not JWT-shaped", () => {
		expect(
			resolveAdaptiveConnectUserToken(
				headers({
					Authorization: "Bearer sk_not_a_jwt",
					Cookie: "DS=eyJcookie",
				}),
			),
		).toBe("eyJcookie");
	});

	it("rejects a DS cookie that is not JWT-shaped", () => {
		expect(
			resolveAdaptiveConnectUserToken(headers({ Cookie: "DS=not_a_jwt" })),
		).toBeNull();
	});

	it("returns null when neither source carries a session", () => {
		expect(resolveAdaptiveConnectUserToken(headers({}))).toBeNull();
		expect(
			resolveAdaptiveConnectUserToken(headers({ Cookie: "DSR=eyJrefresh" })),
		).toBeNull();
	});
});
