import { describe, expect, it } from "vite-plus/test";
import { materializeRestRoute, RestRouteInputError } from "./rest-route";

describe("materializeRestRoute", () => {
	it("interpolates and consumes oRPC and colon path parameters", () => {
		expect(
			materializeRestRoute("/apps/{appId}/versions/:version", {
				appId: "app/alpha",
				version: "v 1",
				limit: 5,
			}),
		).toEqual({
			endpoint: "apps/app%2Falpha/versions/v%201",
			params: { limit: 5 },
		});
	});

	it("preserves slash boundaries for catch-all path parameters", () => {
		expect(
			materializeRestRoute("files/{+path}", {
				path: "reports/Quarter 1/a#b.md",
			}),
		).toEqual({
			endpoint: "files/reports/Quarter%201/a%23b.md",
			params: {},
		});
	});

	it("rejects unresolved path parameters", () => {
		expect(() => materializeRestRoute("apps/{appId}", { limit: 5 })).toThrow(
			RestRouteInputError,
		);
	});
});
