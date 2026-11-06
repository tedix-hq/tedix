import { describe, expect, it } from "vite-plus/test";
import { r2RestHeaders } from "./r2-rest";

describe("r2RestHeaders", () => {
	it("names the bucket jurisdiction so EU buckets are found", () => {
		expect(r2RestHeaders("t", "eu")).toEqual({
			Authorization: "Bearer t",
			"cf-r2-jurisdiction": "eu",
		});
	});

	it("sends no jurisdiction header for default-jurisdiction buckets", () => {
		expect(
			r2RestHeaders("t", undefined, { "Content-Type": "image/png" }),
		).toEqual({ "Content-Type": "image/png", Authorization: "Bearer t" });
	});
});
