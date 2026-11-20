import { describe, expect, it } from "vite-plus/test";
import { validateAdminBillingSearch } from "./admin-billing-search";

const validate = (search: Record<string, unknown>) =>
	validateAdminBillingSearch(
		search as Parameters<typeof validateAdminBillingSearch>[0],
	);

describe("billing links", () => {
	it("opens the matching tab when checkout returns without a tab", () => {
		expect(validate({ checkout: "success" })).toMatchObject({
			checkout: "success",
			tab: "plan",
		});
		expect(validate({ checkout: "topup-cancelled" })).toMatchObject({
			checkout: "topup-cancelled",
			tab: "credit-packs",
		});
	});

	it("preserves legacy links and honors an explicit valid tab", () => {
		expect(validate({ section: "subscription" }).tab).toBe("plan");
		expect(validate({ section: "invoices" }).tab).toBe("invoices");
		expect(
			validate({ tab: "limits", section: "subscription", checkout: "unknown" }),
		).toStrictEqual({ tab: "limits", checkout: undefined });
	});
});
