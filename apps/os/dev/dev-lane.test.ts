import { describe, expect, it } from "vite-plus/test";
import { apiProxyForOsDevLane, resolveOsDevLane } from "./dev-lane";

describe("OS Vite development lane selection", () => {
	it("defaults to fixtures", () => {
		expect(resolveOsDevLane({}, false)).toBe("fixtures");
	});

	it("keeps the explicit remote and live-API lanes", () => {
		expect(resolveOsDevLane({ TEDIX_OS_REMOTE_DEV: "1" }, false)).toBe(
			"remote-worker",
		);
		expect(resolveOsDevLane({ VITE_LIVE_API: "1" }, false)).toBe("live-api");
		expect(resolveOsDevLane({}, true)).toBe("live-api");
	});

	it("makes local Worker mode authoritative over hostile ambient switches", () => {
		expect(
			resolveOsDevLane(
				{
					TEDIX_OS_LOCAL_DEV: "1",
					TEDIX_OS_REMOTE_DEV: "1",
					VITE_LIVE_API: "1",
				},
				true,
			),
		).toBe("local-worker");
	});

	it("never installs the Vite API proxy in local Worker mode", () => {
		const proxy = { target: "https://api.tedix.dev" };
		expect(apiProxyForOsDevLane("local-worker", proxy)).toBeUndefined();
		expect(apiProxyForOsDevLane("remote-worker", proxy)).toBeUndefined();
		expect(apiProxyForOsDevLane("fixtures", proxy)).toBeUndefined();
		expect(apiProxyForOsDevLane("live-api", proxy)).toBe(proxy);
	});
});
