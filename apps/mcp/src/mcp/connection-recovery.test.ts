import { describe, expect, it } from "vite-plus/test";
import { buildCredentialRecovery } from "./handler";

const selection = {
	providerId: "google-calendar",
	connectionInstanceId: "11111111-1111-4111-8111-111111111111",
	scope: "user" as const,
	scopes: ["calendar"],
};
describe("credential recovery classification", () => {
	it("allows only an explicit canonical missing pinned account", () => {
		expect(
			buildCredentialRecovery({ token: null, status: 404 }, selection),
		).toEqual(selection);
		for (const status of [400, 401, 403, 409, 429, 500, 503])
			expect(
				buildCredentialRecovery({ token: null, status }, selection),
			).toBeUndefined();
		expect(buildCredentialRecovery({ token: null }, selection)).toBeUndefined();
		expect(
			buildCredentialRecovery({ token: "valid", status: 404 }, selection),
		).toBeUndefined();
		expect(
			buildCredentialRecovery(
				{ token: null, status: 404 },
				{ ...selection, connectionInstanceId: undefined },
			),
		).toBeUndefined();
	});
});
