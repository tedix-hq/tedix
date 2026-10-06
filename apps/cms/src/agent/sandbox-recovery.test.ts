import { describe, expect, it, vi } from "vite-plus/test";
import { getActiveCmsSiteForPermit } from "./cms-restore-permit";
import { listTenantBundleVersions } from "@tedix/provisioning/cms";
import {
	destroyPinnedCmsBuilderSandbox,
	stopPinnedCmsBuilderSandbox,
} from "./sandbox-recovery";

vi.mock("./cms-restore-permit", () => ({ getActiveCmsSiteForPermit: vi.fn() }));
vi.mock("@tedix/provisioning/cms", () => ({
	listTenantBundleVersions: vi.fn(),
}));

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVE_COMMIT = "a".repeat(40);
const FAILED_COMMIT = "c".repeat(40);
const ETAG = "b".repeat(64);
const pins = {
	orgSlug: "tedix-landing",
	expectedSiteId: SITE_ID,
	expectedVersion: 72,
	expectedBundleEtag: ETAG,
	expectedSourceCommit: ACTIVE_COMMIT,
	expectedFailedSourceCommit: FAILED_COMMIT,
	proofJobId: `cms-${SITE_ID}-e0-v73-s${FAILED_COMMIT}`,
	confirmMayInterruptInFlightBuild: true as const,
	reason: "Builder control channel is unresponsive after a failed build",
};

function fixture() {
	vi.mocked(getActiveCmsSiteForPermit).mockReset().mockResolvedValue({
		siteId: SITE_ID,
		slug: pins.orgSlug,
		restoreEpoch: 0,
	});
	vi.mocked(listTenantBundleVersions)
		.mockReset()
		.mockResolvedValue([
			{
				version: pins.expectedVersion,
				etag: ETAG,
				isActive: true,
				deployedAt: null,
				summary: null,
				sourceRevision: { kind: "artifacts_commit", value: ACTIVE_COMMIT },
			},
		]);
	const destroy = vi.fn(async () => undefined);
	const getSandboxForOrg = vi.fn(() => ({ destroy }));
	const get = vi.fn(async () => ({ name: "cms-theme-tedix-landing" }));
	const manifest = {
		version: pins.expectedVersion,
		etag: ETAG,
		sourceRevision: { kind: "artifacts_commit", value: ACTIVE_COMMIT },
	};
	const bucketGet = vi.fn(async () => ({
		size: 200,
		text: async () => JSON.stringify(manifest),
	}));
	const receipt = {
		jobId: pins.proofJobId,
		orgSlug: pins.orgSlug,
		phase: "failed",
		status: "failed",
		history: [
			{ phase: "preflight", status: "running", details: {} },
			{
				phase: "preflight",
				status: "complete",
				details: { sourceFileCount: 44 },
			},
			{ phase: "failed", status: "failed", details: {} },
		],
	};
	const storageGet = vi.fn(async () => ({
		size: 200,
		text: async () => JSON.stringify(receipt),
	}));
	const getDeployStatus = vi.fn(async (jobId: string) => ({
		jobId,
		status: "errored",
	}));
	const input = {
		pins,
		currentOrgSlug: pins.orgSlug,
		isPlatformAdmin: true,
		db: {} as D1Database,
		bundlesBucket: { get: bucketGet } as unknown as R2Bucket,
		storage: { get: storageGet } as unknown as R2Bucket,
		artifacts: { get } as never,
		getDeployStatus,
		getSandboxForOrg: getSandboxForOrg as never,
		stopTimeoutMs: 10,
	};
	return {
		input,
		destroy,
		getSandboxForOrg,
		get,
		bucketGet,
		storageGet,
		getDeployStatus,
		manifest,
		receipt,
	};
}

describe("stopPinnedCmsBuilderSandbox", () => {
	it("stops only the exact tenant after matching active D1, R2 and Artifacts source", async () => {
		const f = fixture();
		const result = await stopPinnedCmsBuilderSandbox(f.input);
		expect(result.status).toBe("stop_requested");
		expect(result.message).toMatch(/container exit was not observed/);
		expect(result.message).toMatch(/signal delivery is unverified/);
		expect(f.getSandboxForOrg).toHaveBeenCalledWith(pins.orgSlug);
		expect(f.destroy).toHaveBeenCalledOnce();
		expect(f.bucketGet).toHaveBeenCalledWith("tedix-landing/v72/manifest.json");
		expect(f.get).toHaveBeenCalledWith("cms-theme-tedix-landing");
		expect(f.storageGet).toHaveBeenCalledWith(
			`themes/deploy-status/${pins.proofJobId}.json`,
		);
		expect(f.getDeployStatus).toHaveBeenCalledWith(pins.proofJobId);
	});

	it("requires platform admin before reading or stopping", async () => {
		const f = fixture();
		await expect(
			stopPinnedCmsBuilderSandbox({ ...f.input, isPlatformAdmin: false }),
		).rejects.toThrow(/Platform admin/);
		expect(getActiveCmsSiteForPermit).not.toHaveBeenCalled();
		expect(f.destroy).not.toHaveBeenCalled();
	});

	it("requires explicit acknowledgment of a possible concurrent build interruption", async () => {
		for (const acknowledged of [false, undefined]) {
			const f = fixture();
			await expect(
				stopPinnedCmsBuilderSandbox({
					...f.input,
					pins: {
						...pins,
						confirmMayInterruptInFlightBuild: acknowledged,
					} as never,
				}),
			).rejects.toThrow(/Explicit acknowledgment/);
			expect(getActiveCmsSiteForPermit).not.toHaveBeenCalled();
			expect(f.destroy).not.toHaveBeenCalled();
		}
	});

	it("refuses a slug other than the authenticated tenant", async () => {
		const f = fixture();
		await expect(
			stopPinnedCmsBuilderSandbox({
				...f.input,
				pins: { ...pins, orgSlug: "other-site" },
			}),
		).rejects.toThrow(/slug must match/);
		expect(f.getSandboxForOrg).not.toHaveBeenCalled();
	});

	it("refuses a stale site ID, active version, etag or source commit", async () => {
		for (const changed of [
			{ expectedSiteId: "22222222-2222-4222-8222-222222222222" },
			{ expectedVersion: 71 },
			{ expectedBundleEtag: "c".repeat(64) },
			{ expectedSourceCommit: "d".repeat(40) },
		]) {
			const f = fixture();
			await expect(
				stopPinnedCmsBuilderSandbox({
					...f.input,
					pins: { ...pins, ...changed },
				}),
			).rejects.toThrow(/changed|proof job/);
			expect(f.destroy).not.toHaveBeenCalled();
		}
	});

	it("refuses a mismatched immutable manifest or missing Artifacts repo", async () => {
		const f = fixture();
		f.manifest.sourceRevision.value = "d".repeat(40);
		await expect(stopPinnedCmsBuilderSandbox(f.input)).rejects.toThrow(
			/manifest does not match/,
		);
		expect(f.destroy).not.toHaveBeenCalled();
		const g = fixture();
		g.get.mockRejectedValue(new Error("repository unavailable"));
		await expect(stopPinnedCmsBuilderSandbox(g.input)).rejects.toThrow(
			/repository unavailable/,
		);
		expect(g.destroy).not.toHaveBeenCalled();
	});

	it("requires failed exact-job receipt with completed preflight and terminal Workflow", async () => {
		for (const change of [
			{ jobId: "different-job" },
			{ orgSlug: "other-site" },
			{ status: "running" },
			{ history: [{ phase: "preflight", status: "running", details: {} }] },
		]) {
			const f = fixture();
			Object.assign(f.receipt, change);
			await expect(stopPinnedCmsBuilderSandbox(f.input)).rejects.toThrow(
				/Deploy proof/,
			);
			expect(f.destroy).not.toHaveBeenCalled();
		}
		const f = fixture();
		f.getDeployStatus.mockResolvedValue({
			jobId: pins.proofJobId,
			status: "running",
		});
		await expect(stopPinnedCmsBuilderSandbox(f.input)).rejects.toThrow(
			/Workflow is active/,
		);
		expect(f.destroy).not.toHaveBeenCalled();
	});

	it("rejects a proof job with a different site generation or source", async () => {
		for (const proofJobId of [
			`cms-${SITE_ID}-e0-v74-s${FAILED_COMMIT}`,
			`cms-${SITE_ID}-e1-v73-s${FAILED_COMMIT}`,
			`cms-${SITE_ID}-e0-v73-s${ACTIVE_COMMIT}`,
		]) {
			const f = fixture();
			await expect(
				stopPinnedCmsBuilderSandbox({
					...f.input,
					pins: { ...pins, proofJobId },
				}),
			).rejects.toThrow(/proof job|does not belong/);
			expect(f.storageGet).not.toHaveBeenCalled();
			expect(f.destroy).not.toHaveBeenCalled();
		}
	});

	it("rejects a failed-source pin that differs from the proof job", async () => {
		const f = fixture();
		await expect(
			stopPinnedCmsBuilderSandbox({
				...f.input,
				pins: { ...pins, expectedFailedSourceCommit: "d".repeat(40) },
			}),
		).rejects.toThrow(/Deploy proof job does not match/);
		expect(f.storageGet).not.toHaveBeenCalled();
		expect(f.destroy).not.toHaveBeenCalled();
	});

	it("rechecks the site and active source immediately before stopping", async () => {
		const f = fixture();
		vi.mocked(getActiveCmsSiteForPermit)
			.mockResolvedValueOnce({
				siteId: SITE_ID,
				slug: pins.orgSlug,
				restoreEpoch: 0,
			})
			.mockResolvedValueOnce({
				siteId: SITE_ID,
				slug: pins.orgSlug,
				restoreEpoch: 1,
			});
		await expect(stopPinnedCmsBuilderSandbox(f.input)).rejects.toThrow(
			/changed before Builder recovery/,
		);
		expect(f.destroy).not.toHaveBeenCalled();
	});

	it("reports an uncertain outcome when the stop RPC times out or rejects", async () => {
		const f = fixture();
		f.destroy.mockImplementation(() => new Promise<undefined>(() => undefined));
		const timeout = await stopPinnedCmsBuilderSandbox(f.input);
		expect(timeout.status).toBe("uncertain");
		expect(timeout.message).toMatch(/Do not repeat/);
		const g = fixture();
		g.destroy.mockRejectedValue(new Error("transport lost"));
		expect((await stopPinnedCmsBuilderSandbox(g.input)).status).toBe(
			"uncertain",
		);
	});
});

describe("destroyPinnedCmsBuilderSandbox", () => {
	const forcePins = { ...pins, confirmLoseBuilderDrafts: true as const };

	it("force-destroys only the exact tenant after the shared D1, R2, receipt and Workflow checks", async () => {
		const f = fixture();
		const result = await destroyPinnedCmsBuilderSandbox({
			...f.input,
			pins: forcePins,
			destroyTimeoutMs: 10,
		});
		expect(result.status).toBe("destroy_rpc_completed");
		expect(result.message).toMatch(/verify the exact provider instance exited/);
		expect(f.getSandboxForOrg).toHaveBeenCalledWith(pins.orgSlug);
		expect(f.destroy).toHaveBeenCalledOnce();
		expect(f.storageGet).toHaveBeenCalledWith(
			`themes/deploy-status/${pins.proofJobId}.json`,
		);
	});

	it("requires platform admin and explicit draft-loss acknowledgment before any read", async () => {
		const unauthorized = fixture();
		await expect(
			destroyPinnedCmsBuilderSandbox({
				...unauthorized.input,
				pins: forcePins,
				isPlatformAdmin: false,
			}),
		).rejects.toThrow(/Platform admin/);
		expect(unauthorized.destroy).not.toHaveBeenCalled();
		for (const acknowledged of [false, undefined]) {
			const f = fixture();
			await expect(
				destroyPinnedCmsBuilderSandbox({
					...f.input,
					pins: {
						...forcePins,
						confirmLoseBuilderDrafts: acknowledged,
					} as never,
				}),
			).rejects.toThrow(/draft loss/);
			expect(getActiveCmsSiteForPermit).not.toHaveBeenCalled();
			expect(f.destroy).not.toHaveBeenCalled();
		}
		const inFlight = fixture();
		await expect(
			destroyPinnedCmsBuilderSandbox({
				...inFlight.input,
				pins: {
					...forcePins,
					confirmMayInterruptInFlightBuild: false,
				} as never,
			}),
		).rejects.toThrow(/in-flight build interruption/);
		expect(inFlight.destroy).not.toHaveBeenCalled();
	});

	it("refuses a different tenant slug or stale site and source pins", async () => {
		for (const change of [
			{ orgSlug: "other-site" },
			{ expectedSiteId: "22222222-2222-4222-8222-222222222222" },
			{ expectedVersion: 71 },
			{ expectedBundleEtag: "c".repeat(64) },
			{ expectedSourceCommit: "d".repeat(40) },
			{ expectedFailedSourceCommit: "d".repeat(40) },
		]) {
			const f = fixture();
			await expect(
				destroyPinnedCmsBuilderSandbox({
					...f.input,
					pins: { ...forcePins, ...change },
				}),
			).rejects.toThrow(/slug must match|changed|proof job/);
			expect(f.destroy).not.toHaveBeenCalled();
		}
	});

	it("requires terminal failed proof and reports timeout or transport loss as uncertain", async () => {
		const stale = fixture();
		stale.getDeployStatus.mockResolvedValue({
			jobId: pins.proofJobId,
			status: "running",
		});
		await expect(
			destroyPinnedCmsBuilderSandbox({ ...stale.input, pins: forcePins }),
		).rejects.toThrow(/Workflow is active/);
		expect(stale.destroy).not.toHaveBeenCalled();

		const timeout = fixture();
		timeout.destroy.mockImplementation(
			() => new Promise<undefined>(() => undefined),
		);
		const timed = await destroyPinnedCmsBuilderSandbox({
			...timeout.input,
			pins: forcePins,
			destroyTimeoutMs: 10,
		});
		expect(timed.status).toBe("uncertain");
		expect(timed.message).toMatch(/Do not repeat/);
		expect(timed.message).toMatch(/SIGKILL may not have been attempted/);
		const lost = fixture();
		lost.destroy.mockRejectedValue(new Error("provider connection lost"));
		expect(
			(
				await destroyPinnedCmsBuilderSandbox({
					...lost.input,
					pins: forcePins,
				})
			).status,
		).toBe("uncertain");
	});
});
