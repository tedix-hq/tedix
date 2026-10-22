import { describe, expect, it } from "vite-plus/test";
import { validateAdminBillingSearch } from "./admin-billing-search";

const validate = (search: Record<string, unknown>) =>
	validateAdminBillingSearch(
		search as Parameters<typeof validateAdminBillingSearch>[0],
	);

describe("admin billing search", () => {
	it.each(["success", "cancelled", "topup-success", "topup-cancelled"])(
		"preserves the %s checkout handshake",
		(checkout) => expect(validate({ checkout })).toStrictEqual({ checkout }),
	);

	it.each(["subscription", "invoices"])(
		"preserves the %s section with checkout",
		(section) => {
			expect(validate({ section, checkout: "success" })).toStrictEqual({
				section,
				checkout: "success",
			});
		},
	);

	it("defaults absent values and drops unknown and legacy keys", () => {
		expect(validate({})).toStrictEqual({});
		expect(
			validate({ tab: "invoices", session_id: "sample-session", extra: true }),
		).toStrictEqual({});
	});

	it.each([
		undefined,
		null,
		"",
		"unknown",
		"canceled",
		"SUCCESS",
		1,
		false,
		[],
		{},
	])("drops invalid checkout %j without losing the section", (checkout) =>
		expect(validate({ checkout, section: "invoices" })).toStrictEqual({
			section: "invoices",
		}),
	);

	it.each([
		undefined,
		null,
		"",
		"usage",
		"billing",
		"INVOICES",
		1,
		false,
		[],
		{},
	])(
		"defaults section %j to implicit usage without losing checkout",
		(section) =>
			expect(validate({ section, checkout: "topup-success" })).toStrictEqual({
				checkout: "topup-success",
			}),
	);
});
