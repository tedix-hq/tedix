import { describe, expect, it } from "vite-plus/test";
import { getGaMeasurementId } from "./analytics-config";

describe("landing analytics configuration", () => {
	it.each([
		undefined,
		"",
		"G-XXXXXXXXXX",
		"G-PLACEHOLDER",
		"UA-12345678-1",
		"GTM-ABC123",
		"G-PSW1MY7HB4?bad",
		"g-psw1my7hb4",
	])(
		"disables analytics for missing, placeholder, or invalid IDs: %s",
		(value) => {
			expect(getGaMeasurementId(value)).toBeUndefined();
		},
	);

	it("accepts a GA4 measurement ID", () => {
		expect(getGaMeasurementId("G-PSW1MY7HB4")).toBe("G-PSW1MY7HB4");
	});
});
