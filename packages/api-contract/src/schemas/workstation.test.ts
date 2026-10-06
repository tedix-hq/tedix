import { describe, expect, it } from "vite-plus/test";
import {
	createWorkstationEpisodeIds,
	createWorkstationLease,
	createWorkstationSnapshot,
	recommendWorkstationProfileId,
	RepositoryInspectionRequestSchema,
	RepositoryInspectionResultSchema,
	WORKSTATION_PROFILES,
	WorkstationBootstrapReadinessSchema,
	WorkstationEgressHeaderNameSchema,
	WorkstationEgressPolicySchema,
	WorkstationLeaseSchema,
	WorkstationProfileSchema,
	WorkstationRepoStrategySchema,
	WorkstationSchema,
	WorkstationSessionKindSchema,
} from "./workstation";

describe("workstation schemas", () => {
	it("bounds repository inspection requests and native response framing", () => {
		expect(
			RepositoryInspectionRequestSchema.parse({ operation: "status" }),
		).toEqual({
			operation: "status",
		});
		expect(
			RepositoryInspectionRequestSchema.safeParse({
				operation: "status",
				path: "a",
			}).success,
		).toBe(false);
		expect(
			RepositoryInspectionRequestSchema.safeParse({ operation: "diff" })
				.success,
		).toBe(false);
		expect(
			RepositoryInspectionRequestSchema.safeParse({
				operation: "read",
				path: "a".repeat(4097),
			}).success,
		).toBe(false);
		expect(
			RepositoryInspectionResultSchema.safeParse({
				kind: "git",
				dataBase64: "",
				stderrBase64: "",
				exitCode: 0,
				timedOut: false,
				truncated: false,
				entryCount: 201,
			}).success,
		).toBe(false);
		expect(
			RepositoryInspectionResultSchema.parse({
				baselineSha: "a".repeat(40),
				currentSha: "b".repeat(40),
				generationId: "generation-1",
				observedAt: "2026-09-22T00:00:00.000Z",
				nonAtomic: true,
				kind: "git",
				dataBase64: "",
				stderrBase64: "",
				exitCode: 0,
				timedOut: false,
				truncated: false,
				truncationReasons: [],
				files: [
					{
						path: "src/index.ts",
						status: "modified",
						rawStatus: "M",
						untracked: false,
					},
				],
			}),
		).toMatchObject({ nonAtomic: true, generationId: "generation-1" });
		expect(
			RepositoryInspectionResultSchema.safeParse({
				baselineSha: "a".repeat(40),
				currentSha: "b".repeat(40),
				generationId: "generation-1",
				observedAt: "2026-09-22T00:00:00.000Z",
				nonAtomic: true,
				kind: "git",
				dataBase64: "",
				stderrBase64: "",
				exitCode: 0,
				timedOut: false,
				truncated: true,
				truncationReasons: [],
			}).success,
		).toBe(false);
	});
	it("declares every initial workstation profile", () => {
		expect(Object.keys(WORKSTATION_PROFILES)).toEqual(["general"]);
		for (const profile of Object.values(WORKSTATION_PROFILES)) {
			expect(WorkstationProfileSchema.parse(profile)).toEqual(profile);
			expect(profile.capabilities.length).toBeGreaterThan(0);
			expect(profile.defaultAdapters.length).toBeGreaterThan(0);
			expect(profile.repoStrategy).toBe("clone");
		}
	});

	it("validates workstation repo strategies", () => {
		expect(WorkstationRepoStrategySchema.parse("clone")).toBe("clone");
		expect(WorkstationRepoStrategySchema.parse("artifact-fs")).toBe(
			"artifact-fs",
		);
		expect(WorkstationRepoStrategySchema.parse("git-api-workspace")).toBe(
			"git-api-workspace",
		);
		expect(WorkstationRepoStrategySchema.safeParse("personal-vm").success).toBe(
			false,
		);
		expect(
			WorkstationProfileSchema.parse({
				id: "general",
				title: "General",
				summary: "Coding profile",
				defaultEnvironment: "Sandbox",
				capabilities: ["repo"],
				defaultAdapters: ["sandbox-workstation"],
				collaboration: {
					mode: "collaborative",
					sharedWorkspace: true,
					multipleTediSeats: true,
				},
			}).repoStrategy,
		).toBe("clone");
	});

	it("creates a multi-seat workstation snapshot", () => {
		const workstation = createWorkstationSnapshot({
			organizationId: "org_tedix",
			profileId: "general",
			seats: [
				{ role: "lead", slug: "cto", tediId: "tedi-cto" },
				{ role: "collaborator", slug: "devops", tediId: "tedi-devops" },
			],
			status: "ready",
			metadata: {
				bodyAdapter: "tedix-sandbox-workstation",
				sandboxKind: "cloudflare-sandbox-workstation",
			},
		});

		expect(WorkstationSchema.parse(workstation)).toEqual(workstation);
		expect(workstation).toMatchObject({
			id: "ws_general_org-tedix_cto",
			profileId: "general",
			status: "ready",
			capabilities: expect.arrayContaining(["repo", "shell", "git"]),
			adapters: expect.arrayContaining([
				"codemode-runtime",
				"sandbox-workstation",
			]),
			seats: [
				{ role: "lead", slug: "cto", tediId: "tedi-cto" },
				{ role: "collaborator", slug: "devops", tediId: "tedi-devops" },
			],
		});
	});

	it("derives stable per-task workstation and lease ids", () => {
		expect(
			createWorkstationEpisodeIds({
				executionKey: "Kernel Run 123",
				organizationId: "org_tedix",
				profileId: "general",
				slug: "cto",
				tediId: "tedi-cto",
			}),
		).toEqual({
			leaseId: "wl_general_org-tedix_cto_episode_kernel-run-123",
			workstationId: "ws_general_org-tedix_cto_episode_kernel-run-123",
		});
	});

	it("creates a durable multi-participant workstation lease envelope", () => {
		const lease = createWorkstationLease({
			organizationId: "org_tedix",
			profileId: "general",
			seats: [
				{
					role: "lead",
					slug: "cto",
					tediId: "tedi-cto",
					permissionScopes: ["repo.write", "deploy.request"],
				},
				{
					role: "specialist",
					slug: "devops",
					tediId: "tedi-devops",
					permissionScopes: ["logs.read"],
				},
			],
			status: "active",
			createdAt: "2026-06-13T18:30:00.000Z",
			kernelRunId: "kernel-run-1",
			traceBundleId: "trace-bundle-1",
			workItemId: "work-item-1",
			sessions: [
				{
					id: "session-shell",
					kind: "shell",
					adapter: "sandbox-workstation",
					status: "ready",
					sessionKey: "coding-shell",
					participantId: null,
				},
				{
					id: "session-codemode",
					kind: "codemode",
					adapter: "codemode-runtime",
					status: "ready",
					sessionKey: "coding-code",
					participantId: null,
				},
			],
		});

		expect(WorkstationLeaseSchema.parse(lease)).toEqual(lease);
		expect(lease).toMatchObject({
			id: "wl_general_org-tedix_cto",
			workstationId: "ws_general_org-tedix_cto",
			profileId: "general",
			status: "active",
			kernelRunId: "kernel-run-1",
			traceBundleId: "trace-bundle-1",
			workItemId: "work-item-1",
			participants: [
				{
					id: "wl_general_org-tedix_cto_participant_cto",
					role: "lead",
					status: "active",
					tediId: "tedi-cto",
				},
				{
					id: "wl_general_org-tedix_cto_participant_devops",
					role: "specialist",
					status: "active",
					tediId: "tedi-devops",
				},
			],
			sessions: [
				{
					id: "session-shell",
					adapter: "sandbox-workstation",
					kind: "shell",
					leaseId: "wl_general_org-tedix_cto",
				},
				{
					id: "session-codemode",
					adapter: "codemode-runtime",
					kind: "codemode",
					leaseId: "wl_general_org-tedix_cto",
				},
			],
		});
	});

	it("accepts coding-specific workstation session kinds", () => {
		expect(WorkstationSessionKindSchema.parse("test-runner")).toBe(
			"test-runner",
		);
		expect(WorkstationSessionKindSchema.parse("codex")).toBe("codex");
		expect(WorkstationSessionKindSchema.parse("claude")).toBe("claude");
	});

	it("validates the coding bootstrap readiness contract", () => {
		const readiness = {
			toolsReady: true,
			secretsReady: true,
			repoReady: true,
			depsReady: false,
			environmentReady: false,
			installStatus: "missing",
			installProcessId: "bootstrap-install",
			lockfileHash: "abc123",
			packageManager: "bun",
			cacheKey: "general:profile-version:bun:abc123",
			cacheRestoredAt: null,
			cacheBackupRef: null,
			cacheBackupStatus: "missing",
			cacheBackupError: null,
			lastInstallExitCode: null,
			lastInstallArtifactRef: null,
			lastBootstrapError: null,
			nextAction: "start_install_process",
			nextCommand: "bun install --frozen-lockfile",
			dimensions: {
				toolsReady: true,
				secretsReady: true,
				repoReady: true,
				depsReady: false,
			},
		};

		expect(WorkstationBootstrapReadinessSchema.parse(readiness)).toEqual(
			readiness,
		);
		expect(
			WorkstationBootstrapReadinessSchema.parse({
				...readiness,
				cacheBackupStatus: "pending",
			}),
		).toMatchObject({ cacheBackupStatus: "pending" });
		expect(
			WorkstationBootstrapReadinessSchema.safeParse({
				...readiness,
				installStatus: "installing",
			}).success,
		).toBe(false);
		expect(
			WorkstationBootstrapReadinessSchema.parse({
				...readiness,
				installStatus: "timed_out",
				lastBootstrapError: "install process timed out",
				nextAction: "restart_install_process",
			}).installStatus,
		).toBe("timed_out");
	});

	it("validates workstation egress policy contract", () => {
		const parsed = WorkstationEgressPolicySchema.parse({
			allowedHosts: ["api.vendor.com"],
			injectHeaders: [
				{
					header: "Authorization",
					hosts: ["api.vendor.com"],
					value: { prefix: "Bearer ", secretRef: "VENDOR_API_KEY" },
				},
			],
			loggingMode: "deny_only",
		});

		expect(parsed).toMatchObject({
			allowedHosts: ["api.vendor.com"],
			loggingMode: "deny_only",
		});
		expect(parsed.injectHeaders?.[0]?.value.secretRef).toBe("VENDOR_API_KEY");
		expect(
			WorkstationEgressPolicySchema.parse({
				allowedHosts: ["api.github.com"],
			}).loggingMode,
		).toBe("deny_only");
		expect(
			WorkstationEgressHeaderNameSchema.safeParse("Authorization").success,
		).toBe(true);
		expect(
			WorkstationEgressHeaderNameSchema.safeParse("x-tedix-secret").success,
		).toBe(false);
		expect(WorkstationEgressHeaderNameSchema.safeParse("Host").success).toBe(
			false,
		);
	});

	it("keeps workstation recommendation coding-only", () => {
		expect(
			recommendWorkstationProfileId({
				objective: "CTO and DevOps need to edit repo code and run tests",
			}),
		).toBe("general");
		expect(
			recommendWorkstationProfileId({
				objective: "Investigate deployment logs and prepare a rollback",
			}),
		).toBe("general");
		expect(
			recommendWorkstationProfileId({
				objective: "Reply to a customer refund ticket from CRM context",
			}),
		).toBe("general");
		expect(
			recommendWorkstationProfileId({
				objective: "Publish a CMS landing page for a marketing campaign",
			}),
		).toBe("general");
		expect(
			recommendWorkstationProfileId({
				objective: "Research competitors and cite sources",
			}),
		).toBe("general");
		expect(
			recommendWorkstationProfileId({
				objective: "Check in on the tedi and continue the normal chat",
			}),
		).toBe("general");
	});
});
