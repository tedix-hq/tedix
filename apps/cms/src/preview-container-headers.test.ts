import { describe, expect, it } from "vite-plus/test";
import { previewContainerHeaders } from "./preview-headers";

describe("preview container headers", () => {
	it("never passes a platform credential to organization-authored site code", () => {
		const headers = previewContainerHeaders(
			new Headers({
				Authorization: "Bearer platform-service-token",
				"X-Forwarded-Authorization": "Bearer something",
				"X-Tedix-Admin-Token": "admin-token",
				"X-Tedix-CMS-Internal-Auth": "internal-token",
				Accept: "text/html",
			}),
			undefined,
		);
		expect(headers.get("Authorization")).toBeNull();
		expect(headers.get("X-Forwarded-Authorization")).toBeNull();
		expect(headers.get("X-Tedix-Admin-Token")).toBeNull();
		expect(headers.get("X-Tedix-CMS-Internal-Auth")).toBeNull();
		expect(headers.get("Accept")).toBe("text/html");
	});

	it("replaces the caller's credential with the signed-in person's own token", () => {
		const headers = previewContainerHeaders(
			new Headers({ Authorization: "Bearer platform-service-token" }),
			"user-jwt",
		);
		expect(headers.get("Authorization")).toBe("Bearer user-jwt");
	});
});
