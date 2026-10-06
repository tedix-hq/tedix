#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	checkPublicSurface,
	type ResolvedPublicWorkspace,
} from "./public-surface";

const SPDX_BY_CLASS = {
	"agpl-product": "AGPL-3.0-only",
	"apache-ecosystem": "Apache-2.0",
	"mit-ecosystem": "MIT",
} as const;

interface ReadinessPolicy {
	schemaVersion: 1;
	canonicalArtifacts: Array<{
		path: string;
		sha256: string;
		spdx: string | null;
		source: string;
	}>;
	requiredReviewArtifacts: Array<{ path: string; status: string }>;
	ratificationRequirements: {
		rootLicenseSpdx: "AGPL-3.0-only";
		workspaceManifestSpdxMustMatch: true;
		requiresCounselApproval: boolean;
		requiresOwnerLaunchApproval: true;
		/** Add only after the corresponding external decision has been recorded. */
		counselApprovalEvidence?: string;
		ownerLaunchApprovalEvidence?: string;
	};
}

export interface LicenseReadinessReport {
	schemaVersion: 1;
	status: "blocked" | "engineering-ready-pending-counsel" | "ratified";
	approvalStatus: "owner-approved-pending-counsel" | "ratified";
	errors: string[];
	pendingExternalDecisions: string[];
	canonicalArtifacts: Array<{
		path: string;
		sha256: string | null;
		expectedSha256: string;
		spdx: string | null;
		source: string;
		verified: boolean;
	}>;
	reviewArtifacts: Array<{ path: string; status: string; present: boolean }>;
	effectiveRoot: {
		declaredSpdx: string | null;
		expectedSpdx: string;
		packageManifestMatches: boolean;
		licenseSha256: string | null;
		expectedLicenseSha256: string;
		licenseMatches: boolean;
	};
	compatibility: {
		edges: Array<{
			dependencyGroup: string;
			from: string;
			fromSpdx: string;
			to: string;
			toSpdx: string;
			compatible: boolean;
			packageName: string;
			specifier: string;
		}>;
		incompatibleEdges: number;
	};
	workspaces: Array<{
		path: string;
		name: string | null;
		decision: string;
		licenseClass: string;
		intendedSpdx: string;
		declaredSpdx: string | null;
		manifestMatches: boolean;
	}>;
	summary: {
		artifactsVerified: number;
		manifestMismatches: number;
		reviewArtifactsPresent: number;
		workspaces: number;
	};
}

export function evaluateLicenseApproval(input: {
	errors: readonly string[];
	surfaceWarnings: readonly string[];
	reviewArtifacts: readonly {
		path: string;
		status: string;
		present: boolean;
	}[];
	requirements: ReadinessPolicy["ratificationRequirements"];
}): Pick<
	LicenseReadinessReport,
	"status" | "approvalStatus" | "pendingExternalDecisions"
> {
	const pendingExternalDecisions: string[] = [];
	const pendingReviews = input.reviewArtifacts.filter(
		(artifact) => artifact.present && artifact.status !== "approved",
	);
	for (const artifact of pendingReviews) {
		pendingExternalDecisions.push(
			`Review artifact awaits approval: ${artifact.path} (${artifact.status}).`,
		);
	}
	const counselPending =
		input.requirements.requiresCounselApproval &&
		!input.requirements.counselApprovalEvidence?.trim();
	if (counselPending) {
		pendingExternalDecisions.push(
			"Counsel must approve the active license boundary; no approval evidence is recorded.",
		);
	}
	if (
		input.requirements.requiresOwnerLaunchApproval &&
		!input.requirements.ownerLaunchApprovalEvidence?.trim()
	) {
		pendingExternalDecisions.push(
			"The owner must separately authorize public repository visibility and launch.",
		);
	}
	const licensePending =
		counselPending ||
		pendingReviews.length > 0 ||
		input.surfaceWarnings.length > 0;
	return {
		status:
			input.errors.length > 0
				? "blocked"
				: licensePending
					? "engineering-ready-pending-counsel"
					: "ratified",
		approvalStatus: licensePending
			? "owner-approved-pending-counsel"
			: "ratified",
		pendingExternalDecisions,
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function intendedSpdx(workspace: ResolvedPublicWorkspace): string {
	return SPDX_BY_CLASS[workspace.licenseClass];
}

/**
 * A permissive workspace published to npm (no `"private": true`) carries its
 * own LICENSE so the notice travels with the tarball. Everything else relies
 * on the root LICENSE, LICENSES/, and its manifest `license` field.
 */
function workspaceLicenseFile(
	repositoryRoot: string,
	workspace: ResolvedPublicWorkspace,
): { path: string; text: string } | null {
	if (workspace.licenseClass === "agpl-product") return null;
	const manifest = JSON.parse(
		readFileSync(
			resolve(repositoryRoot, workspace.path, "package.json"),
			"utf8",
		),
	) as { private?: boolean };
	if (manifest.private === true) return null;
	return {
		path: resolve(repositoryRoot, workspace.path, "LICENSE"),
		text: readFileSync(
			resolve(repositoryRoot, "LICENSES", `${intendedSpdx(workspace)}.txt`),
			"utf8",
		),
	};
}

export function writeWorkspaceLicenseFiles(repositoryRoot: string): void {
	for (const workspace of checkPublicSurface(repositoryRoot).resolved) {
		const licenseFile = workspaceLicenseFile(repositoryRoot, workspace);
		if (licenseFile) writeFileSync(licenseFile.path, licenseFile.text);
	}
}

export function generateLicenseReadiness(
	repositoryRoot: string,
): LicenseReadinessReport {
	const policy = JSON.parse(
		readFileSync(
			resolve(repositoryRoot, "scripts/oss/license-readiness-policy.json"),
			"utf8",
		),
	) as ReadinessPolicy;
	if (policy.schemaVersion !== 1)
		throw new Error("unsupported readiness policy");

	const surface = checkPublicSurface(repositoryRoot);
	const errors = [...surface.errors];
	const byPath = new Map(surface.resolved.map((entry) => [entry.path, entry]));
	const workspaces = surface.resolved.map((workspace) => {
		const intended = intendedSpdx(workspace);
		const licenseFile = workspaceLicenseFile(repositoryRoot, workspace);
		if (
			licenseFile &&
			(!existsSync(licenseFile.path) ||
				readFileSync(licenseFile.path, "utf8") !== licenseFile.text)
		) {
			errors.push(
				`workspace LICENSE missing or drifted from LICENSES/${intended}.txt: ${workspace.path}; run bun scripts/oss/license-readiness.ts --write`,
			);
		}
		return {
			path: workspace.path,
			name: workspace.name,
			decision: workspace.decision,
			licenseClass: workspace.licenseClass,
			intendedSpdx: intended,
			declaredSpdx: workspace.declaredLicense,
			manifestMatches: workspace.declaredLicense === intended,
		};
	});
	const compatibility = surface.resolved
		.flatMap((workspace) =>
			workspace.localDependencies.flatMap((dependency) =>
				dependency.targets.map((target) => {
					const targetWorkspace = byPath.get(target);
					if (!targetWorkspace)
						throw new Error(`unclassified target ${target}`);
					const compatible = !(
						workspace.decision === "public-ecosystem" &&
						dependency.group !== "devDependencies" &&
						targetWorkspace.licenseClass === "agpl-product"
					);
					return {
						dependencyGroup: dependency.group,
						from: workspace.path,
						fromSpdx: intendedSpdx(workspace),
						to: target,
						toSpdx: intendedSpdx(targetWorkspace),
						compatible,
						packageName: dependency.name,
						specifier: dependency.specifier,
					};
				}),
			),
		)
		.sort((left, right) =>
			`${left.from}:${left.to}:${left.dependencyGroup}`.localeCompare(
				`${right.from}:${right.to}:${right.dependencyGroup}`,
			),
		);
	const incompatible = compatibility.filter((edge) => !edge.compatible);
	for (const edge of incompatible) {
		errors.push(`incompatible license edge: ${edge.from} -> ${edge.to}`);
	}

	const canonicalArtifacts = policy.canonicalArtifacts.map((artifact) => {
		const path = resolve(repositoryRoot, artifact.path);
		const actual = existsSync(path) ? sha256(readFileSync(path, "utf8")) : null;
		const verified = actual === artifact.sha256;
		if (!verified) errors.push(`canonical artifact drift: ${artifact.path}`);
		return {
			...artifact,
			sha256: actual,
			expectedSha256: artifact.sha256,
			verified,
		};
	});
	const reviewArtifacts = policy.requiredReviewArtifacts.map((artifact) => {
		const present = existsSync(resolve(repositoryRoot, artifact.path));
		if (!present) errors.push(`missing review artifact: ${artifact.path}`);
		return { ...artifact, present };
	});
	const rootPackage = JSON.parse(
		readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
	) as { license?: string };
	const rootLicensePath = resolve(repositoryRoot, "LICENSE");
	const rootLicenseSha256 = existsSync(rootLicensePath)
		? sha256(readFileSync(rootLicensePath, "utf8"))
		: null;
	const expectedRootArtifact = policy.canonicalArtifacts.find(
		(artifact) =>
			artifact.spdx === policy.ratificationRequirements.rootLicenseSpdx,
	);
	if (!expectedRootArtifact) {
		throw new Error(
			`missing canonical artifact for ${policy.ratificationRequirements.rootLicenseSpdx}`,
		);
	}
	const effectiveRoot = {
		declaredSpdx: rootPackage.license ?? null,
		expectedSpdx: policy.ratificationRequirements.rootLicenseSpdx,
		packageManifestMatches:
			rootPackage.license === policy.ratificationRequirements.rootLicenseSpdx,
		licenseSha256: rootLicenseSha256,
		expectedLicenseSha256: expectedRootArtifact.sha256,
		licenseMatches: rootLicenseSha256 === expectedRootArtifact.sha256,
	};
	if (!effectiveRoot.packageManifestMatches) {
		errors.push(
			`root package license mismatch: declares ${effectiveRoot.declaredSpdx ?? "no license"}; expected ${effectiveRoot.expectedSpdx}`,
		);
	}
	if (!effectiveRoot.licenseMatches) {
		errors.push(
			`root LICENSE mismatch: sha256 ${effectiveRoot.licenseSha256 ?? "missing"}; expected ${effectiveRoot.expectedLicenseSha256}`,
		);
	}
	const manifestMismatches = workspaces.filter(
		(workspace) => !workspace.manifestMatches,
	);
	for (const workspace of manifestMismatches) {
		errors.push(
			`effective manifest mismatch: ${workspace.path} declares ${workspace.declaredSpdx ?? "no license"}; expected ${workspace.intendedSpdx}`,
		);
	}

	const approval = evaluateLicenseApproval({
		errors,
		surfaceWarnings: surface.warnings,
		reviewArtifacts,
		requirements: policy.ratificationRequirements,
	});
	return {
		schemaVersion: 1,
		...approval,
		errors: errors.sort(),
		canonicalArtifacts,
		reviewArtifacts,
		effectiveRoot,
		compatibility: {
			edges: compatibility,
			incompatibleEdges: incompatible.length,
		},
		workspaces,
		summary: {
			artifactsVerified: canonicalArtifacts.filter(
				(artifact) => artifact.verified,
			).length,
			manifestMismatches: manifestMismatches.length,
			reviewArtifactsPresent: reviewArtifacts.filter(
				(artifact) => artifact.present,
			).length,
			workspaces: workspaces.length,
		},
	};
}

if (import.meta.main) {
	const repositoryRoot = resolve(import.meta.dirname, "../..");
	if (process.argv.includes("--write"))
		writeWorkspaceLicenseFiles(repositoryRoot);
	const report = generateLicenseReadiness(repositoryRoot);
	if (process.argv.includes("--check")) {
		for (const error of report.errors) console.error(error);
		if (report.errors.length === 0)
			console.log(
				`license readiness ok: ${report.summary.workspaces} workspaces, ${report.compatibility.edges.length} local dependency edges`,
			);
	} else if (!process.argv.includes("--write")) {
		console.log(stableJson(report).trim());
	}
	if (report.errors.length > 0) process.exit(1);
}
