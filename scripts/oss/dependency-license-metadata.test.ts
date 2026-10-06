import { describe, expect, test } from "bun:test";
import {
	lockedPackages,
	runtimePackageKeys,
} from "./dependency-license-metadata";

const lockfile = JSON.stringify({
	lockfileVersion: 1,
	workspaces: {
		"": {
			dependencies: { runtime: "^1.0.0" },
			devDependencies: { tooling: "^2.0.0" },
		},
	},
	packages: {
		runtime: [
			"runtime@1.0.0",
			"",
			{ dependencies: { transitive: "^3.0.0" } },
			"sha512-runtime",
		],
		tooling: ["tooling@2.0.0", "", {}, "sha512-tooling"],
		transitive: ["transitive@3.1.0", "", {}, "sha512-transitive"],
		aliased: ["aliased@npm:real@4.0.0", "", {}, "sha512-real"],
	},
});

describe("dependency license metadata", () => {
	test("reads exact locked versions and their integrity", () => {
		expect([...lockedPackages([lockfile])].sort()).toEqual([
			["real@4.0.0", "sha512-real"],
			["runtime@1.0.0", "sha512-runtime"],
			["tooling@2.0.0", "sha512-tooling"],
			["transitive@3.1.0", "sha512-transitive"],
		]);
	});

	test("rejects a package locked twice with different integrity", () => {
		const conflicting = JSON.stringify({
			packages: { runtime: ["runtime@1.0.0", "", {}, "sha512-other"] },
		});
		expect(() => lockedPackages([lockfile, conflicting])).toThrow(
			"conflicting lock integrity for runtime@1.0.0",
		);
	});

	test("marks only packages reachable from workspace dependencies as runtime", () => {
		expect([...runtimePackageKeys([lockfile])].sort()).toEqual([
			"runtime@1.0.0",
			"transitive@3.1.0",
		]);
	});
});
