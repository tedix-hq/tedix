import { describe, expect, it } from "vite-plus/test";
import {
	readTediEndpointCeiling,
	tediToolCeilingDenial,
} from "./tedi-tool-ceiling";
describe("configured tedi MCP ceiling", () => {
	it("denies administrative RPC, alternate transports and similarly named endpoints", () => {
		const allowed = ["support/get", "support/draft"];
		expect(tediToolCeilingDenial(allowed, "rpc", "support/get")).toBeNull();
		for (const [transport, endpoint] of [
			["rpc", "apps/delete"],
			["rpc", "support/getExtra"],
			["code", "support/get"],
			["external", "support/get"],
		])
			expect(tediToolCeilingDenial(allowed, transport!, endpoint)).toContain(
				"ceiling",
			);
	});
	it("fails closed on malformed policy and preserves an absent ceiling", () => {
		for (const raw of ["broken", "{}", "[3]", "[]"])
			expect(
				tediToolCeilingDenial(
					readTediEndpointCeiling(raw),
					"rpc",
					"support/get",
				),
			).toContain("ceiling");
		expect(
			tediToolCeilingDenial(readTediEndpointCeiling(null), "rpc", "apps/get"),
		).toBeNull();
	});
});
