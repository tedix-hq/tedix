import { describe, expect, it, vi } from "vite-plus/test";
import { osVersionPlugin, readOsBuildSha } from "./os-version-plugin";

describe("OS build identity", () => {
	it("uses the supplied full SHA and rejects placeholders", () => {
		expect(readOsBuildSha({ GIT_SHA: "a".repeat(40) })).toBe("a".repeat(40));
		expect(() => readOsBuildSha({ GIT_SHA: "unknown" })).toThrow(
			"full Git SHA",
		);
		expect(() => readOsBuildSha({ TEDIX_BUILD_SHA: "short" })).toThrow(
			"full Git SHA",
		);
	});

	it("emits version.json for the client bundle only", () => {
		const sha = "a".repeat(40);
		const plugin = osVersionPlugin(sha);
		const emitFile = vi.fn();
		const hook = plugin.generateBundle;
		if (typeof hook !== "function") throw new Error("Expected a build hook");
		Reflect.apply(hook, { environment: { name: "worker" }, emitFile }, []);
		expect(emitFile).not.toHaveBeenCalled();
		Reflect.apply(hook, { environment: { name: "client" }, emitFile }, []);
		expect(emitFile).toHaveBeenCalledWith({
			type: "asset",
			fileName: "version.json",
			source: JSON.stringify({ sha }),
		});
	});
});
