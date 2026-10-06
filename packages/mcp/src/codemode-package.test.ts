import { describe, expect, it } from "vite-plus/test";
import rootPackageJson from "../../../package.json";
import packageJson from "../package.json";

type PackageJson = {
	catalog?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

/**
 * Minor line only (e.g. "0.4" from "^0.4.3") — deliberately ignores patch.
 * The peer range stays a whole minor line wide (e.g. "^0.4.0") specifically
 * so a routine patch bump to the devDependency never requires a matching
 * edit here; only a minor/major bump (a real, potentially breaking change
 * for this pre-1.0 package) should force the peer range to move.
 */
function minorLine(version: string): string {
	const match = version.match(/(\d+)\.(\d+)\.\d+/);
	if (!match) throw new Error(`Unparseable semver-ish version: ${version}`);
	return `${match[1]}.${match[2]}`;
}

describe("@tedix/mcp-shared Code Mode SDK contract", () => {
	it("keeps the optional peer's minor line aligned with the SDK surface used by runtime code", () => {
		const typedPackageJson = packageJson as PackageJson;
		const declaredVersion =
			typedPackageJson.devDependencies?.["@cloudflare/codemode"];
		// The devDependency is spelled "catalog:"; the version lives in the root catalog.
		const codemodeVersion =
			declaredVersion === "catalog:"
				? (rootPackageJson as PackageJson).catalog?.["@cloudflare/codemode"]
				: declaredVersion;
		const peerVersion =
			typedPackageJson.peerDependencies?.["@cloudflare/codemode"];

		expect(codemodeVersion).toMatch(/^\^0\.\d+\.\d+$/);
		expect(peerVersion).toBeDefined();
		expect(minorLine(peerVersion as string)).toBe(
			minorLine(codemodeVersion as string),
		);
	});
});
