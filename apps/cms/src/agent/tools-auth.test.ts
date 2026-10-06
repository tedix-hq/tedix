import { describe, expect, it } from "vite-plus/test";

import { buildServiceKeyProvisionAuthCandidates } from "./service-key-auth";

describe("buildServiceKeyProvisionAuthCandidates", () => {
	it("prefers the forwarded user session and retains internal fallback", () => {
		expect(
			buildServiceKeyProvisionAuthCandidates({
				forwardedAuth: "aaa.bbb.ccc",
				internalAuthToken: "internal_secret",
			}),
		).toEqual([
			{ Cookie: "DS=aaa.bbb.ccc" },
			{ "X-Tedix-CMS-Internal-Auth": "internal_secret" },
		]);
	});

	it("supports service-binding-only PAT bootstrap", () => {
		expect(
			buildServiceKeyProvisionAuthCandidates({
				forwardedAuth: undefined,
				internalAuthToken: "internal_secret",
			}),
		).toEqual([{ "X-Tedix-CMS-Internal-Auth": "internal_secret" }]);
	});

	it("ignores non-JWT forwarded credentials", () => {
		expect(
			buildServiceKeyProvisionAuthCandidates({
				forwardedAuth: "sk_platform_key",
				internalAuthToken: undefined,
			}),
		).toEqual([]);
	});
});
