import { describe, expect, it } from "vite-plus/test";
import { buildBillingSettingsUrl } from "./billing-urls";

describe("buildBillingSettingsUrl", () => {
	it("builds the canonical Tedix OS billing route with no slug segment", () => {
		// OS tenancy is hostname-based, so the path carries no organization slug.
		expect(buildBillingSettingsUrl({ osUrl: "https://os.tedix.dev" })).toBe(
			"https://os.tedix.dev/admin/billing",
		);
	});

	it.each([
		"success",
		"cancelled",
		"topup-success",
		"topup-cancelled",
	] as const)(
		"adds the %s return state as the checkout handshake param",
		(state) => {
			expect(
				buildBillingSettingsUrl({ osUrl: "https://os.tedix.dev/", state }),
			).toBe(`https://os.tedix.dev/admin/billing?checkout=${state}`);
		},
	);
});
