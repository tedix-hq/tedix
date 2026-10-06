import { normalizeCmsTemplateSlug } from "../template-policy";
/**
 * DeployWorkflow — durable, retryable theme deploy via Cloudflare Workflows.
 *
 * Replaces the synchronous deploy() flow that exceeded the 60s upstream MCP
 * timeout. Each step is small, idempotent, and individually retryable.
 *
 * Flow:
 *   preflight → build-theme → snapshot-theme → cleanup-build-workspace →
 *   publish-bundle → health-check → cleanup-staging
 *
 * The bundle (~500KB-1MB) is staged in R2 between steps rather than serialized
 * through workflow state, since step-return state has size limits and the
 * bundle does not need to live in the engine's storage.
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
	type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import { listTenantBundleVersions } from "@tedix/provisioning/cms";
import { getSiteBuilderSandbox } from "../sandbox";

import type { AppBindings } from "../types";
import { safeDeployDetails, safeDeployMessage } from "./deploy-status-safety";
import {
	CmsUnknownProcessOutcomeError,
	withExactCmsSiteRestorePermit,
} from "./cms-restore-permit";
import { publishStagedCmsBundle } from "./deploy-publish";
import { rewriteTenantLocaleConfig } from "./deploy-locale-config";
import {
	CMS_BUILD_OBSERVATION_GRACE_MS,
	CMS_BUILD_CONTROL_RPC_TIMEOUT_MS,
	CMS_BUILD_TIMEOUT_MS,
	resolveCmsPrivacyBannerEnabled,
	runCmsSandboxBuildToCompletion,
} from "./build-runner";
import {
	restoreNodeModulesBackup,
	saveNodeModulesBackup,
} from "./node-modules-backup";
import {
	clearDeployAttemptBuildOutput,
	createDeployAttemptWorkspace,
	removeDeployAttemptWorkspace,
} from "./deploy-attempt-workspace";
import {
	cleanupStagedBundle,
	stagingFileKey,
	stagingManifestKey,
	stagingPrefix,
	stagingStaticKey,
} from "./deploy-staging";
import {
	getCmsDefaultLocale,
	getCmsPublicBuildRoute,
	getCmsTemplateSelection,
	rollbackCmsTenantBundle,
} from "./storage";
import type { CmsDeployWorkflowParams } from "./deploy-admission";
import { resyncTemplate } from "./template-sync";
import {
	digestEditableThemeSource,
	materializeEditableThemeSource,
	requirePinnedEditableThemeSource,
} from "./source-provenance";
import { themeArtifactRemote, themeArtifactRepoName } from "./hot-theme";
import { sleep } from "@tedix/worker-kit/sleep";
import { errorMessage } from "@tedix/worker-kit/error-message";

const WORKSPACE_TEMPLATES = "/workspace-templates";
const DEFAULT_TEMPLATE_SLUG = "tedix";
const MAIN_MODULE = "entry.mjs";
const SNAPSHOT_IO_BATCH = 2;
const SNAPSHOT_IO_RETRIES = 4;
export const CMS_BUILD_PREPARATION_BUDGET_MS = 5 * 60 * 1000;
const BUILD_WORKFLOW_SAFETY_MARGIN_MS = 90_000;
const BUILD_WORKFLOW_TIMEOUT_MINUTES = Math.ceil(
	(CMS_BUILD_PREPARATION_BUDGET_MS +
		CMS_BUILD_TIMEOUT_MS +
		CMS_BUILD_OBSERVATION_GRACE_MS +
		3 * CMS_BUILD_CONTROL_RPC_TIMEOUT_MS +
		BUILD_WORKFLOW_SAFETY_MARGIN_MS) /
		60_000,
);
export const CMS_SNAPSHOT_STAGING_BUDGET_MS = 8 * 60 * 1000;
const SNAPSHOT_WORKFLOW_SAFETY_MARGIN_MS = 60_000;
const SNAPSHOT_WORKFLOW_TIMEOUT_MINUTES = Math.ceil(
	(BUILD_WORKFLOW_TIMEOUT_MINUTES * 60_000 +
		CMS_SNAPSHOT_STAGING_BUDGET_MS +
		SNAPSHOT_WORKFLOW_SAFETY_MARGIN_MS) /
		60_000,
);

/**
 * Resolve the Site Builder starter slug for a tenant.
 *
 * Source of truth: the explicit `apps.metadata.blogConfig.templateSlug` (the
 * field provisioning writes), with `apps.metadata.templateSlug` as a secondary
 * explicit signal, then the default ("tedix").
 *
 * Unknown IDs fail before the build workspace is changed. Existing absent
 * metadata still selects the historical Tedix starter.
 */
async function resolveTemplateSlug(
	db: D1Database,
	orgSlug: string,
): Promise<string> {
	const row = await getCmsTemplateSelection(db, orgSlug);

	const raw =
		row?.blogTemplateSlug ?? row?.metaTemplateSlug ?? DEFAULT_TEMPLATE_SLUG;
	const requested =
		typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_TEMPLATE_SLUG;

	return normalizeCmsTemplateSlug(requested);
}

export type DeployPhaseState = "queued" | "running" | "complete" | "failed";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

async function withSnapshotIoRetry<T>(
	label: string,
	fn: () => Promise<T>,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= SNAPSHOT_IO_RETRIES; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			if (attempt === SNAPSHOT_IO_RETRIES) break;
			await sleep(250 * attempt ** 2);
		}
	}
	throw new Error(
		`${label} failed after ${SNAPSHOT_IO_RETRIES} attempts: ${errorMessage(lastError)}`,
	);
}

async function readSandboxTextFile(
	sandbox: ReturnType<typeof getSiteBuilderSandbox>,
	path: string,
): Promise<string> {
	return withSnapshotIoRetry(`read ${path}`, async () => {
		const result = await sandbox.readFile(path);
		return result.content;
	});
}

async function stageSandboxBinaryFile(
	sandbox: ReturnType<typeof getSiteBuilderSandbox>,
	bucket: R2Bucket,
	path: string,
	key: string,
): Promise<number> {
	return withSnapshotIoRetry(`stage binary ${path}`, async () => {
		const file = await sandbox.readFile(path, { encoding: "none" });
		const bytes =
			file.content instanceof Uint8Array
				? file.content
				: new TextEncoder().encode(file.content);
		await bucket.put(key, bytes);
		return bytes.byteLength;
	});
}

export interface DeployPhaseEvent {
	phase: string;
	status: DeployPhaseState;
	message?: string;
	timestamp: string;
	details?: Record<string, unknown>;
}

export interface DeployStatusSnapshot {
	jobId: string;
	orgSlug: string;
	phase: string;
	status: DeployPhaseState;
	message?: string;
	updatedAt: string;
	history: DeployPhaseEvent[];
	details?: Record<string, unknown>;
}

export function deployStatusKey(jobId: string): string {
	return `themes/deploy-status/${jobId}.json`;
}

async function recordDeployPhase(
	storage: R2Bucket,
	event: {
		jobId: string;
		orgSlug: string;
		phase: string;
		status: DeployPhaseState;
		message?: string;
		details?: Record<string, unknown>;
	},
): Promise<void> {
	const timestamp = new Date().toISOString();
	const priorObj = await storage.get(deployStatusKey(event.jobId));
	let history: DeployPhaseEvent[] = [];
	if (priorObj) {
		try {
			const prior = (await priorObj.json()) as Partial<DeployStatusSnapshot>;
			if (Array.isArray(prior.history)) {
				history = prior.history.map((previous) => ({
					...previous,
					message: safeDeployMessage(previous.status, previous.message),
					details: safeDeployDetails(previous.details),
				}));
			}
		} catch {
			history = [];
		}
	}

	const entry: DeployPhaseEvent = {
		phase: event.phase,
		status: event.status,
		message: safeDeployMessage(event.status, event.message),
		timestamp,
		details: safeDeployDetails(event.details),
	};
	history.push(entry);

	const snapshot: DeployStatusSnapshot = {
		jobId: event.jobId,
		orgSlug: event.orgSlug,
		phase: event.phase,
		status: event.status,
		message: entry.message,
		updatedAt: timestamp,
		history: history.slice(-80),
		details: entry.details,
	};
	await storage.put(deployStatusKey(event.jobId), JSON.stringify(snapshot));
}

/**
 * patchLocaleConfig — rewrites astro.config.mjs in the sandbox to use the
 * org's actual default locale before every build.
 *
 * The template snapshot ships with `defaultLocale: "en"`. Each build uses
 * the organization's default locale and clears Astro's redirect fallback.
 * Explicit locale routes serve translated content; generated fallback routes
 * redirect to the default locale and mask those routes.
 */
async function patchLocaleConfig(
	sandbox: ReturnType<typeof getSiteBuilderSandbox>,
	db: D1Database,
	orgSlug: string,
	workspace: string,
): Promise<{ locale: string; patched: boolean }> {
	const locale = (await getCmsDefaultLocale(db, orgSlug)) ?? "en";

	const astroConfigPath = `${workspace}/astro.config.mjs`;
	const readResult = await sandbox.readFile(astroConfigPath);
	const content = readResult.content;

	const patched = rewriteTenantLocaleConfig(content, locale);
	if (patched === content) return { locale, patched: false };
	await sandbox.writeFile(astroConfigPath, patched);
	return { locale, patched: true };
}

export type DeployWorkflowParams = CmsDeployWorkflowParams;

function cmsUrlFor(orgSlug: string, env: string): string {
	const url = buildSurfaceUrl("cms", orgSlug, {
		platformDomain: platformDomainForEnvironment(env || "production"),
	});
	if (!url) throw new Error("CMS organization slug is required");
	return url;
}

export class DeployWorkflow extends WorkflowEntrypoint<
	AppBindings,
	DeployWorkflowParams
> {
	async run(
		event: WorkflowEvent<DeployWorkflowParams>,
		step: WorkflowStep,
	): Promise<{ version: number; etag: string; url: string }> {
		const {
			siteId,
			restoreEpoch,
			orgSlug,
			summary,
			sourceCommit,
			nextBundleVersion,
			expectedActiveVersion,
		} = event.payload;
		const jobId = event.instanceId;
		const env = this.env;
		// Workflow.restart() retains its original payload. Legacy slug-only jobs
		// must not bind to a different site that later reuses the slug.
		if (!siteId || !Number.isSafeInteger(restoreEpoch) || restoreEpoch < 0) {
			throw new NonRetryableError(
				"CMS deploy workflow has no pinned site ID and restore epoch",
			);
		}
		const withSitePermit = <T>(
			operation: () => Promise<T>,
			options?: { retainPermitOnUnknownProcessOutcome: true },
		) =>
			withExactCmsSiteRestorePermit(
				env.DB,
				{ siteId, slug: orgSlug, restoreEpoch },
				operation,
				options,
			);
		const guardedStep = <T extends Rpc.Serializable<T>>(
			name: string,
			config: WorkflowStepConfig,
			operation: () => Promise<T>,
			permitOptions?: { retainPermitOnUnknownProcessOutcome: true },
		) =>
			step.do(name, config, async () => {
				try {
					return await withSitePermit(operation, permitOptions);
				} catch (error) {
					// The permit helper must see the original type so it can retain
					// the fence. The Workflow engine must then stop retrying this
					// step, because the native process may still be running.
					if (error instanceof CmsUnknownProcessOutcomeError) {
						throw new NonRetryableError(error.message);
					}
					throw error;
				}
			});
		const record = (
			phase: string,
			status: DeployPhaseState,
			message?: string,
			details?: Record<string, unknown>,
		) =>
			withSitePermit(() =>
				recordDeployPhase(env.SITE_BUILDER_STORAGE, {
					jobId,
					orgSlug,
					phase,
					status,
					message,
					details,
				}),
			);

		await record("queued", "queued", "Deploy workflow queued", {
			summary,
			sourceCommit,
		});

		// A named source commit is the deploy's source of truth: every attempt
		// that builds re-materializes it, so a container reset between or
		// during steps restores the tenant theme instead of the stock starter.
		const sourceRevision = sourceCommit
			? { kind: "artifacts_commit" as const, value: sourceCommit }
			: null;
		const restoreSourceCommit = async (
			sandbox: ReturnType<typeof getSiteBuilderSandbox>,
			templateSlug: string,
			workspace: string,
		) => {
			if (!sourceCommit) return;
			if (!env.ARTIFACTS) {
				throw new NonRetryableError(
					"sourceCommit requires the CMS Artifacts binding",
				);
			}
			const repo = await env.ARTIFACTS.get(themeArtifactRepoName(orgSlug));
			const token = await repo.createToken("read", 600);
			await materializeEditableThemeSource(sandbox, {
				remote: themeArtifactRemote(env.CF_ACCOUNT_ID, orgSlug),
				token: await token.plaintext,
				commit: sourceCommit,
				templateSlug,
				workspace,
			});
		};

		try {
			// Resolve the tenant's Site Builder starter slug. Absent/"tedix" => the
			// historical default path (no template overlay; locked resync uses the
			// tedix snapshot). Unknown slugs fail before a workspace is changed.
			const templateSlug = await resolveTemplateSlug(env.DB, orgSlug);
			const createSourceWorkspace = async (
				sandbox: ReturnType<typeof getSiteBuilderSandbox>,
			) => {
				const sourceRoot = sourceCommit
					? (`/workspace-templates/${normalizeCmsTemplateSlug(templateSlug)}` as const)
					: ("/workspace" as const);
				const attempt = await createDeployAttemptWorkspace(
					sandbox,
					jobId,
					sourceRoot,
				);
				try {
					// Sandbox-only themes retain their editable files from /workspace.
					// Add any absent marketing starter assets to the private copy.
					if (!sourceCommit && templateSlug !== DEFAULT_TEMPLATE_SLUG) {
						const overlay = await (
							await sandbox.exec([
								"bash",
								"-lc",
								`cp -an ${shellQuote(`${WORKSPACE_TEMPLATES}/${templateSlug}/.`)} ${shellQuote(`${attempt.path}/`)}`,
							])
						).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
						if (overlay.timedOut) {
							throw new CmsUnknownProcessOutcomeError(
								"CMS template overlay outcome is unknown",
							);
						}
						if (
							overlay.exitCode !== 0 ||
							overlay.signal !== undefined ||
							overlay.truncated
						) {
							throw new Error(
								`Template overlay failed for "${templateSlug}": ${overlay.stderr || overlay.stdout}`,
							);
						}
					}
					await restoreSourceCommit(sandbox, templateSlug, attempt.path);
					const resync = await resyncTemplate(sandbox, {
						scope: "locked",
						templateSlug,
						workspace: attempt.path,
					});
					return { ...attempt, resync };
				} catch (error) {
					if (!(error instanceof CmsUnknownProcessOutcomeError)) {
						await removeDeployAttemptWorkspace(sandbox, attempt.path).catch(
							() => undefined,
						);
					}
					throw error;
				}
			};

			// ------------------------------------------------------------------
			// Step 0 — preflight (pin editable source in a private workspace)
			// A source-backed deploy copies the immutable starter and materializes
			// the named Artifacts commit there. A sandbox-only deploy copies the
			// current authoring workspace. Both resync locked platform files in the
			// private copy and return one durable editable-source digest.
			// ------------------------------------------------------------------
			await record("preflight", "running", "Preparing workspace", {
				templateSlug,
			});
			const pinnedSource = await guardedStep(
				"preflight",
				{ retries: { limit: 1, delay: "5 seconds" }, timeout: "2 minutes" },
				async () => {
					const sandbox = getSiteBuilderSandbox(env, orgSlug);
					const prepared = await createSourceWorkspace(sandbox);
					try {
						const editableSource = await digestEditableThemeSource(
							sandbox,
							templateSlug,
							prepared.path,
						);
						await record(
							"preflight",
							"complete",
							"Editable theme source identified",
							{
								copied: prepared.resync.copied.length,
								skipped: prepared.resync.skipped.length,
								sourceRevision: sourceRevision ?? {
									kind: "editable_source_digest",
									value: editableSource.digest,
								},
								sourceFileCount: editableSource.fileCount,
							},
						);
						return editableSource;
					} finally {
						await removeDeployAttemptWorkspace(sandbox, prepared.path);
					}
				},
				{ retainPermitOnUnknownProcessOutcome: true },
			);
			// ------------------------------------------------------------------
			// Step 1 — build in a private workspace. Snapshotting hundreds of
			// modules used to share this step with Astro and made retries rebuild
			// the theme. The build step keeps its workspace until the snapshot is
			// durable, so a snapshot retry can reuse completed output.
			// ------------------------------------------------------------------
			await record("build-and-snapshot", "running", "Building Astro bundle");
			const buildAttempt = async () => {
				const preparationStartedAt = Date.now();
				const sandbox = getSiteBuilderSandbox(env, orgSlug);
				const attempt = await createSourceWorkspace(sandbox);
				const attemptWorkspace = attempt.path;
				try {
					await clearDeployAttemptBuildOutput(sandbox, attemptWorkspace);
					const editableSource = await requirePinnedEditableThemeSource(
						sandbox,
						templateSlug,
						pinnedSource,
						(message) => new NonRetryableError(message),
						attemptWorkspace,
					);
					await record(
						"build-and-snapshot",
						"running",
						"Locked files resynced; editable theme source verified",
						{ templateSlug, sourceFileCount: editableSource.fileCount },
					);
					// Patch the org locale in this attempt's config only.
					const localePatch = await patchLocaleConfig(
						sandbox,
						env.DB,
						orgSlug,
						attemptWorkspace,
					);
					await record(
						"build-and-snapshot",
						"running",
						"Locale config prepared",
						localePatch,
					);
					const privacyBannerEnabled = await resolveCmsPrivacyBannerEnabled(
						env.DB,
						orgSlug,
					);
					await record(
						"build-and-snapshot",
						"running",
						"Privacy banner config prepared",
						{ privacyBannerEnabled },
					);
					// Best-effort: restore a prior node_modules backup for this exact
					// template + dependency fingerprint so the install below becomes a
					// fast verification pass instead of a from-scratch resolve+download.
					// A miss (or any error) falls through to today's unmodified install
					// path — this can only speed a build up, never break one.
					const backupRestore = await restoreNodeModulesBackup(
						sandbox,
						env.SITE_BUILDER_STORAGE,
						templateSlug,
						attemptWorkspace,
					);
					await record(
						"build-and-snapshot",
						"running",
						backupRestore.hit
							? "node_modules restored from backup"
							: "no node_modules backup available",
						backupRestore,
					);

					const installExec = await (
						await sandbox.exec([
							"bash",
							"-lc",
							`cd '${attemptWorkspace}' && bun install --no-progress`,
						])
					).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
					if (installExec.timedOut) {
						throw new CmsUnknownProcessOutcomeError(
							"CMS dependency install outcome is unknown",
						);
					}
					if (
						installExec.exitCode !== 0 ||
						installExec.signal !== undefined ||
						installExec.truncated
					) {
						throw new Error(
							`Dependency install failed: ${installExec.stderr || installExec.stdout}`,
						);
					}
					await record(
						"build-and-snapshot",
						"running",
						"Dependencies refreshed",
					);

					// Only populate the cache on a miss — a hit means an equivalent
					// backup already exists for this fingerprint, so re-snapshotting
					// would just burn a createBackup() call for no benefit.
					if (!backupRestore.hit && backupRestore.fingerprint) {
						const saved = await saveNodeModulesBackup(
							sandbox,
							env.SITE_BUILDER_STORAGE,
							templateSlug,
							backupRestore.fingerprint,
							attemptWorkspace,
						);
						await record(
							"build-and-snapshot",
							"running",
							saved
								? "node_modules backed up for future builds"
								: "node_modules backup skipped (best-effort save failed)",
						);
					}

					// Patch emprivacy: its metadata/fragment hooks resolve root-relative
					// policy URLs through ctx.url(). Some non-page native routes (notably
					// /robots.txt during deploy health checks) may not expose that helper.
					// Treat that as "no policy metadata for this route" instead of
					// throwing and taking the whole tenant bundle down.
					const emprivacyPatchExec = await (
						await sandbox.exec([
							"bash",
							"-lc",
							"node -e " +
								JSON.stringify(
									"const fs=require('fs');" +
										"const p=" +
										JSON.stringify(
											`${attemptWorkspace}/node_modules/emprivacy/dist/sandbox-entry.mjs`,
										) +
										";" +
										"let c=fs.readFileSync(p,'utf8');" +
										"if(c.includes('/* tedix ctx.url guard */')){process.stdout.write('[cms] emprivacy ctx.url patch already applied\\n');process.exit(0);}" +
										"const needle='function absolutePolicyHref(stored, ctx) {\\n\\tconst r = resolvePolicyHref(stored, ctx).trim();';" +
										'const replacement=\'function absolutePolicyHref(stored, ctx) {\\n\\t/* tedix ctx.url guard */\\n\\tlet r = "";\\n\\ttry {\\n\\t\\tr = resolvePolicyHref(stored, ctx).trim();\\n\\t} catch {\\n\\t\\tr = typeof stored === "string" ? stored.trim() : "";\\n\\t}\';' +
										"if(!c.includes(needle)){process.stderr.write('emprivacy patch: target not found\\n');process.exit(1);}" +
										"c=c.replace(needle,replacement);" +
										"fs.writeFileSync(p,c,'utf8');" +
										"process.stdout.write('[cms] emprivacy ctx.url patch applied\\n');",
								),
						])
					).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
					if (emprivacyPatchExec.timedOut) {
						throw new CmsUnknownProcessOutcomeError(
							"CMS dependency patch outcome is unknown",
						);
					}
					if (
						emprivacyPatchExec.exitCode !== 0 ||
						emprivacyPatchExec.signal !== undefined ||
						emprivacyPatchExec.truncated
					) {
						throw new Error(
							`emprivacy patch failed: ${emprivacyPatchExec.stderr || emprivacyPatchExec.stdout}`,
						);
					}
					await record(
						"build-and-snapshot",
						"running",
						"emprivacy route-context patch verified",
					);

					const workflowJobId = jobId.replace(/[^a-zA-Z0-9._-]/g, "-");
					const buildJobId =
						`${workflowJobId}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`.slice(
							0,
							128,
						);
					const publicBuildRoute = await getCmsPublicBuildRoute(
						env.DB,
						orgSlug,
					);
					if (!publicBuildRoute)
						throw new Error(
							`CMS site ${orgSlug} has no active public build route`,
						);
					await record(
						"build-and-snapshot",
						"running",
						`Astro build job allocated: ${buildJobId}`,
					);
					// Every preparation operation, including the last status write,
					// must finish before the native process receives its full lifetime.
					// Cloudflare may interrupt an individual Sandbox RPC; this check
					// bounds the elapsed preparation between those calls.
					if (
						Date.now() - preparationStartedAt >=
						CMS_BUILD_PREPARATION_BUDGET_MS
					) {
						throw new Error(
							"CMS build preparation exceeded its budget; native build was not launched",
						);
					}
					const build = await runCmsSandboxBuildToCompletion(sandbox, {
						jobId: buildJobId,
						orgSlug,
						workspace: attemptWorkspace,
						...publicBuildRoute,
						privacyBannerEnabled,
						onProgress: (message) =>
							record(
								"build-and-snapshot",
								"running",
								`${message}: ${buildJobId}`,
							).catch(() => undefined),
					});
					if (build.status === "timeout") {
						throw new Error(
							`Build timed out: ${build.logTail.trim() || build.message}`,
						);
					}
					if (build.status !== "complete") {
						throw new Error(
							`Build failed${
								build.exitCode !== null ? ` (exit ${build.exitCode})` : ""
							}: ${build.logTail.trim() || build.launchLog.trim() || build.message}`,
						);
					}
					if (build.successMarkerDetected) {
						await record("build-and-snapshot", "running", build.message);
					}
					await record(
						"build-and-snapshot",
						"running",
						"Astro build completed",
					);
					return {
						workspace: attemptWorkspace,
						stagingAttemptId: attempt.stagingAttemptId,
						sourceDigest: editableSource.digest,
					};
				} catch (error) {
					if (error instanceof CmsUnknownProcessOutcomeError) throw error;
					await removeDeployAttemptWorkspace(sandbox, attemptWorkspace).catch(
						() => undefined,
					);
					throw error;
				}
			};
			const built = await guardedStep(
				"build-theme",
				{
					retries: { limit: 2, delay: "10 seconds" },
					timeout: `${BUILD_WORKFLOW_TIMEOUT_MINUTES} minutes`,
				},
				buildAttempt,
				{ retainPermitOnUnknownProcessOutcome: true },
			);

			// Step 2 — stage the completed build in R2. Every retry gets a
			// distinct staging prefix: a callback abandoned by Workflows can keep
			// writing without corrupting the winning attempt's manifest.
			const snapshot = await guardedStep(
				"snapshot-theme",
				{
					retries: { limit: 2, delay: "10 seconds" },
					timeout: `${SNAPSHOT_WORKFLOW_TIMEOUT_MINUTES} minutes`,
				},
				async () => {
					const sandbox = getSiteBuilderSandbox(env, orgSlug);
					let currentBuild = built;
					if (
						!(await sandbox.pathExists(
							`${built.workspace}/dist/server/${MAIN_MODULE}`,
						))
					) {
						await record(
							"build-and-snapshot",
							"running",
							"Build output disappeared; rebuilding pinned source",
						);
						currentBuild = await buildAttempt();
					}
					const bundleDir = `${currentBuild.workspace}/dist/server`;
					const staticDir = `${currentBuild.workspace}/dist/client/_astro`;
					const stagingAttemptId = `${currentBuild.stagingAttemptId}-s${crypto.randomUUID()}`;

					// List all .mjs files under dist/server.
					const listExec = await (
						await sandbox.exec([
							"bash",
							"-lc",
							`cd '${bundleDir}' && find . -name '*.mjs' -type f | sed 's|^\\./||' | sort`,
						])
					).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
					if (listExec.timedOut) {
						throw new CmsUnknownProcessOutcomeError(
							"CMS bundle listing outcome is unknown",
						);
					}
					if (
						listExec.exitCode !== 0 ||
						listExec.signal !== undefined ||
						listExec.truncated
					) {
						throw new Error(
							`File listing failed: ${listExec.stderr || listExec.stdout}`,
						);
					}
					const filePaths = listExec.stdout
						.split("\n")
						.map((p) => p.trim())
						.filter((p) => p.length > 0 && p.endsWith(".mjs"));

					if (!filePaths.includes(MAIN_MODULE)) {
						throw new Error(
							`Bundle entry "${MAIN_MODULE}" missing — did build succeed?`,
						);
					}
					await record(
						"build-and-snapshot",
						"running",
						"Bundle module files discovered",
						{ fileCount: filePaths.length },
					);

					// Read + stage each file with low concurrency. Sandbox RPC file reads
					// can transiently drop the connection after long builds, so every read
					// is retried before the workflow spends another full build attempt.
					let totalSize = 0;
					for (let i = 0; i < filePaths.length; i += SNAPSHOT_IO_BATCH) {
						const outcomes = await Promise.allSettled(
							filePaths
								.slice(i, i + SNAPSHOT_IO_BATCH)
								.map(async (filePath) => {
									const content = await readSandboxTextFile(
										sandbox,
										`${bundleDir}/${filePath}`,
									);
									const bytes = new TextEncoder().encode(content);
									await env.SITE_BUILDER_STORAGE.put(
										stagingFileKey(orgSlug, stagingAttemptId, filePath),
										bytes,
									);
									totalSize += bytes.byteLength;
								}),
						);
						const failed = outcomes.find(
							(outcome): outcome is PromiseRejectedResult =>
								outcome.status === "rejected",
						);
						if (failed) throw failed.reason;
					}

					const manifest = {
						mainModule: MAIN_MODULE,
						files: filePaths,
						sourceRevision: sourceRevision ?? {
							kind: "editable_source_digest" as const,
							value: currentBuild.sourceDigest,
						},
					};
					await env.SITE_BUILDER_STORAGE.put(
						stagingManifestKey(orgSlug, stagingAttemptId),
						JSON.stringify(manifest),
					);

					// List + stage static assets from dist/client/_astro/.
					// Preserve relative paths from _astro/ root (e.g. "fonts/abc.woff2")
					// so readFile gets the correct full path and R2 keys stay meaningful.
					const staticExists = await sandbox.pathExists(staticDir);
					const staticListing = staticExists
						? await sandbox.listFiles(staticDir, { recursive: true })
						: null;
					const staticRelPaths = (staticListing ?? [])
						.filter((file) => file.type === "file")
						.map((file) => file.relativePath)
						.sort();
					// Pipe binary assets to R2 without buffering them in the Worker.

					let staticSize = 0;
					for (let i = 0; i < staticRelPaths.length; i += SNAPSHOT_IO_BATCH) {
						const outcomes = await Promise.allSettled(
							staticRelPaths
								.slice(i, i + SNAPSHOT_IO_BATCH)
								.map(async (relPath) => {
									const filename = relPath.split("/").pop()!;
									staticSize += await stageSandboxBinaryFile(
										sandbox,
										env.SITE_BUILDER_STORAGE,
										`${staticDir}/${relPath}`,
										stagingStaticKey(orgSlug, stagingAttemptId, filename),
									);
								}),
						);
						const failed = outcomes.find(
							(outcome): outcome is PromiseRejectedResult =>
								outcome.status === "rejected",
						);
						if (failed) throw failed.reason;
					}

					// Manifest uses basenames (content-hashed, globally unique per Astro).
					const staticFilenames = staticRelPaths.map((p) =>
						p.split("/").pop()!,
					);
					const staticManifest = { filenames: staticFilenames };
					await env.SITE_BUILDER_STORAGE.put(
						`${stagingPrefix(orgSlug, stagingAttemptId)}/static-manifest.json`,
						JSON.stringify(staticManifest),
					);

					await record(
						"build-and-snapshot",
						"complete",
						"Bundle staged in R2",
						{
							fileCount: filePaths.length,
							totalSize,
							staticCount: staticFilenames.length,
							staticSize,
						},
					);

					return {
						workspace: currentBuild.workspace,
						stagingAttemptId,
						fileCount: filePaths.length,
						totalSize,
						staticCount: staticFilenames.length,
						staticSize,
					};
				},
				{ retainPermitOnUnknownProcessOutcome: true },
			);
			await guardedStep(
				"cleanup-build-workspace",
				{ retries: { limit: 1, delay: "5 seconds" }, timeout: "1 minute" },
				async () => {
					try {
						const sandbox = getSiteBuilderSandbox(env, orgSlug);
						const paths = new Set([built.workspace, snapshot.workspace]);
						const outcomes = await Promise.allSettled(
							[...paths].map((path) =>
								removeDeployAttemptWorkspace(sandbox, path),
							),
						);
						const unknownOutcome = outcomes.find(
							(outcome): outcome is PromiseRejectedResult =>
								outcome.status === "rejected" &&
								outcome.reason instanceof CmsUnknownProcessOutcomeError,
						);
						if (unknownOutcome) throw unknownOutcome.reason;
						const cleaned = outcomes.every(
							(outcome) => outcome.status === "fulfilled",
						);
						if (!cleaned) {
							console.warn(
								`[deploy-workflow] attempt workspace cleanup deferred for ${orgSlug}/${jobId}`,
							);
						}
						return { cleaned };
					} catch (error) {
						if (error instanceof CmsUnknownProcessOutcomeError) throw error;
						console.warn(
							`[deploy-workflow] attempt workspace cleanup deferred for ${orgSlug}/${jobId}:`,
							error,
						);
						return { cleaned: false };
					}
				},
				{ retainPermitOnUnknownProcessOutcome: true },
			);

			// ------------------------------------------------------------------
			// Step 3 — publish bundle to R2 + register tenant_bundles row
			// Reads the staged multi-file bundle out of SITE_BUILDER_STORAGE and hands
			// it to the provisioning package, which PUTs every file under
			// tedix-cms-bundles/{slug}/v{N}/, reserves a tenant_bundles row,
			// and activates it only when the expected predecessor is still active.
			// The version and expected active predecessor are captured at admission.
			// Step replay therefore targets the same generation and the activation
			// CAS cannot displace a newer successful deploy.
			// ------------------------------------------------------------------
			await record("publish-bundle", "running", "Publishing staged bundle");
			const published = await guardedStep(
				"publish-bundle",
				{
					retries: { limit: 2, delay: "10 seconds" },
					timeout: "10 minutes",
				},
				async () =>
					publishStagedCmsBundle({
						env,
						site: { siteId, slug: orgSlug, restoreEpoch },
						orgSlug,
						stagingAttemptId: snapshot.stagingAttemptId,
						summary,
						jobId,
						nextBundleVersion,
						expectedActiveVersion,
						record,
					}),
			);

			const url = cmsUrlFor(orgSlug, env.ENVIRONMENT || "production");

			// ------------------------------------------------------------------
			// Step 4 — health check + auto-rollback
			// Probes native Emdash /robots.txt on the live bundle to confirm the
			// route, settings DB access, and public URL plumbing render correctly.
			// An unhealthy existing-site upgrade is rolled back immediately:
			// flip is_active back to the previous version so the live site recovers
			// without human intervention.
			// First publication also initializes native schemas over tenant DB RPC.
			// Allow its measured cold-start tail without changing upgrade policy.
			// ------------------------------------------------------------------
			const firstPublication = expectedActiveVersion === null;
			await record("health-check", "running", "Checking live bundle", { url });
			const health = await guardedStep(
				"health-check",
				firstPublication
					? {
							retries: { limit: 1, delay: "10 seconds" },
							timeout: "120 seconds",
						}
					: { retries: { limit: 0, delay: "1 second" }, timeout: "60 seconds" },
				async () => {
					const probeUrl = `${url}/robots.txt`;
					// Cold Worker Loader activation may exceed 30 seconds. Leave the
					// remaining step budget for exact activation checks and CAS rollback.
					const signal = AbortSignal.timeout(
						firstPublication ? 90_000 : 50_000,
					);
					let res: Response;
					try {
						res = await fetch(probeUrl, { redirect: "follow", signal });
					} catch (error) {
						if (!signal.aborted) {
							if (firstPublication) throw new NonRetryableError(String(error));
							throw error;
						}
						res = new Response(null, { status: 504 });
					}
					// Even a late successful response cannot certify another activation.
					if (signal.aborted) res = new Response(null, { status: 504 });
					if (res.status !== 200) {
						// Native first-start migration contention may return 503; the
						// bounded probe deadline becomes 504. Throw only these transient
						// outcomes so Workflow retries this read-only step once. Other
						// HTTP failures remain terminal, including 500 and 404.
						if (
							firstPublication &&
							(res.status === 503 || res.status === 504)
						) {
							await record(
								"health-check",
								"running",
								"Native initialization probe unavailable",
								{ status: res.status, probeUrl },
							);
							throw new Error(
								`Initial health probe unavailable (HTTP ${res.status}). Probe: ${probeUrl}`,
							);
						}
						// Rollback: deactivate new version and reactivate previous version.
						if (published.version > 1) {
							const prevVersion = expectedActiveVersion;
							if (prevVersion === null) {
								await record(
									"health-check",
									"failed",
									"Health check failed; no prior bundle exists for rollback",
									{ status: res.status, probeUrl },
								);
								return { ok: false, status: res.status, probeUrl };
							}
							const rollback = await rollbackCmsTenantBundle(
								env.DB,
								env.BUNDLES_BUCKET,
								{
									site: { siteId, slug: orgSlug, restoreEpoch },
									failedVersion: published.version,
									previousVersion: prevVersion,
								},
							);
							if (!rollback.rolledBack) {
								await record(
									"health-check",
									"failed",
									rollback.error ??
										"Health check failed; rollback skipped because bundle activation changed",
									{
										status: res.status,
										rollbackConflict: !rollback.error,
										rollbackError: rollback.error,
										probeUrl,
									},
								);
								return {
									ok: false,
									status: res.status,
									probeUrl,
									rollbackConflict: !rollback.error,
									rollbackError: rollback.error,
								};
							}
							await record(
								"health-check",
								"failed",
								"Health check failed; rolled back",
								{
									status: res.status,
									rolledBackTo: prevVersion,
									probeUrl,
								},
							);
							return {
								ok: false,
								status: res.status,
								probeUrl,
								rolledBackTo: prevVersion,
							};
						}
						await record(
							"health-check",
							"failed",
							"Health check failed; no prior version",
							{
								status: res.status,
								probeUrl,
							},
						);
						return { ok: false, status: res.status, probeUrl };
					}
					const versions = await listTenantBundleVersions(
						{ platformDb: env.DB, bundlesBucket: env.BUNDLES_BUCKET },
						orgSlug,
					);
					const active = versions.filter((version) => version.isActive);
					if (
						active.length !== 1 ||
						active[0]?.version !== published.version ||
						active[0]?.etag !== published.etag
					) {
						await record(
							"health-check",
							"failed",
							"Bundle activation changed during health check",
							{ status: 409 },
						);
						return { ok: false, status: 409, probeUrl, rollbackConflict: true };
					}
					await record("health-check", "complete", "Live bundle responded", {
						status: res.status,
						probeUrl,
					});
					return { ok: true, status: res.status, probeUrl };
				},
			);
			if (!health.ok) {
				throw new Error(
					health.rollbackConflict
						? `Health check failed (HTTP ${health.status}) — rollback skipped because bundle activation changed. Probe: ${health.probeUrl}`
						: health.rolledBackTo
							? `Health check failed (HTTP ${health.status}) — rolled back to v${health.rolledBackTo}. Probe: ${health.probeUrl}`
							: `Health check failed (HTTP ${health.status}) — no prior version to rollback to. Probe: ${health.probeUrl}`,
				);
			}

			// Cleanup is deliberately separate from publish-bundle. A retried publish
			// must always see the same immutable staged inputs, even when a prior
			// attempt completed its R2/D1 writes but failed before its result was
			// durably committed by the Workflow engine. Remove only the winning
			// attempt's prefix. An abandoned attempt may still be writing its own
			// prefix after an internal Workflow error; those bounded retry leftovers
			// remain under themes/<org>/staging/<jobId>-a<uuid> for later age-based
			// recovery cleanup after the whole Workflow is terminal.
			await guardedStep(
				"cleanup-staging",
				{ retries: { limit: 1, delay: "5 seconds" }, timeout: "1 minute" },
				async () => {
					try {
						return {
							deleted: await cleanupStagedBundle(
								env.SITE_BUILDER_STORAGE,
								orgSlug,
								snapshot.stagingAttemptId,
							),
						};
					} catch (error) {
						console.warn(
							`[deploy-workflow] staging cleanup deferred for ${orgSlug}/${jobId}:`,
							error,
						);
						return { deleted: 0 };
					}
				},
			);

			await record("complete", "complete", "Deploy completed", {
				version: published.version,
				url,
				fileCount: snapshot.fileCount,
				staticCount: snapshot.staticCount,
			});
			return { version: published.version, etag: published.etag, url };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A deprovision reservation can close the site between stages. Its
			// denied permit also denies the failure receipt; preserve the original
			// failure without writing an unguarded status under a reused slug.
			await record("failed", "failed", message).catch(() => undefined);
			throw err;
		}
	}
}
