import { describe, expect, it } from "vite-plus/test";
import { workFleetContractRouter } from "./work-fleet";

describe("Work fleet router", () => {
	it("mounts the derived control-tower projection", () => {
		expect(Object.keys(workFleetContractRouter)).toEqual(["getControlTower"]);
	});
});
