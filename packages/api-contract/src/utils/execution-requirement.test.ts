import { describe, expect, it } from "vite-plus/test";
import { resolveExecutionRequirement } from "./execution-requirement";

describe("resolveExecutionRequirement", () => {
	it("routes interactive browser work to a workstation", () => {
		expect(
			resolveExecutionRequirement({
				requiredCapabilities: ["repository_edit", "browser_session"],
			}),
		).toMatchObject({
			surface: "workstation",
			satisfiable: true,
			fallbackSurface: null,
		});
	});

	it("routes bounded validation to managed jobs with workstation fallback", () => {
		expect(
			resolveExecutionRequirement({
				requiredCapabilities: ["typecheck", "tests"],
			}),
		).toMatchObject({
			surface: "managed_job",
			satisfiable: true,
			fallbackSurface: "workstation",
		});
	});

	it("fails closed when the required surface is prohibited", () => {
		expect(
			resolveExecutionRequirement({
				requiredCapabilities: ["process"],
				prohibitedSurfaces: ["workstation"],
			}),
		).toMatchObject({ surface: "workstation", satisfiable: false });
	});
});
