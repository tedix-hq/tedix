import { describe, expect, test } from "bun:test";
import { developerInstallationManifest } from "./developer-example";
import { certifyProfileReadiness, PROFILE_REQUIREMENTS } from "./profiles";

describe("PROFILE_REQUIREMENTS", () => {
	test("profiles are additive: smb includes developer, enterprise includes smb", () => {
		const developer = new Set(
			PROFILE_REQUIREMENTS.developer.requiredResourceKinds,
		);
		const smb = new Set(PROFILE_REQUIREMENTS.smb.requiredResourceKinds);
		const enterprise = new Set(
			PROFILE_REQUIREMENTS.enterprise.requiredResourceKinds,
		);
		for (const kind of developer) expect(smb.has(kind)).toBe(true);
		for (const kind of smb) expect(enterprise.has(kind)).toBe(true);
		expect(PROFILE_REQUIREMENTS.enterprise.lifecycle.restoreTestRequired).toBe(
			true,
		);
	});
});

describe("certifyProfileReadiness", () => {
	test("the sanitized developer example is developer profile-ready", () => {
		const readiness = certifyProfileReadiness(developerInstallationManifest);
		expect(readiness.profile).toBe("developer");
		expect(readiness.issues).toEqual([]);
		expect(readiness.ready).toBe(true);
	});

	test("the developer example is not enterprise-ready and says exactly why", () => {
		const manifest = structuredClone(
			developerInstallationManifest,
		) as unknown as {
			organization: { profile: string };
			capabilities: Array<{ accessPlan: { profiles: string[] } }>;
		};
		manifest.organization.profile = "enterprise";
		const readiness = certifyProfileReadiness(manifest);
		expect(readiness.ready).toBe(false);
		expect(readiness.issues.map((issue) => issue.code)).toEqual([
			"resource.not-required",
			"resource.not-required",
			"resource.not-required",
			"surface.missing",
		]);
	});

	test("a missing required provider prerequisite blocks readiness", () => {
		const manifest = structuredClone(
			developerInstallationManifest,
		) as unknown as {
			providerPrerequisites: unknown[];
			secretRequirements: unknown[];
		};
		manifest.providerPrerequisites = [];
		manifest.secretRequirements = [];
		const readiness = certifyProfileReadiness(manifest);
		expect(readiness.ready).toBe(false);
		expect(readiness.issues[0]?.code).toBe("provider.missing");
	});

	test("a declared-missing required provider blocks readiness", () => {
		const manifest = structuredClone(
			developerInstallationManifest,
		) as unknown as {
			providerPrerequisites: Array<{ status: string }>;
		};
		manifest.providerPrerequisites[0]!.status = "missing";
		const readiness = certifyProfileReadiness(manifest);
		expect(readiness.ready).toBe(false);
		expect(readiness.issues[0]?.code).toBe("provider.not-ready");
	});

	test("smb requires Tedix OS and lifecycle backup", () => {
		const manifest = structuredClone(
			developerInstallationManifest,
		) as unknown as {
			organization: { profile: string };
			lifecycle: { backup: { required: boolean } };
			resources: Array<{ id: string; requirement: string }>;
		};
		manifest.organization.profile = "smb";
		manifest.lifecycle.backup.required = false;
		const queue = manifest.resources.find(
			(resource) => resource.id === "event-queue",
		);
		queue!.requirement = "required";
		const readiness = certifyProfileReadiness(manifest);
		expect(readiness.ready).toBe(false);
		expect(readiness.issues.map((issue) => issue.code)).toEqual([
			"lifecycle.backup",
			"surface.missing",
		]);
	});
});
