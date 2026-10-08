/**
 * Static `WorkflowEntrypoint` registered with Cloudflare Workflows.
 *
 * The Workflows engine invokes this class for every run. We use
 * `@cloudflare/dynamic-workflows` to:
 *
 *  1. Read the dispatcher metadata stashed on `event.payload` by
 *     `wrapWorkflowBinding()` at create time.
 *  2. Re-load the per-tenant Worker via env.LOADER.
 *  3. Forward `run(event, step)` to the loaded Worker's
 *     `TenantSkillWorkflow.run`.
 *
 * The `WORKFLOWS` binding in `cloudflare.config.ts` names this class
 * (`SkillWorkflow`).
 */
import type { WorkflowStep } from "cloudflare:workers";
import { createDynamicWorkflowEntrypoint } from "@cloudflare/dynamic-workflows";
import {
	parseCapabilityManifest,
	readPinnedCapabilityManifest,
} from "@tedix/api-contract/utils/skill-manifest";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	logFactoryEvidenceRetry,
	logFactoryFailure,
	logSkillRuntimeWarning,
} from "./control-log";
import {
	loadSkillRunSnapshot,
	resolveNamespaceSlugs,
	resolveSkillNamespaceSlugs,
	resolveSkillWorkflowMcpGateway,
	skillRunEnvironmentMatches,
} from "./db";
import { enforceGroundingPolicy } from "./evidence";
import {
	EVIDENCE_SCRAPE_NAMESPACE,
	PLATFORM_EVIDENCE_MANIFEST,
} from "./evidence-core";
import {
	COMPATIBILITY_DATE,
	DISPATCH_SHIM,
	DISPATCH_SHIM_VERSION,
	DYNAMIC_WORKFLOWS_VERSION,
	loadSkillRuntime,
	type SkillRuntimeExportFactories,
	TENANT_COMPATIBILITY_FLAGS,
	TENANT_WORKER_LIMITS,
	WORKFLOW_BRIDGE_COMPATIBILITY_VERSION,
	WORKFLOW_CONTEXT_MODULE,
	WORKFLOW_FETCH_GATE_MODULE,
} from "./runner";
import { withWorkflowEvidenceRetry } from "./workflow-evidence";
import {
	fingerprintWorkflowError,
	fingerprintWorkflowOutput,
	recordWorkflowExecutionEpochOutcome,
	recordWorkflowExecutionEpochStarted,
} from "./workflow-restart";
import { assertWorkflowExecutionEpochRuntimePin } from "./workflow-runtime-pin";

interface SkillWorkflowEnv {
	LOADER: WorkerLoader;
	DB: D1Database;
	SKILL_ARTIFACTS: R2Bucket;
	VIDEO_BUCKET: R2Bucket;
	MCP_SERVICE: Fetcher;
	PLATFORM_SERVICE_TOKEN: string;
	WORKER_VERSION: WorkerVersionMetadata;
	ENVIRONMENT: "development" | "staging" | "production";
	MCP_URL?: string;
	/**
	 * Platform-global Gemini key. Injected into `network: true` skill outbound,
	 * and used host-side as the grounding entailment judge.
	 */
	GEMINI_API_KEY?: string;
	GOOGLE_SERVICE_ACCOUNT_KEY?: string;
	VERTEX_VIDEO_ENDPOINT?: string;
}

interface SkillDispatcherMetadata {
	skillId: string;
	tediId: string;
	orgId: string;
	runId: string;
}

function canonicalJson(value: unknown): string {
	const normalize = (current: unknown): unknown => {
		if (Array.isArray(current)) return current.map(normalize);
		if (current && typeof current === "object") {
			return Object.fromEntries(
				Object.entries(current as Record<string, unknown>)
					.filter(([, item]) => item !== undefined)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, item]) => [key, normalize(item)]),
			);
		}
		return current;
	};
	return JSON.stringify(normalize(value));
}

function normalizeWorkflowResult(value: unknown): unknown {
	if (value === undefined) return undefined;
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new Error(
			"WORKFLOW_OUTPUT_NOT_SERIALIZABLE: workflow result must be JSON-serializable",
		);
	}
	return JSON.parse(serialized);
}

export const SkillWorkflow = createDynamicWorkflowEntrypoint<SkillWorkflowEnv>(
	async ({ env, metadata, ctx }) => {
		let executionEpoch: number | null = null;
		try {
			const meta = metadata as Partial<SkillDispatcherMetadata>;
			if (!meta.skillId || !meta.tediId || !meta.orgId || !meta.runId) {
				throw new Error(
					`SkillWorkflow: dispatcher metadata missing required fields (got ${JSON.stringify(metadata)})`,
				);
			}

			// The factory is invoked on every hibernation/resume cycle
			// (step.waitForEvent, step.sleep). Always read the run-pinned snapshot
			// so in-flight runs cannot drift when the skill row changes.
			const snapshot = await withWorkflowEvidenceRetry("snapshot.read", () =>
				loadSkillRunSnapshot(env.DB, meta.runId!),
			);
			if (!snapshot) {
				throw new Error(
					`SkillWorkflow: run ${meta.runId} is missing a pinned workflow snapshot`,
				);
			}
			if (
				meta.skillId !== snapshot.skillId ||
				meta.tediId !== snapshot.tediId ||
				meta.orgId !== snapshot.orgId
			) {
				throw new Error(
					`SkillWorkflow: dispatcher metadata does not match pinned run ${meta.runId}`,
				);
			}
			if (
				!skillRunEnvironmentMatches(
					snapshot.runtimeEnvironment,
					env.ENVIRONMENT,
				)
			) {
				throw new Error(
					`WORKFLOW_ENVIRONMENT_MISMATCH: run ${meta.runId} belongs to ${snapshot.runtimeEnvironment}, not ${env.ENVIRONMENT}`,
				);
			}
			executionEpoch = snapshot.executionEpoch;
			await withWorkflowEvidenceRetry(
				"epoch.started",
				() =>
					recordWorkflowExecutionEpochStarted({
						db: env.DB,
						runId: meta.runId!,
						executionEpoch: executionEpoch!,
					}),
				{
					onRetry: (error, attempt) =>
						logFactoryEvidenceRetry("started", error, {
							runId: meta.runId,
							executionEpoch: executionEpoch!,
							attempt,
						}),
				},
			);

			const manifest = readPinnedCapabilityManifest(
				snapshot.capabilityManifest,
			);
			if (!manifest) {
				throw new Error(
					`SkillWorkflow: run ${meta.runId} has an invalid pinned capability manifest`,
				);
			}
			const reparsedManifest = parseCapabilityManifest(snapshot.skillDoc);
			if (JSON.stringify(reparsedManifest) !== JSON.stringify(manifest)) {
				logSkillRuntimeWarning("factory.capability_parser_drift", {
					runId: meta.runId,
					skillId: snapshot.skillId,
				});
			}
			const namespaces = Object.keys(manifest.mcp ?? {});
			const namespaceToSlug = await resolveSkillNamespaceSlugs(env.DB, {
				orgId: snapshot.orgId,
				skillId: snapshot.skillId,
				namespaces,
				runId: meta.runId,
			});
			// Routing for the PLATFORM's evidence scrape. Resolved separately from
			// the tenant map so grounding works for every skill without the skill
			// declaring — or being able to widen — scrape access.
			const evidenceNamespaceToSlug = await resolveNamespaceSlugs(env.DB, [
				EVIDENCE_SCRAPE_NAMESPACE,
			]);
			// Resolve the org-owned Code Mode gateway and the tedi's configured
			// namespace from D1. Neither can be inferred from Tedix's own
			// `tedix-unified`/slug conventions. This lookup grants no capability:
			// manifest gates still run before every call.
			const aggregateGateway = await resolveSkillWorkflowMcpGateway(
				env.DB,
				snapshot.orgId,
				snapshot.tediId,
			);
			if (!aggregateGateway) {
				throw new Error(
					`MCP_AGGREGATE_UNRESOLVED: organization ${snapshot.orgId} has no authenticated Code Mode aggregate for tedi ${snapshot.tediId}`,
				);
			}
			const [
				workflowSha256,
				skillDocSha256,
				dispatchShimSha256,
				workflowContextSha256,
				workflowFetchGateSha256,
			] = await Promise.all([
				sha256Hex(snapshot.workflowSource),
				sha256Hex(snapshot.skillDoc),
				sha256Hex(DISPATCH_SHIM),
				sha256Hex(WORKFLOW_CONTEXT_MODULE),
				sha256Hex(WORKFLOW_FETCH_GATE_MODULE),
			]);
			const mcpBaseHost = env.MCP_URL
				? new URL(env.MCP_URL).hostname
				: "mcp.tedix.dev";
			// This hash owns whether an already-started execution epoch can safely
			// resume. It covers every tenant-visible Loader/runtime surface while
			// deliberately excluding deploy identity and credential rotation.
			// Those still select a new immutable Loader config below, but they do
			// not change workflow semantics by themselves.
			const executionCompatibilityHash = await sha256Hex(
				canonicalJson({
					source: { workflowSha256, skillDocSha256 },
					manifest,
					routing: {
						namespaceToSlug,
						aggregateGateway,
						evidenceNamespaceToSlug,
					},
					mcpBaseHost,
					platformEvidenceManifest: PLATFORM_EVIDENCE_MANIFEST,
					runtimeSurface: {
						bridgeCompatibilityVersion: WORKFLOW_BRIDGE_COMPATIBILITY_VERSION,
						dispatchShimVersion: DISPATCH_SHIM_VERSION,
						compatibilityDate: COMPATIBILITY_DATE,
						compatibilityFlags: TENANT_COMPATIBILITY_FLAGS,
						dynamicWorkflowsVersion: DYNAMIC_WORKFLOWS_VERSION,
						tenantLimits: TENANT_WORKER_LIMITS,
						modules: {
							dispatchShimSha256,
							workflowContextSha256,
							workflowFetchGateSha256,
						},
					},
				}),
			);
			const runtimeProvenance = {
				workerVersionId: env.WORKER_VERSION.id,
				workerVersionTag: env.WORKER_VERSION.tag,
				workerVersionTimestamp: env.WORKER_VERSION.timestamp,
				executionCompatibilityHash,
				dispatchShimVersion: DISPATCH_SHIM_VERSION,
				compatibilityDate: COMPATIBILITY_DATE,
				dynamicWorkflowsVersion: DYNAMIC_WORKFLOWS_VERSION,
				tenantCpuMs: TENANT_WORKER_LIMITS.cpuMs,
				tenantSubRequests: TENANT_WORKER_LIMITS.subRequests,
			};
			const [serviceTokenVersion, outboundCredentialVersion] =
				await Promise.all([
					sha256Hex(env.PLATFORM_SERVICE_TOKEN),
					manifest.network && env.GEMINI_API_KEY
						? sha256Hex(env.GEMINI_API_KEY)
						: null,
				]);
			// Worker Loader ids are cache hints, but a given id must always resolve
			// to identical WorkerCode/config. Deployment and credential versions
			// therefore select a fresh immutable Loader even when the separately
			// computed execution surface remains compatible with an in-flight epoch.
			const loaderConfigHash = await sha256Hex(
				canonicalJson({
					executionCompatibilityHash,
					deployment: {
						workerVersionId: runtimeProvenance.workerVersionId,
						workerVersionTag: runtimeProvenance.workerVersionTag,
						workerVersionTimestamp: runtimeProvenance.workerVersionTimestamp,
					},
					// One-way versions ensure secret rotation selects a new Loader id.
					// The raw credentials never enter the digest payload or artifacts.
					secretVersions: {
						serviceToken: serviceTokenVersion,
						outboundCredential: outboundCredentialVersion,
					},
				}),
			);
			const provenance = {
				source: {
					workflowSha256,
					skillDocSha256,
					skillRevision: snapshot.skillRevision,
					skillSlug: snapshot.skillSlug,
				},
				runtime: { ...runtimeProvenance, loaderConfigHash },
			};
			await withWorkflowEvidenceRetry("epoch.runtime_pin", () =>
				assertWorkflowExecutionEpochRuntimePin({
					db: env.DB,
					runId: meta.runId!,
					pin: {
						executionEpoch: snapshot.executionEpoch,
						provenance,
					},
				}),
			);
			console.log(
				JSON.stringify({
					service: "skill-runtime",
					event: "factory.loaded",
					runId: meta.runId,
					skillId: snapshot.skillId,
					codeBytes: snapshot.workflowSource.length,
					skillDocBytes: snapshot.skillDoc.length,
					mcpNamespaces: namespaces,
					namespaceToSlug,
					network: manifest.network,
					skillRevision: snapshot?.skillRevision ?? null,
					loaderConfigHash,
				}),
			);

			const tenantRunner = loadSkillRuntime(
				env,
				{
					skillId: snapshot.skillId,
					skillSlug: snapshot?.skillSlug ?? null,
					tediId: snapshot.tediId,
					aggregateMcpSlug: aggregateGateway.slug,
					tediNamespace: aggregateGateway.tediNamespace,
					orgId: snapshot.orgId,
					runId: meta.runId,
					executionEpoch: snapshot.executionEpoch,
					admittedAt: snapshot.admittedAt,
					createdBy: snapshot.createdBy ?? null,
					workItemId: snapshot.workItemId ?? null,
					loaderConfigHash,
					code: snapshot.workflowSource,
					manifest,
					namespaceToSlug,
					evidenceNamespaceToSlug,
					provenance,
				},
				ctx.exports as unknown as SkillRuntimeExportFactories,
			);
			return {
				async run(event, step) {
					const nativeStep = step as WorkflowStep;
					try {
						// Crossing the Dynamic Worker RPC boundary happens before this
						// point. Normalize once more to the JSON output contract before
						// asserting completion at the static dispatcher boundary.
						const output = normalizeWorkflowResult(
							await tenantRunner.run(event, step),
						);
						// Grounding policy. Evaluated here, in the dispatcher, so a
						// workflow cannot skip its own audit — but recorded as a WARNING,
						// not a failure. A skill authored before this primitive existed
						// declares nothing and is untouched; a skill that declares
						// `grounding.required: true` and never called EVIDENCE.score()
						// leaves a durable verdict at `evidence/policy.json` instead of
						// losing the work it did. Tightening this to a hard failure is a
						// deliberate second step, once skills have had a release to adopt.
						if (manifest.grounding.required) {
							const policyVerdict = await nativeStep.do(
								`tedix epoch ${snapshot.executionEpoch} grounding policy`,
								{
									retries: {
										limit: 3,
										delay: "1 second",
										backoff: "exponential",
									},
									timeout: "30 seconds",
								},
								async () =>
									enforceGroundingPolicy({
										db: env.DB,
										artifacts: env.SKILL_ARTIFACTS,
										runId: meta.runId!,
										policy: manifest.grounding,
									}),
							);
							// The enforcement ratchet. `enforce: "fail"` marks the RUN failed
							// when the sealed verdict is a violation — thrown outside the
							// policy step, so the durable verdict at evidence/policy.json is
							// always sealed first, and thrown as NonRetryableError because
							// re-running the dispatcher cannot change an already-scored run.
							// Failing here also fires the skill.failed alerting path (work
							// item to a human). Honest scope: this runs after the tenant
							// workflow returned, so it cannot retract side effects the
							// workflow already performed — withholding a publish on a bad
							// grounding score remains the workflow's own gate (grounding.md).
							if (
								manifest.grounding.enforce === "fail" &&
								policyVerdict.verdict === "warn"
							) {
								// Imported lazily: `cloudflare:workflows` only resolves inside
								// workerd, and this module is also loaded by the plain-Bun test
								// harness, which must never take this branch.
								const { NonRetryableError } =
									await import("cloudflare:workflows");
								throw new NonRetryableError(
									`GROUNDING_POLICY_VIOLATION: ${policyVerdict.code} — ${policyVerdict.message}`,
									"GroundingPolicyViolationError",
								);
							}
						}
						const terminalFingerprint = await fingerprintWorkflowOutput(output);
						if (!terminalFingerprint) {
							throw new Error(
								"WORKFLOW_OUTPUT_NOT_FINGERPRINTABLE: workflow result cannot be fenced",
							);
						}
						await nativeStep.do(
							`tedix epoch ${snapshot.executionEpoch} completed fence`,
							{
								retries: {
									limit: 5,
									delay: "1 second",
									backoff: "exponential",
								},
								timeout: "30 seconds",
							},
							async () => {
								await recordWorkflowExecutionEpochOutcome({
									db: env.DB,
									runId: meta.runId!,
									executionEpoch: snapshot.executionEpoch,
									outcome: "completed",
									terminalFingerprint,
								});
								return true;
							},
						);
						return output;
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						const terminalFingerprint = await fingerprintWorkflowError(message);
						await nativeStep.do(
							`tedix epoch ${snapshot.executionEpoch} failed fence`,
							{
								retries: {
									limit: 5,
									delay: "1 second",
									backoff: "exponential",
								},
								timeout: "30 seconds",
							},
							async () => {
								await recordWorkflowExecutionEpochOutcome({
									db: env.DB,
									runId: meta.runId!,
									executionEpoch: snapshot.executionEpoch,
									outcome: "failed",
									terminalFingerprint,
								});
								return true;
							},
						);
						throw error;
					}
				},
			};
		} catch (err) {
			const meta = metadata as Partial<SkillDispatcherMetadata>;
			const errorMessage = err instanceof Error ? err.message : String(err);
			if (
				meta.runId &&
				executionEpoch != null &&
				!errorMessage.startsWith("WORKFLOW_INSTANCE_RETIRED:")
			) {
				try {
					const terminalFingerprint =
						await fingerprintWorkflowError(errorMessage);
					await withWorkflowEvidenceRetry(
						"epoch.failed",
						() =>
							recordWorkflowExecutionEpochOutcome({
								db: env.DB,
								runId: meta.runId!,
								executionEpoch: executionEpoch!,
								outcome: "failed",
								terminalFingerprint,
							}),
						{
							onRetry: (error, attempt) =>
								logFactoryEvidenceRetry("failed", error, {
									runId: meta.runId,
									executionEpoch: executionEpoch!,
									attempt,
								}),
						},
					);
				} catch (fenceError) {
					throw new Error(
						`WORKFLOW_EPOCH_FAILURE_FENCE_FAILED: ${fenceError instanceof Error ? fenceError.message : String(fenceError)}; original error: ${errorMessage}`,
						{ cause: err },
					);
				}
			}
			logFactoryFailure(err, meta.runId);
			throw err;
		}
	},
);
