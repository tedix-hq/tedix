import { describe, expect, it } from "vite-plus/test";
import {
	applyPrivateSurfaceRobotsPolicy,
	PRIVATE_SURFACE_ROBOTS_POLICY,
} from "./private-surface-policy";

describe("Widget private-surface robots policy", () => {
	it("adds crawler policy without changing resource metadata", () => {
		const headers = new Headers({ "Content-Type": "text/html" });

		applyPrivateSurfaceRobotsPolicy(headers);

		expect(headers.get("X-Robots-Tag")).toBe(PRIVATE_SURFACE_ROBOTS_POLICY);
		expect(headers.get("Content-Type")).toBe("text/html");
	});
});
