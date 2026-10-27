import { describe, expect, it } from "bun:test";
import cliNativeEndpoints from "@tedix/api-contract/assets/cli-native-endpoints.v1.json";
import { WORK_NATIVE_ENDPOINTS } from "./work-native";

describe("WORK_NATIVE_ENDPOINTS", () => {
	// The gateway marks a tool native-eligible only when the schema sync opts
	// its endpoint in. An endpoint missing from the reviewed asset reaches the
	// CLI as "native descriptor is denied, ineligible ...", as `work move` did.
	it("every native Work endpoint is opted in by the reviewed asset", () => {
		const reviewed = new Set(cliNativeEndpoints.nativeDirectEndpoints);
		const missing = Object.values(WORK_NATIVE_ENDPOINTS).filter(
			(endpoint) => !reviewed.has(endpoint),
		);
		expect(missing).toEqual([]);
	});
});
