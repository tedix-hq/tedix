import {
	type CloudflareResource,
	type InstallationManifest,
	type InstallationProfile,
	parseInstallationManifest,
} from "./schema";

type ResourceKind = CloudflareResource["kind"];
type SurfaceKind = InstallationManifest["surfaces"][number]["kind"];

/**
 * What each supported deployment profile must declare before it can be
 * certified `profile-ready`. The supported unit is the tenant product in a
 * customer-owned Cloudflare account, and a profile must never silently omit a
 * required governance or workstation dependency.
 *
 * Requirements are additive: smb includes developer, enterprise includes smb.
 */
export interface ProfileRequirements {
	profile: InstallationProfile;
	summary: string;
	/** Every listed surface kind must be declared. */
	requiredSurfaceKinds: SurfaceKind[];
	/** At least one surface kind from each group must be declared. */
	anyOfSurfaceKinds: SurfaceKind[][];
	/** Every listed resource kind must be declared with requirement=required. */
	requiredResourceKinds: ResourceKind[];
	/** Provider ids that must be declared required and ready (e.g. identity). */
	requiredProviders: string[];
	lifecycle: {
		backupRequired: boolean;
		restoreTestRequired: boolean;
		exportRequired: boolean;
	};
}

const DEVELOPER: ProfileRequirements = {
	profile: "developer",
	summary:
		"One organization and tedi: MCP tools, skills, Work Items, and inspectable memory, rationale, evidence, artifacts, policy, approvals, and audit",
	requiredSurfaceKinds: ["api"],
	anyOfSurfaceKinds: [],
	requiredResourceKinds: [
		"ai",
		"assets",
		"d1",
		"durable-object",
		"r2",
		"service",
		"workflow",
	],
	requiredProviders: ["identity-provider"],
	lifecycle: {
		backupRequired: false,
		restoreTestRequired: false,
		exportRequired: true,
	},
};

const SMB: ProfileRequirements = {
	profile: "smb",
	summary:
		"Several role- or department-specific tedis with team RBAC, shared apps and connections, schedules, budgets, approvals, backup, restore, and export",
	// A team needs the OS operator surface, not just the API.
	requiredSurfaceKinds: [...DEVELOPER.requiredSurfaceKinds, "os"],
	anyOfSurfaceKinds: [],
	requiredResourceKinds: [
		...DEVELOPER.requiredResourceKinds,
		"queue" as ResourceKind,
	].sort(),
	requiredProviders: DEVELOPER.requiredProviders,
	lifecycle: {
		backupRequired: true,
		restoreTestRequired: false,
		exportRequired: true,
	},
};

const ENTERPRISE: ProfileRequirements = {
	profile: "enterprise",
	summary:
		"A certified installation inside the customer's Cloudflare estate with identity integration, tenant isolation, retention, evidence export, and governed workstations",
	requiredSurfaceKinds: SMB.requiredSurfaceKinds,
	anyOfSurfaceKinds: SMB.anyOfSurfaceKinds,
	// Governed workstations and browser capability stop being optional.
	requiredResourceKinds: [
		...SMB.requiredResourceKinds,
		"browser" as ResourceKind,
		"container" as ResourceKind,
	].sort(),
	requiredProviders: SMB.requiredProviders,
	lifecycle: {
		backupRequired: true,
		restoreTestRequired: true,
		exportRequired: true,
	},
};

export const PROFILE_REQUIREMENTS: Record<
	InstallationProfile,
	ProfileRequirements
> = {
	developer: DEVELOPER,
	smb: SMB,
	enterprise: ENTERPRISE,
};

export interface ProfileReadinessIssue {
	code:
		| "surface.missing"
		| "surface.choice-missing"
		| "resource.missing"
		| "resource.not-required"
		| "provider.missing"
		| "provider.not-ready"
		| "lifecycle.backup"
		| "lifecycle.restore-test"
		| "lifecycle.export";
	message: string;
}

export interface ProfileReadiness {
	profile: InstallationProfile;
	ready: boolean;
	issues: ProfileReadinessIssue[];
}

/**
 * Check a manifest against its declared profile's requirements. This is what
 * the `profile-ready` certification level means: the declared topology covers
 * everything the profile's product promise needs, before any live-account
 * proof. Issues are sorted deterministically for CI use.
 */
export function certifyProfileReadiness(
	manifestInput: unknown,
): ProfileReadiness {
	const manifest = parseInstallationManifest(manifestInput);
	const requirements = PROFILE_REQUIREMENTS[manifest.organization.profile];
	const issues: ProfileReadinessIssue[] = [];

	const surfaceKinds = new Set(
		manifest.surfaces.map((surface) => surface.kind),
	);
	for (const kind of requirements.requiredSurfaceKinds) {
		if (!surfaceKinds.has(kind)) {
			issues.push({
				code: "surface.missing",
				message: `profile ${requirements.profile} requires a ${kind} surface`,
			});
		}
	}
	for (const group of requirements.anyOfSurfaceKinds) {
		if (!group.some((kind) => surfaceKinds.has(kind))) {
			issues.push({
				code: "surface.choice-missing",
				message: `profile ${requirements.profile} requires one of: ${group.join(", ")}`,
			});
		}
	}

	const requiredResourceKinds = new Set(
		manifest.resources
			.filter((resource) => resource.requirement === "required")
			.map((resource) => resource.kind),
	);
	const declaredResourceKinds = new Set(
		manifest.resources.map((resource) => resource.kind),
	);
	for (const kind of requirements.requiredResourceKinds) {
		if (!declaredResourceKinds.has(kind)) {
			issues.push({
				code: "resource.missing",
				message: `profile ${requirements.profile} requires a ${kind} resource`,
			});
		} else if (!requiredResourceKinds.has(kind)) {
			issues.push({
				code: "resource.not-required",
				message: `profile ${requirements.profile} requires the ${kind} resource to be requirement=required`,
			});
		}
	}

	const providers = new Map(
		manifest.providerPrerequisites.map((provider) => [provider.id, provider]),
	);
	for (const id of requirements.requiredProviders) {
		const provider = providers.get(id);
		if (!provider || provider.requirement !== "required") {
			issues.push({
				code: "provider.missing",
				message: `profile ${requirements.profile} requires provider prerequisite ${id}`,
			});
		} else if (provider.status === "missing") {
			issues.push({
				code: "provider.not-ready",
				message: `required provider ${id} is declared missing`,
			});
		}
	}

	if (
		requirements.lifecycle.backupRequired &&
		!manifest.lifecycle.backup.required
	) {
		issues.push({
			code: "lifecycle.backup",
			message: `profile ${requirements.profile} requires lifecycle backup`,
		});
	}
	if (
		requirements.lifecycle.restoreTestRequired &&
		!manifest.lifecycle.backup.restoreTestRequired
	) {
		issues.push({
			code: "lifecycle.restore-test",
			message: `profile ${requirements.profile} requires a restore test`,
		});
	}
	if (
		requirements.lifecycle.exportRequired &&
		!manifest.lifecycle.export.required
	) {
		issues.push({
			code: "lifecycle.export",
			message: `profile ${requirements.profile} requires lifecycle export`,
		});
	}

	issues.sort((left, right) =>
		`${left.code}\0${left.message}`.localeCompare(
			`${right.code}\0${right.message}`,
		),
	);
	return {
		profile: requirements.profile,
		ready: issues.length === 0,
		issues,
	};
}
