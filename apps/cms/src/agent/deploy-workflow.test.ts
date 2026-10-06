import { describe, expect, it, vi } from "vite-plus/test";
import { NonRetryableError } from "cloudflare:workflows";
import { getSiteBuilderSandbox } from "../sandbox";
import {
	CmsUnknownProcessOutcomeError,
	withExactCmsSiteRestorePermit,
} from "./cms-restore-permit";
import {
	CMS_BUILD_OBSERVATION_GRACE_MS,
	CMS_BUILD_CONTROL_RPC_TIMEOUT_MS,
	CMS_BUILD_TIMEOUT_MS,
	runCmsSandboxBuildToCompletion,
} from "./build-runner";
import { removeDeployAttemptWorkspace } from "./deploy-attempt-workspace";
import {
	CMS_BUILD_PREPARATION_BUDGET_MS,
	CMS_SNAPSHOT_STAGING_BUDGET_MS,
	DeployWorkflow,
	deployStatusKey,
} from "./deploy-workflow";
import { cleanupStagedBundle } from "./deploy-staging";
import { listTenantBundleVersions } from "@tedix/provisioning/cms";
import { rollbackCmsTenantBundle } from "./storage";
import { rewriteTenantLocaleConfig } from "./deploy-locale-config";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("cloudflare:workflows", () => ({
	NonRetryableError: class NonRetryableError extends Error {},
}));
vi.mock("../sandbox", () => ({ getSiteBuilderSandbox: vi.fn() }));
vi.mock("./cms-restore-permit", () => ({
	CmsUnknownProcessOutcomeError: class CmsUnknownProcessOutcomeError extends Error {},
	withExactCmsSiteRestorePermit: vi.fn(),
}));
vi.mock("@tedix/provisioning/cms", () => ({
	listTenantBundleVersions: vi.fn(),
}));
vi.mock("./storage", () => ({
	rollbackCmsTenantBundle: vi.fn(),
	getCmsTemplateSelection: vi.fn(async () => null),
	getCmsDefaultLocale: vi.fn(async () => "en"),
	getCmsPublicBuildRoute: vi.fn(async () => ({
		publicSiteUrl: "https://acme.test",
		publicPathPrefix: "",
	})),
}));
vi.mock("./build-runner", () => ({
	CMS_BUILD_TIMEOUT_MS: 8 * 60 * 1000,
	CMS_BUILD_OBSERVATION_GRACE_MS: 10_000,
	CMS_BUILD_CONTROL_RPC_TIMEOUT_MS: 90_000,
	resolveCmsPrivacyBannerEnabled: vi.fn(async () => false),
	runCmsSandboxBuildToCompletion: vi.fn(),
}));
vi.mock("./deploy-attempt-workspace", () => ({
	createDeployAttemptWorkspace: vi.fn(async () => ({
		path: "/attempt",
		stagingAttemptId: "a1",
	})),
	clearDeployAttemptBuildOutput: vi.fn(async () => undefined),
	removeDeployAttemptWorkspace: vi.fn(async () => undefined),
}));
vi.mock("./template-sync", () => ({
	resyncTemplate: vi.fn(async () => ({ copied: [], skipped: [] })),
}));
vi.mock("./source-provenance", () => ({
	digestEditableThemeSource: vi.fn(async () => ({
		digest: "pinned",
		fileCount: 1,
	})),
	requirePinnedEditableThemeSource: vi.fn(async () => ({
		digest: "pinned",
		fileCount: 1,
	})),
	materializeEditableThemeSource: vi.fn(),
}));
vi.mock("./node-modules-backup", () => ({
	restoreNodeModulesBackup: vi.fn(async () => ({ hit: true })),
	saveNodeModulesBackup: vi.fn(),
}));

function workflowFixture(siteId?: string) {
	const get = vi.fn(async () => null);
	const put = vi.fn(async (_key: string, _body: unknown) => undefined);
	const env = {
		DB: {},
		SITE_BUILDER_STORAGE: { get, put },
		ENVIRONMENT: "production",
	};
	const workflow = Object.create(DeployWorkflow.prototype) as DeployWorkflow;
	Object.defineProperty(workflow, "env", { value: env });
	const event = {
		instanceId: "cms-deploy-acme-test",
		payload: {
			siteId,
			restoreEpoch: 0,
			orgSlug: "acme",
			nextBundleVersion: 2,
			expectedActiveVersion: 1,
		},
	};
	return { workflow, event, env, get, put };
}

describe("DeployWorkflow exact-site lifecycle", () => {
	it("fails a legacy slug-only replay before writing even the queued receipt", async () => {
		const { workflow, event, put } = workflowFixture();
		const step = { do: vi.fn() };
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"no pinned site ID and restore epoch",
		);
		expect(put).not.toHaveBeenCalled();
		expect(step.do).not.toHaveBeenCalled();
		expect(withExactCmsSiteRestorePermit).not.toHaveBeenCalled();
	});

	it("holds the exact-site permit through the queued R2 status write", async () => {
		const { workflow, event, put } = workflowFixture("site-original");
		let releasePut!: () => void;
		const pendingPut = new Promise<void>((resolve) => {
			releasePut = resolve;
		});
		let enteredPut!: () => void;
		const putEntered = new Promise<void>((resolve) => {
			enteredPut = resolve;
		});
		put.mockImplementationOnce(async () => {
			enteredPut();
			await pendingPut;
		});
		let inFlight = 0;
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
			async (_db, site, operation) => {
				expect(site).toEqual({
					siteId: "site-original",
					slug: "acme",
					restoreEpoch: 0,
				});
				inFlight++;
				try {
					return await operation();
				} finally {
					inFlight--;
				}
			},
		);
		const step = {
			do: vi.fn(async () => {
				throw new Error("stop after queued");
			}),
		};
		const run = workflow.run(event as never, step as never);
		await putEntered;
		expect(inFlight).toBe(1);
		expect(put).toHaveBeenCalledWith(
			deployStatusKey(event.instanceId),
			expect.any(String),
		);
		releasePut();
		await expect(run).rejects.toThrow("stop after queued");
		expect(inFlight).toBe(0);
	});

	it("keeps the snapshot permit while a sandbox call remains in flight after site close", async () => {
		const { workflow, event } = workflowFixture("site-original");
		let releaseSandbox!: () => void;
		const pendingSandbox = new Promise<void>((resolve) => {
			releaseSandbox = resolve;
		});
		let enteredSandbox!: () => void;
		const sandboxEntered = new Promise<void>((resolve) => {
			enteredSandbox = resolve;
		});
		vi.mocked(getSiteBuilderSandbox).mockReturnValue({
			pathExists: vi.fn(async () => {
				enteredSandbox();
				await pendingSandbox;
				return false;
			}),
		} as never);
		let closed = false;
		let inFlight = 0;
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
			async (_db, site, operation) => {
				expect(site).toEqual({
					siteId: "site-original",
					slug: "acme",
					restoreEpoch: 0,
				});
				if (closed) throw new Error("site closed");
				inFlight++;
				try {
					return await operation();
				} finally {
					inFlight--;
				}
			},
		);
		const step = {
			do: vi.fn(
				async (
					name: string,
					_options: unknown,
					callback: () => Promise<unknown>,
				) => {
					if (name === "preflight") return { digest: "pinned", fileCount: 1 };
					if (name === "build-theme")
						return {
							workspace: "/attempt",
							stagingAttemptId: "a1",
							sourceDigest: "pinned",
						};
					if (name === "snapshot-theme") return callback();
					throw new Error(`unexpected step ${name}`);
				},
			),
		};
		const run = workflow.run(event as never, step as never);
		await sandboxEntered;
		expect(inFlight).toBe(1);
		closed = true;
		releaseSandbox();
		await expect(run).rejects.toThrow("site closed");
		expect(inFlight).toBe(0);
	});

	it("waits for every started staging upload before releasing a failed snapshot permit", async () => {
		const { workflow, event, put } = workflowFixture("site-original");
		let releaseSecond!: () => void;
		const secondPut = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		let secondStarted!: () => void;
		const secondPutStarted = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		put.mockImplementation(async (key: string, _body: unknown) => {
			if (key.endsWith("/files/entry.mjs"))
				throw new Error("first upload failed");
			if (key.endsWith("/files/other.mjs")) {
				secondStarted();
				await secondPut;
			}
		});
		vi.mocked(getSiteBuilderSandbox).mockReturnValue({
			pathExists: vi.fn(async () => true),
			exec: vi.fn(async () => ({
				output: async () => ({
					exitCode: 0,
					stdout: "entry.mjs\nother.mjs\n",
					stderr: "",
					timedOut: false,
					truncated: false,
				}),
			})),
			readFile: vi.fn(async () => ({ content: "module", size: 6 })),
		} as never);
		let inFlight = 0;
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
			async (_db, _site, operation) => {
				inFlight++;
				try {
					return await operation();
				} finally {
					inFlight--;
				}
			},
		);
		const step = {
			do: vi.fn(
				async (
					name: string,
					_options: unknown,
					callback: () => Promise<unknown>,
				) => {
					if (name === "preflight") return { digest: "pinned", fileCount: 1 };
					if (name === "build-theme")
						return {
							workspace: "/attempt",
							stagingAttemptId: "a1",
							sourceDigest: "pinned",
						};
					if (name === "snapshot-theme") return callback();
					throw new Error(`unexpected step ${name}`);
				},
			),
		};
		const run = workflow.run(event as never, step as never);
		await secondPutStarted;
		await Promise.resolve();
		expect(inFlight).toBe(1);
		releaseSecond();
		await expect(run).rejects.toThrow("first upload failed");
		expect(inFlight).toBe(0);
	});

	it.each(["cancelled", "failed"] as const)(
		"does not stage or publish a %s build with a completion marker",
		async (status) => {
			const { workflow, event } = workflowFixture("site-original");
			vi.mocked(removeDeployAttemptWorkspace).mockClear();
			vi.mocked(runCmsSandboxBuildToCompletion).mockResolvedValueOnce({
				jobId: "native-build",
				status,
				exitCode: status === "cancelled" ? 143 : 1,
				running: false,
				logTail: "[build] Complete!",
				launchLog: "",
				startedAt: 0,
				durationMs: 1,
				successMarkerDetected: true,
				message: `CMS theme build ${status}`,
			});
			vi.mocked(getSiteBuilderSandbox).mockReturnValue({
				readFile: vi.fn(async () => ({
					content: 'i18n: { defaultLocale: "en", fallback: {} }',
				})),
				writeFile: vi.fn(async () => undefined),
				exec: vi.fn(async () => ({
					output: async () => ({
						exitCode: 0,
						stdout: "",
						stderr: "",
						timedOut: false,
						truncated: false,
					}),
				})),
			} as never);
			vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
				async (_db, _site, operation) => operation(),
			);
			const steps: string[] = [];
			const step = {
				do: vi.fn(
					async (
						name: string,
						_options: unknown,
						callback: () => Promise<unknown>,
					) => {
						steps.push(name);
						if (name === "preflight") return { digest: "pinned", fileCount: 1 };
						if (name === "build-theme") return callback();
						throw new Error(`Unexpected downstream step ${name}`);
					},
				),
			};
			await expect(workflow.run(event as never, step as never)).rejects.toThrow(
				"Build failed",
			);
			for (const name of ["snapshot-theme", "publish-bundle"])
				expect(steps).not.toContain(name);
			expect(removeDeployAttemptWorkspace).toHaveBeenCalledWith(
				expect.anything(),
				"/attempt",
			);
		},
	);

	it("retains an orphan permit and records the native job ID when build observation is lost", async () => {
		const { workflow, event, put } = workflowFixture("site-original");
		vi.mocked(removeDeployAttemptWorkspace).mockClear();
		vi.mocked(runCmsSandboxBuildToCompletion).mockRejectedValueOnce(
			new CmsUnknownProcessOutcomeError(
				"CMS build completion observation expired; process outcome remains running",
			),
		);
		vi.mocked(getSiteBuilderSandbox).mockReturnValue({
			readFile: vi.fn(async () => ({
				success: true,
				content: 'i18n: { defaultLocale: "en", fallback: {} }',
			})),
			writeFile: vi.fn(async () => undefined),
			exec: vi.fn(async () => ({
				output: async () => ({
					exitCode: 0,
					stdout: "",
					stderr: "",
					timedOut: false,
					truncated: false,
				}),
			})),
		} as never);
		let orphanPermits = 0;
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
			async (_db, site, operation, options) => {
				expect(site).toEqual({
					siteId: "site-original",
					slug: "acme",
					restoreEpoch: 0,
				});
				orphanPermits++;
				let retain = false;
				try {
					return await operation();
				} catch (error) {
					retain =
						options?.retainPermitOnUnknownProcessOutcome === true &&
						error instanceof CmsUnknownProcessOutcomeError;
					throw error;
				} finally {
					if (!retain) orphanPermits--;
				}
			},
		);
		const step = {
			do: vi.fn(
				async (
					name: string,
					_options: unknown,
					callback: () => Promise<unknown>,
				) => {
					if (name === "preflight") return { digest: "pinned", fileCount: 1 };
					if (name === "build-theme") return callback();
					throw new Error(`unexpected step ${name}`);
				},
			),
		};
		await expect(
			workflow.run(event as never, step as never),
		).rejects.toBeInstanceOf(NonRetryableError);
		expect(orphanPermits).toBe(1);
		expect(removeDeployAttemptWorkspace).not.toHaveBeenCalled();
		const allocated = put.mock.calls
			.map(([, body]) => JSON.parse(body as string) as { message?: string })
			.find((receipt) =>
				receipt.message?.startsWith("Astro build job allocated: "),
			);
		expect(allocated?.message).toMatch(
			/^Astro build job allocated: cms-deploy-acme-test-/,
		);
	});

	it("budgets preparation before launch and leaves the full native lifetime inside the Workflow step", async () => {
		const { workflow, event } = workflowFixture("site-original");
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
			async (_db, _site, operation) => operation(),
		);
		const step = {
			do: vi.fn(async (name: string, _config: unknown) => {
				if (name === "preflight") return { digest: "pinned", fileCount: 1 };
				if (name === "build-theme") {
					return {
						workspace: "/attempt",
						stagingAttemptId: "a1",
						sourceDigest: "pinned",
					};
				}
				throw new Error("stop after build configuration");
			}),
		};
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"stop after build configuration",
		);
		const buildCall = step.do.mock.calls.find(
			([name]) => name === "build-theme",
		);
		const config = buildCall?.[1] as { timeout: string };
		const timeoutMinutes = Number.parseInt(config.timeout, 10);
		expect(timeoutMinutes * 60_000).toBeGreaterThan(
			CMS_BUILD_PREPARATION_BUDGET_MS +
				CMS_BUILD_TIMEOUT_MS +
				CMS_BUILD_OBSERVATION_GRACE_MS +
				3 * CMS_BUILD_CONTROL_RPC_TIMEOUT_MS,
		);
	});

	it("rejects slow preparation before launching the native Astro process", async () => {
		const { workflow, event } = workflowFixture("site-original");
		vi.mocked(runCmsSandboxBuildToCompletion).mockClear();
		vi.mocked(getSiteBuilderSandbox).mockReturnValue({
			readFile: vi.fn(async () => ({
				success: true,
				content: 'i18n: { defaultLocale: "en", fallback: {} }',
			})),
			writeFile: vi.fn(async () => undefined),
			exec: vi.fn(async () => ({
				output: async () => ({
					exitCode: 0,
					stdout: "",
					stderr: "",
					timedOut: false,
					truncated: false,
				}),
			})),
		} as never);
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
			async (_db, _site, operation) => operation(),
		);
		const clock = vi
			.spyOn(Date, "now")
			.mockImplementationOnce(() => 0)
			.mockImplementation(() => CMS_BUILD_PREPARATION_BUDGET_MS + 1);
		const step = {
			do: vi.fn(
				async (
					name: string,
					_config: unknown,
					callback: () => Promise<unknown>,
				) => {
					if (name === "preflight") return { digest: "pinned", fileCount: 1 };
					if (name === "build-theme") return callback();
					throw new Error(`unexpected step ${name}`);
				},
			),
		};
		try {
			await expect(workflow.run(event as never, step as never)).rejects.toThrow(
				"CMS build preparation exceeded its budget; native build was not launched",
			);
			expect(runCmsSandboxBuildToCompletion).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});

	it("budgets a full pinned rebuild when snapshot output has disappeared", async () => {
		const { workflow, event } = workflowFixture("site-original");
		vi.mocked(runCmsSandboxBuildToCompletion).mockClear();
		vi.mocked(runCmsSandboxBuildToCompletion).mockResolvedValueOnce({
			jobId: "native-build",
			status: "complete",
			exitCode: 0,
			running: false,
			logTail: "",
			launchLog: "",
			startedAt: 0,
			durationMs: 1,
			successMarkerDetected: false,
			message: "CMS theme build complete",
		});
		const sandbox = {
			pathExists: vi.fn(async () => false),
			readFile: vi.fn(async () => ({
				success: true,
				content: 'i18n: { defaultLocale: "en", fallback: {} }',
			})),
			writeFile: vi.fn(async () => undefined),
			exec: vi.fn(async (argv: string[]) => ({
				output: async () => ({
					exitCode: 0,
					stdout: argv[2]?.includes("find . -name") ? "entry.mjs\n" : "",
					stderr: "",
					timedOut: false,
					truncated: false,
				}),
			})),
		};
		vi.mocked(getSiteBuilderSandbox).mockReturnValue(sandbox as never);
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
			async (_db, _site, operation) => operation(),
		);
		const step = {
			do: vi.fn(
				async (
					name: string,
					_config: unknown,
					callback: () => Promise<unknown>,
				) => {
					if (name === "preflight") return { digest: "pinned", fileCount: 1 };
					if (name === "build-theme")
						return {
							workspace: "/attempt",
							stagingAttemptId: "a1",
							sourceDigest: "pinned",
						};
					if (name === "snapshot-theme") return callback();
					throw new Error("stop after snapshot");
				},
			),
		};
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"stop after snapshot",
		);
		expect(sandbox.pathExists).toHaveBeenCalledWith(
			"/attempt/dist/server/entry.mjs",
		);
		expect(runCmsSandboxBuildToCompletion).toHaveBeenCalledOnce();
		const buildCall = step.do.mock.calls.find(
			([name]) => name === "build-theme",
		);
		const snapshotCall = step.do.mock.calls.find(
			([name]) => name === "snapshot-theme",
		);
		const buildMinutes = Number.parseInt(
			(buildCall?.[1] as { timeout: string }).timeout,
			10,
		);
		const snapshotMinutes = Number.parseInt(
			(snapshotCall?.[1] as { timeout: string }).timeout,
			10,
		);
		expect(snapshotMinutes * 60_000).toBeGreaterThan(
			buildMinutes * 60_000 + CMS_SNAPSHOT_STAGING_BUDGET_MS,
		);
	});

	it("retains a permit when build workspace removal times out", async () => {
		const { workflow, event } = workflowFixture("site-original");
		vi.mocked(removeDeployAttemptWorkspace).mockClear();
		vi.mocked(removeDeployAttemptWorkspace).mockRejectedValueOnce(
			new CmsUnknownProcessOutcomeError("workspace removal outcome unknown"),
		);
		vi.mocked(getSiteBuilderSandbox).mockReturnValue({} as never);
		let orphanPermits = 0;
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
			async (_db, _site, operation, options) => {
				orphanPermits++;
				let retain = false;
				try {
					return await operation();
				} catch (error) {
					retain =
						options?.retainPermitOnUnknownProcessOutcome === true &&
						error instanceof CmsUnknownProcessOutcomeError;
					throw error;
				} finally {
					if (!retain) orphanPermits--;
				}
			},
		);
		const step = {
			do: vi.fn(
				async (
					name: string,
					_options: unknown,
					callback: () => Promise<unknown>,
				) => {
					if (name === "preflight") return { digest: "pinned", fileCount: 1 };
					if (name === "build-theme")
						return {
							workspace: "/attempt",
							stagingAttemptId: "a1",
							sourceDigest: "pinned",
						};
					if (name === "snapshot-theme")
						return {
							workspace: "/attempt",
							stagingAttemptId: "a1-s1",
							fileCount: 1,
							staticCount: 0,
						};
					if (name === "cleanup-build-workspace") return callback();
					throw new Error(`unexpected step ${name}`);
				},
			),
		};
		await expect(
			workflow.run(event as never, step as never),
		).rejects.toBeInstanceOf(NonRetryableError);
		expect(orphanPermits).toBe(1);
		expect(removeDeployAttemptWorkspace).toHaveBeenCalledOnce();
	});

	it.each([
		"preflight",
		"build-theme",
		"snapshot-theme",
		"cleanup-build-workspace",
		"publish-bundle",
		"health-check",
		"cleanup-staging",
	])("checks the pinned site before the %s callback", async (target) => {
		const { workflow, event } = workflowFixture("site-original");
		let deny = false;
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
			async (_db, site, operation) => {
				expect(site).toEqual({
					siteId: "site-original",
					slug: "acme",
					restoreEpoch: 0,
				});
				if (deny) throw new Error("site closed or replaced");
				return operation();
			},
		);
		const step = {
			do: vi.fn(
				async (
					name: string,
					_options: unknown,
					callback: () => Promise<unknown>,
				) => {
					if (name === target) {
						deny = true;
						return callback();
					}
					if (name === "preflight") return { digest: "pinned", fileCount: 1 };
					if (name === "build-theme")
						return {
							workspace: "/attempt",
							stagingAttemptId: "a1",
							sourceDigest: "pinned",
						};
					if (name === "snapshot-theme")
						return {
							workspace: "/attempt",
							stagingAttemptId: "a1-s1",
							fileCount: 1,
							staticCount: 0,
						};
					if (name === "publish-bundle") return { version: 2 };
					if (name === "health-check") return { ok: true };
					return { cleaned: true };
				},
			),
		};
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"site closed or replaced",
		);
		expect(step.do).toHaveBeenCalledWith(
			target,
			expect.any(Object),
			expect.any(Function),
		);
	});
});

function jsonObject(value: unknown) {
	return { json: async () => value } as unknown as R2ObjectBody;
}

describe("cleanupStagedBundle", () => {
	it("deletes manifests and every staged bundle input after publish settles", async () => {
		const deleteObjects = vi.fn(async () => {});
		const storage = {
			get: vi.fn(async (key: string) => {
				if (key.endsWith("/manifest.json")) {
					return jsonObject({ files: ["entry.mjs", "chunks/cache.mjs"] });
				}
				if (key.endsWith("/static-manifest.json")) {
					return jsonObject({ filenames: ["app.js", "font.woff2"] });
				}
				return null;
			}),
			delete: deleteObjects,
		} as unknown as R2Bucket;

		const deleted = await cleanupStagedBundle(storage, "tedix", "job-1");

		expect(deleted).toBe(6);
		expect(deleteObjects).toHaveBeenCalledWith([
			"themes/tedix/staging/job-1/manifest.json",
			"themes/tedix/staging/job-1/static-manifest.json",
			"themes/tedix/staging/job-1/files/entry.mjs",
			"themes/tedix/staging/job-1/files/chunks/cache.mjs",
			"themes/tedix/staging/job-1/static/app.js",
			"themes/tedix/staging/job-1/static/font.woff2",
		]);
	});

	it("is idempotent when manifests were already removed", async () => {
		const deleteObjects = vi.fn(async () => {});
		const storage = {
			get: vi.fn(async () => null),
			delete: deleteObjects,
		} as unknown as R2Bucket;

		expect(await cleanupStagedBundle(storage, "tedix", "job-1")).toBe(2);
		expect(deleteObjects).toHaveBeenCalledWith([
			"themes/tedix/staging/job-1/manifest.json",
			"themes/tedix/staging/job-1/static-manifest.json",
		]);
	});
});

describe("rewriteTenantLocaleConfig", () => {
	const source = `// The template defaultLocale: "en" is replaced per tenant.
i18n: {
\tdefaultLocale: "en",
\tfallback: { de: "en", fr: "en" },
\trouting: { prefixDefaultLocale: false },
}`;

	it("keeps English as the root locale and removes redirect fallback routes", () => {
		const patched = rewriteTenantLocaleConfig(source, "en");
		expect(patched).toContain('\tdefaultLocale: "en"');
		expect(patched).toContain("fallback: {}");
		expect(patched).toContain('// The template defaultLocale: "en"');
	});

	it("sets a German root without generating redirect fallback routes", () => {
		const patched = rewriteTenantLocaleConfig(source, "de");
		expect(patched).toContain('\tdefaultLocale: "de"');
		expect(patched).toContain("fallback: {}");
		expect(patched).toContain("prefixDefaultLocale: false");
	});
});

describe("deployment health activation fence", () => {
	function healthFixture(firstPublication = false) {
		const fixture = workflowFixture("site-original");
		if (firstPublication)
			fixture.event.payload.expectedActiveVersion = null as any;
		vi.mocked(withExactCmsSiteRestorePermit).mockImplementation(
			async (_db, _site, operation) => operation(),
		);
		vi.mocked(listTenantBundleVersions).mockResolvedValue([
			{ version: firstPublication ? 1 : 2, etag: "published", isActive: true },
		] as any);
		vi.mocked(rollbackCmsTenantBundle).mockResolvedValue({
			rolledBack: true,
		} as any);
		const step = {
			do: vi.fn(
				async (name: string, config: any, callback: () => Promise<unknown>) => {
					if (name === "health-check") {
						expect(config).toEqual(
							firstPublication
								? {
										retries: { limit: 1, delay: "10 seconds" },
										timeout: "120 seconds",
									}
								: {
										retries: { limit: 0, delay: "1 second" },
										timeout: "60 seconds",
									},
						);
						// Model the Workflow engine's declared retry limit; terminal errors bypass it.
						for (let attempt = 0; ; attempt++) {
							try {
								return await callback();
							} catch (error) {
								if (
									error instanceof NonRetryableError ||
									attempt >= config.retries.limit
								)
									throw error;
							}
						}
					}
					if (name === "publish-bundle")
						return { version: firstPublication ? 1 : 2, etag: "published" };
					if (name === "snapshot-theme")
						return { fileCount: 1, staticCount: 0 };
					return {
						workspace: "/attempt",
						stagingAttemptId: "a1",
						sourceDigest: "pinned",
					};
				},
			),
		};
		return { ...fixture, step };
	}
	it("accepts a first initialization completing after 64 seconds", async () => {
		const { workflow, event, step } = healthFixture(true);
		vi.useFakeTimers();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation((ms) => {
				const c = new AbortController();
				setTimeout(() => c.abort(), ms);
				return c.signal;
			});
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(
				async () =>
					new Promise<Response>((resolve) =>
						setTimeout(
							() => resolve(new Response(null, { status: 200 })),
							64000,
						),
					),
			);
		try {
			const result = expect(
				workflow.run(event as never, step as never),
			).resolves.toMatchObject({ version: 1 });
			await vi.advanceTimersByTimeAsync(64000);
			await result;
			expect(timeout).toHaveBeenCalledWith(90000);
			expect(fetcher).toHaveBeenCalledTimes(1);
		} finally {
			timeout.mockRestore();
			fetcher.mockRestore();
			vi.useRealTimers();
		}
	});
	it.each([503, 504])(
		"retries first-publication HTTP %s once",
		async (status) => {
			const { workflow, event, step } = healthFixture(true);
			const fetcher = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(new Response(null, { status }))
				.mockResolvedValueOnce(new Response(null, { status: 200 }));
			try {
				await expect(
					workflow.run(event as never, step as never),
				).resolves.toMatchObject({ version: 1 });
				expect(fetcher).toHaveBeenCalledTimes(2);
			} finally {
				fetcher.mockRestore();
			}
		},
	);
	it.each([404, 500, 503, 504])(
		"terminates persistent first-publication HTTP %s",
		async (status) => {
			const { workflow, event, step } = healthFixture(true);
			vi.mocked(rollbackCmsTenantBundle).mockClear();
			const fetcher = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(null, { status }));
			try {
				await expect(
					workflow.run(event as never, step as never),
				).rejects.toThrow(`HTTP ${status}`);
				expect(fetcher).toHaveBeenCalledTimes(
					status === 503 || status === 504 ? 2 : 1,
				);
				expect(rollbackCmsTenantBundle).not.toHaveBeenCalled();
			} finally {
				fetcher.mockRestore();
			}
		},
	);

	it("exhausts first-init abort retries at two bounded 90-second probes", async () => {
		const { workflow, event, step } = healthFixture(true);
		vi.useFakeTimers();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation((ms) => {
				const c = new AbortController();
				setTimeout(() => c.abort(), ms);
				return c.signal;
			});
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(
				async (_url, init) =>
					new Promise<Response>((_resolve, reject) =>
						init?.signal?.addEventListener(
							"abort",
							() => reject(new DOMException("aborted", "AbortError")),
							{ once: true },
						),
					),
			);
		try {
			const result = expect(
				workflow.run(event as never, step as never),
			).rejects.toThrow("HTTP 504");
			await vi.advanceTimersByTimeAsync(180000);
			await result;
			expect(timeout).toHaveBeenCalledTimes(2);
			expect(fetcher).toHaveBeenCalledTimes(2);
		} finally {
			timeout.mockRestore();
			fetcher.mockRestore();
			vi.useRealTimers();
		}
	});
	it("does not certify a changed activation after first-init retry", async () => {
		const { workflow, event, step } = healthFixture(true);
		vi.mocked(listTenantBundleVersions).mockResolvedValue([
			{ version: 2, etag: "other", isActive: true },
		] as any);
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		try {
			await expect(workflow.run(event as never, step as never)).rejects.toThrow(
				"rollback skipped",
			);
			expect(fetcher).toHaveBeenCalledTimes(2);
		} finally {
			fetcher.mockRestore();
		}
	});

	it("uses a bounded abort signal and verifies the exact published activation", async () => {
		const { workflow, event, step } = healthFixture();
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 200 }));
		try {
			await expect(
				workflow.run(event as never, step as never),
			).resolves.toMatchObject({ version: 2, etag: "published" });
			expect(timeout).toHaveBeenCalledWith(50_000);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
		} finally {
			timeout.mockRestore();
			fetcher.mockRestore();
		}
	});
	it("accepts a cold response at 45 seconds within the single probe budget", async () => {
		const { workflow, event, step, put } = healthFixture();
		vi.useFakeTimers();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation((ms) => {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), ms);
				return controller.signal;
			});
		vi.mocked(rollbackCmsTenantBundle).mockClear();
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Promise<Response>((resolve) => {
					setTimeout(
						() => resolve(new Response(null, { status: 200 })),
						45_000,
					);
				}),
		);
		try {
			const run = workflow.run(event as never, step as never);
			const result = expect(run).resolves.toMatchObject({
				version: 2,
				etag: "published",
			});
			await vi.advanceTimersByTimeAsync(44_999);
			expect(
				put.mock.calls
					.map((call) => JSON.parse(String(call[1])))
					.some((entry) => entry.phase === "complete"),
			).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await result;
			expect(timeout).toHaveBeenCalledWith(50_000);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
			expect(rollbackCmsTenantBundle).not.toHaveBeenCalled();
		} finally {
			timeout.mockRestore();
			fetcher.mockRestore();
			vi.useRealTimers();
		}
	});
	it.each(["abort rejection", "late success"])(
		"expires the probe at 50 seconds and rolls back once after %s",
		async (mode) => {
			const { workflow, event, step, put } = healthFixture();
			vi.useFakeTimers();
			const timeout = vi
				.spyOn(AbortSignal, "timeout")
				.mockImplementation((ms) => {
					const controller = new AbortController();
					setTimeout(() => controller.abort(), ms);
					return controller.signal;
				});
			vi.mocked(rollbackCmsTenantBundle).mockClear();
			const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
				async (_url, init) =>
					new Promise<Response>((resolve, reject) => {
						if (mode === "abort rejection") {
							init?.signal?.addEventListener(
								"abort",
								() => reject(new DOMException("aborted", "AbortError")),
								{ once: true },
							);
						} else {
							setTimeout(
								() => resolve(new Response(null, { status: 200 })),
								50_001,
							);
						}
					}),
			);
			try {
				const run = workflow.run(event as never, step as never);
				const result = expect(run).rejects.toThrow("HTTP 504");
				await vi.advanceTimersByTimeAsync(49_999);
				expect(rollbackCmsTenantBundle).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(2);
				await result;
				expect(timeout).toHaveBeenCalledWith(50_000);
				expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
				expect(fetcher).toHaveBeenCalledTimes(1);
				expect(rollbackCmsTenantBundle).toHaveBeenCalledTimes(1);
				expect(
					vi.mocked(rollbackCmsTenantBundle).mock.calls.at(-1)?.[2],
				).toMatchObject({ failedVersion: 2, previousVersion: 1 });
				expect(
					put.mock.calls
						.map((call) => JSON.parse(String(call[1])))
						.some((entry) => entry.phase === "complete"),
				).toBe(false);
			} finally {
				timeout.mockRestore();
				fetcher.mockRestore();
				vi.useRealTimers();
			}
		},
	);
	it.each([
		{ version: 1, etag: "old" },
		{ version: 2, etag: "changed" },
		{ version: 3, etag: "newer" },
	])("does not certify changed activation %j", async (active) => {
		const { workflow, event, step, put } = healthFixture();
		vi.mocked(listTenantBundleVersions).mockResolvedValue([
			{ ...active, isActive: true },
		] as any);
		vi.mocked(rollbackCmsTenantBundle).mockClear();
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 200 }));
		try {
			await expect(workflow.run(event as never, step as never)).rejects.toThrow(
				"rollback skipped",
			);
			expect(rollbackCmsTenantBundle).not.toHaveBeenCalled();
			expect(
				put.mock.calls
					.map((call) => JSON.parse(String(call[1])))
					.some((entry) => entry.phase === "complete"),
			).toBe(false);
		} finally {
			fetcher.mockRestore();
		}
	});
	it.each(["abort rejection", "late success"])(
		"rolls back once and never completes after %s",
		async (mode) => {
			const { workflow, event, step, put } = healthFixture();
			const controller = new AbortController();
			const timeout = vi
				.spyOn(AbortSignal, "timeout")
				.mockReturnValue(controller.signal);
			vi.mocked(rollbackCmsTenantBundle).mockClear();
			const fetcher = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () => {
					controller.abort();
					if (mode === "abort rejection")
						throw new DOMException("aborted", "AbortError");
					return new Response(null, { status: 200 });
				});
			try {
				await expect(
					workflow.run(event as never, step as never),
				).rejects.toThrow("HTTP 504");
				expect(fetcher).toHaveBeenCalledTimes(1);
				expect(rollbackCmsTenantBundle).toHaveBeenCalledTimes(1);
				expect(
					vi.mocked(rollbackCmsTenantBundle).mock.calls.at(-1)?.[2],
				).toMatchObject({
					failedVersion: 2,
					previousVersion: 1,
				});
				expect(
					put.mock.calls
						.map((call) => JSON.parse(String(call[1])))
						.some((entry) => entry.phase === "complete"),
				).toBe(false);
			} finally {
				timeout.mockRestore();
				fetcher.mockRestore();
			}
		},
	);
});
