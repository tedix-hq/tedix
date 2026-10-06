import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { DependencyLicenseEntry } from "./dependency-license-metadata";
import { evaluateDependencyLicensePolicy } from "./dependency-license-policy";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function entry(
	name: string,
	license: string,
	usage: DependencyLicenseEntry["usage"] = "runtime",
): DependencyLicenseEntry {
	return {
		evidence: "installed-package-manifest",
		integrity: "sha512-fixture",
		license,
		metadataSha256: "fixture",
		name,
		usage,
		version: "1.0.0",
	};
}

test("blocks denied and unasserted runtime licenses, not development ones", () => {
	const entries = [
		entry("denied", "BUSL-1.1"),
		entry("unasserted", "NOASSERTION"),
		entry("allowed", "MIT"),
		entry("tooling", "BUSL-1.1", "development"),
		{
			...entry("@fingerprintjs/fingerprintjs-pro", "SEE LICENSE IN LICENSE"),
			version: "3.11.6",
		},
	];
	const report = evaluateDependencyLicensePolicy(repositoryRoot, {
		schemaVersion: 1,
		lockfiles: [],
		entries,
		summary: { packages: entries.length, unresolved: 1 },
	});
	expect(report.status).toBe("blocked");
	expect(report.blockers.map((finding) => finding.name)).toEqual([
		"denied",
		"unasserted",
	]);
	expect(report.externalServiceTerms).toHaveLength(1);
});
