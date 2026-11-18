import type { Tedi } from "@tedix/db/schema/tedis";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	createDbClient: vi.fn(),
	decryptTediSecret: vi.fn(),
	getAllTediSecrets: vi.fn(),
	getOrganizationById: vi.fn(),
	getRuntimeProfileById: vi.fn(),
	getSystemDefaultRuntimeProfile: vi.fn(),
	lookupTediByHostname: vi.fn(),
}));

vi.mock("@tedix/db/client", () => ({
	createDbClient: mocks.createDbClient,
}));

vi.mock("@tedix/db/queries/control-plane/definitions", () => ({
	getRuntimeProfileById: mocks.getRuntimeProfileById,
	getSystemDefaultRuntimeProfile: mocks.getSystemDefaultRuntimeProfile,
}));

vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.getOrganizationById,
}));

vi.mock("@tedix/db/queries/tedi-secrets", () => ({
	getAllTediSecrets: mocks.getAllTediSecrets,
}));

vi.mock("@tedix/db/utils/secrets-encryption", () => ({
	decryptTediSecret: mocks.decryptTediSecret,
}));

vi.mock("@tedix/db/utils/tedi-routing", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/utils/tedi-routing")>()),
	lookupTediByHostname: mocks.lookupTediByHostname,
}));

import {
	invalidateResolveCache,
	isRoutableTediStatus,
	resolveTedi,
} from "./resolve";

describe("isRoutableTediStatus", () => {
	it("only routes active tedis", () => {
		expect(isRoutableTediStatus("active")).toBe(true);
		expect(isRoutableTediStatus("paused")).toBe(false);
		expect(isRoutableTediStatus("provisioning")).toBe(false);
		expect(isRoutableTediStatus("error")).toBe(false);
		expect(isRoutableTediStatus("archived")).toBe(false);
		expect(isRoutableTediStatus(null)).toBe(false);
	});
});

describe("resolveTedi", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		invalidateResolveCache();
		mocks.createDbClient.mockReturnValue("db");
		mocks.getAllTediSecrets.mockResolvedValue([]);
		mocks.getRuntimeProfileById.mockResolvedValue(null);
		// A tedi with null control-plane FKs resolves the published system
		// defaults instead of a compiled-in id.
		mocks.getSystemDefaultRuntimeProfile.mockResolvedValue(null);
		mocks.getOrganizationById.mockResolvedValue(null);
	});

	it("rechecks status before serving a cached config", async () => {
		const hostname = "cto.tedi.tedix.dev";
		mocks.lookupTediByHostname
			.mockResolvedValueOnce(buildTedi({ status: "active" }))
			.mockResolvedValueOnce(buildTedi({ status: "paused" }));

		const first = await resolveTedi(
			{} as D1Database,
			hostname,
			"production",
			undefined,
			undefined,
			undefined,
			{},
		);
		const second = await resolveTedi(
			{} as D1Database,
			hostname,
			"production",
			undefined,
			undefined,
			undefined,
			{},
		);

		expect(first?.id).toBe("tedi-1");
		expect(second).toBeNull();
		expect(mocks.lookupTediByHostname).toHaveBeenCalledTimes(2);
	});

	it.each([
		"policyPackId",
		"runtimeProfileId",
		"workspaceTemplateSetId",
		"updatedAt",
	] as const)(
		"rebuilds cached config when fresh D1 %s changes",
		async (field) => {
			const first = buildTedi({ status: "active" });
			const second = { ...first, [field]: "changed-revision" };
			mocks.lookupTediByHostname
				.mockResolvedValueOnce(first)
				.mockResolvedValueOnce(first)
				.mockResolvedValueOnce(second);
			mocks.getRuntimeProfileById.mockResolvedValue({ config: {} });
			const resolve = () =>
				resolveTedi(
					{} as D1Database,
					"tedi-1.tedi.tedix.dev",
					"production",
					undefined,
					undefined,
					undefined,
					{},
				);
			const initial = await resolve();
			expect(await resolve()).toBe(initial);
			expect(await resolve()).not.toBe(initial);
			expect(
				mocks.getRuntimeProfileById.mock.calls.length +
					mocks.getSystemDefaultRuntimeProfile.mock.calls.length,
			).toBe(2);
		},
	);

	it("fails resolution instead of dropping an undecryptable secret", async () => {
		mocks.lookupTediByHostname.mockResolvedValueOnce(buildTedi());
		mocks.getAllTediSecrets.mockResolvedValueOnce([
			{ name: "GITHUB_PAT", encryptedValue: "a" },
			{ name: "DESCOPE_ACCESS_KEY", encryptedValue: "b" },
		]);
		mocks.decryptTediSecret.mockResolvedValueOnce("ok").mockRejectedValueOnce(
			new Error("bad key with signed-token", {
				cause: new Error("private decrypt context"),
			}),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const failure = await resolveTedi(
			{} as D1Database,
			"cto.tedi.tedix.dev",
			"production",
			"master-key",
		).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(
			/Unable to decrypt 1\/2 secrets for tedi/,
		);
		expect((failure as Error).message).not.toContain("DESCOPE_ACCESS_KEY");
		expect((failure as Error).message).not.toContain("signed-token");
		const diagnostic = errorSpy.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.find((entry) => entry?.event === "resolve.secret_decryption_failed");
		expect(diagnostic).toMatchObject({
			component: "tedi.resolve",
			outcome: "unavailable",
			exception: {
				message: "Content omitted",
				cause: { message: "Content omitted" },
			},
		});
		const serialized = JSON.stringify(diagnostic);
		expect(serialized).not.toContain("DESCOPE_ACCESS_KEY");
		expect(serialized).not.toContain("signed-token");
		expect(serialized).not.toContain("private decrypt context");
	});

	it("keeps optional lookup fallbacks while logging content-free causes", async () => {
		mocks.lookupTediByHostname.mockResolvedValueOnce(buildTedi());
		const privateError = new Error("tedi-1 private access token", {
			cause: new Error("org-1 private query detail"),
		});
		mocks.getSystemDefaultRuntimeProfile.mockRejectedValueOnce(privateError);
		mocks.getOrganizationById.mockRejectedValueOnce(privateError);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const config = await resolveTedi(
				{} as D1Database,
				"cto.tedi.tedix.dev",
				"production",
				undefined,
				undefined,
				undefined,
				{},
			);
			expect(config).not.toBeNull();
			const diagnostics = warnSpy.mock.calls
				.map(([entry]) => entry as Record<string, unknown>)
				.filter((entry) => String(entry?.event).startsWith("resolve."));
			expect(diagnostics.map((entry) => entry.event).sort()).toEqual(
				[
					"resolve.runtime_profile_load_failed",
					"resolve.organization_load_failed",
				].sort(),
			);
			for (const diagnostic of diagnostics) {
				expect(diagnostic).toMatchObject({
					component: "tedi.resolve",
					outcome: "unavailable",
					exception: {
						message: "Content omitted",
						cause: { message: "Content omitted" },
					},
				});
				const serialized = JSON.stringify(diagnostic);
				expect(serialized).not.toContain("tedi-1");
				expect(serialized).not.toContain("org-1");
				expect(serialized).not.toContain("private access token");
				expect(serialized).not.toContain("private query detail");
			}
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("defaults a missing runtime kind to agent", async () => {
		mocks.lookupTediByHostname.mockResolvedValueOnce(
			buildTedi({ runtimeKind: null as unknown as Tedi["runtimeKind"] }),
		);

		const config = await resolveTedi(
			{} as D1Database,
			"cto.tedi.tedix.dev",
			"production",
			undefined,
			undefined,
			undefined,
			{},
		);

		expect(config?.runtimeKind).toBe("agent");
	});

	it("parses workstation egress host policy from runtime profile config", async () => {
		mocks.lookupTediByHostname.mockResolvedValueOnce(
			buildTedi({ runtimeProfileId: "runtime_profile_coding" }),
		);
		mocks.getRuntimeProfileById.mockResolvedValueOnce({
			config: {
				runtimePolicy: {
					workstationEgress: {
						allowedHosts: ["api.github.com"],
					},
				},
			},
		});

		const config = await resolveTedi(
			{} as D1Database,
			"cto.tedi.tedix.dev",
			"production",
			undefined,
			undefined,
			undefined,
			{},
		);

		expect(config?.workstationEgress).toMatchObject({
			allowedHosts: ["api.github.com"],
		});
	});
});

function buildTedi(overrides: Partial<Tedi> = {}): Tedi {
	return {
		avatar: null,
		billingState: "warm",
		budgets: null,
		channels: null,
		runtimeStatus: "unknown",
		createdAt: "2026-06-12T00:00:00.000Z",
		cronJobs: null,
		descopeMcpResourceId: null,
		descopeUserId: null,
		displayName: "CTO",
		externalRef: null,
		governanceOverride: null,
		id: "tedi-1",
		idleSince: null,
		installedPlugins: null,
		installedSkills: null,
		isolateAgentId: null,
		language: null,
		lastActivityAt: null,
		lastBackupHandles: null,
		lastHeartbeatAt: null,
		lastSeenAt: null,
		lastSyncAt: null,
		lastSyncResult: null,
		mcpCapabilityProfile: "standard",
		name: "CTO",
		runtimeOverrides: null,
		organizationId: "org-1",
		ownerUserId: null,
		ownerTeam: null,
		dataSensitivity: null,
		justification: null,
		personality: null,
		placementId: null,
		bodyGenerationExternalId: null,
		bodyGenerationHeartbeatAt: null,
		bodyGenerationId: null,
		bodyGenerationKind: null,
		bodyGenerationStatus: null,
		bodyGenerationTokenExpiresAt: null,
		bodyGenerationTokenHash: null,
		policyPackId: null,
		r2BucketName: null,
		quietHours: null,
		repoConfig: null,
		retiredAt: null,
		retiredSlug: null,
		runtimeKind: "agent",
		runtimeProfileId: null,
		runtimeState: "standby",
		scope: "organization",
		selfImprovementPolicy: null,
		slug: "cto",
		status: "active",
		tags: null,
		timezone: null,
		toolPolicy: null,
		updatedAt: "2026-06-12T00:00:00.000Z",
		workerName: null,
		workspaceTemplateSetId: null,
		...overrides,
	};
}
