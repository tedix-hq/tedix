import { describe, expect, it } from "vite-plus/test";
import {
	WIDGET_MINIMUM_BOOTSTRAP_VERSION,
	WIDGET_SDK_VERSION,
} from "./sdk-contract";

describe("widget SDK contract", () => {
	it("keeps the current SDK compatible with the supported bootstrap floor", () => {
		expect(WIDGET_SDK_VERSION).toBe("1.5.0");
		expect(WIDGET_MINIMUM_BOOTSTRAP_VERSION).toBe("1.1.0");
		expect(Number(WIDGET_SDK_VERSION.split(".")[0])).toBe(
			Number(WIDGET_MINIMUM_BOOTSTRAP_VERSION.split(".")[0]),
		);
	});
});
