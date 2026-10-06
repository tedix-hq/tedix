#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	type DependencyLicenseEntry,
	type DependencyLicenseRegistry,
	generateDependencyLicenseMetadata,
} from "./dependency-license-metadata";
import { generateReleaseEvidence } from "./release-evidence";

interface Policy {
	schemaVersion: 1;
	deniedRuntimeLicenses: string[];
	externalServiceExceptions: Array<{
		package: string;
		classification: string;
		rationale: string;
	}>;
}

interface Finding {
	license: string;
	name: string;
	reason: string;
	version: string;
}

function key(entry: Pick<DependencyLicenseEntry, "name" | "version">): string {
	return `${entry.name}@${entry.version}`;
}

export function evaluateDependencyLicensePolicy(
	repositoryRoot: string,
	registry: DependencyLicenseRegistry,
) {
	const policy = JSON.parse(
		readFileSync(
			resolve(repositoryRoot, "scripts/oss/dependency-license-policy.json"),
			"utf8",
		),
	) as Policy;
	const runtime = registry.entries.filter((entry) => entry.usage === "runtime");
	const exceptionByPackage = new Map(
		policy.externalServiceExceptions.map((entry) => [entry.package, entry]),
	);
	const blockers: Finding[] = [];
	const externalServiceTerms = [];
	for (const entry of runtime) {
		const exception = exceptionByPackage.get(key(entry));
		if (exception) {
			externalServiceTerms.push({
				...exception,
				license: entry.license,
				metadataEvidence: `${entry.evidence}:sha256:${entry.metadataSha256}`,
			});
			continue;
		}
		if (entry.license === "NOASSERTION") {
			blockers.push({
				license: entry.license,
				name: entry.name,
				reason: "runtime dependency has no license assertion",
				version: entry.version,
			});
		} else if (entry.license.startsWith("SEE LICENSE")) {
			blockers.push({
				license: entry.license,
				name: entry.name,
				reason: "runtime dependency license file is not resolved or excepted",
				version: entry.version,
			});
		} else if (policy.deniedRuntimeLicenses.includes(entry.license)) {
			blockers.push({
				license: entry.license,
				name: entry.name,
				reason: "runtime dependency uses a denied source-available license",
				version: entry.version,
			});
		}
	}
	for (const exception of policy.externalServiceExceptions) {
		if (!runtime.some((entry) => key(entry) === exception.package)) {
			blockers.push({
				license: "NOASSERTION",
				name: exception.package,
				reason: "stale external-service exception",
				version: "",
			});
		}
	}
	const evidenceDirectory = mkdtempSync(
		resolve(tmpdir(), "tedix-dependency-policy-"),
	);
	try {
		generateReleaseEvidence(repositoryRoot, {
			dependencyLicenses: registry,
			out: evidenceDirectory,
			ref: "HEAD",
		});
		const inventory = JSON.parse(
			readFileSync(
				resolve(evidenceDirectory, "license-inventory.json"),
				"utf8",
			),
		) as {
			dependencies: Array<{
				ecosystem: string;
				license: string;
				name: string;
				usage: string;
				version: string | null;
			}>;
		};
		for (const entry of inventory.dependencies) {
			if (
				entry.ecosystem !== "npm" &&
				entry.usage === "runtime" &&
				entry.license === "NOASSERTION"
			) {
				blockers.push({
					license: entry.license,
					name: `${entry.ecosystem}:${entry.name}`,
					reason:
						"shipped non-npm input has no deterministic license assertion",
					version: entry.version ?? "unresolved",
				});
			}
		}
	} finally {
		rmSync(evidenceDirectory, { force: true, recursive: true });
	}
	blockers.sort((left, right) =>
		`${left.name}@${left.version}`.localeCompare(
			`${right.name}@${right.version}`,
		),
	);
	externalServiceTerms.sort((left, right) =>
		left.package.localeCompare(right.package),
	);
	return {
		schemaVersion: 1,
		status: blockers.length === 0 ? "release-ready" : "blocked",
		blockers,
		externalServiceTerms,
		summary: {
			blockedRuntimePackages: blockers.length,
			developmentPackages: registry.entries.length - runtime.length,
			externalServiceExceptions: externalServiceTerms.length,
			runtimePackages: runtime.length,
			unresolvedRuntimePackages: blockers.filter(
				(finding) => finding.license === "NOASSERTION",
			).length,
			unresolvedNpmRuntimePackages: blockers.filter(
				(finding) =>
					finding.license === "NOASSERTION" &&
					!finding.name.startsWith("container:") &&
					!finding.name.startsWith("pypi:"),
			).length,
		},
	};
}

if (import.meta.main) {
	const repositoryRoot = resolve(import.meta.dirname, "../..");
	const report = evaluateDependencyLicensePolicy(
		repositoryRoot,
		await generateDependencyLicenseMetadata(repositoryRoot),
	);
	for (const blocker of report.blockers) {
		console.error(
			`${blocker.name}@${blocker.version} (${blocker.license}): ${blocker.reason}`,
		);
	}
	if (report.blockers.length > 0) {
		console.error(
			`dependency license policy failed: ${report.blockers.length} runtime findings`,
		);
		process.exit(1);
	}
	console.log(
		`dependency license policy ok: ${report.summary.runtimePackages} runtime, ${report.summary.developmentPackages} development packages`,
	);
}
