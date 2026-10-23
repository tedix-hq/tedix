/**
 * Loader for tenant skill workflow code.
 *
 * Given a skill's `scripts/workflow.ts` source plus its capability manifest,
 * this loads a per-tenant Dynamic Worker via env.LOADER and returns a
 * `WorkflowRunner` (`{ run(event, step) }`) that the dispatcher's
 * `SkillWorkflow` entrypoint can delegate `run()` to.
 *
 * The loaded Worker's internal `env` receives only platform-owned capability
 * stubs:
 *
 *  - `__MCP_BRIDGE__`       — calls tools through apps/mcp.
 *  - `__ARTIFACT_BRIDGE__`  — persists run artifacts to D1/R2.
 *  - `__RATIONALE_BRIDGE__` — emits Work management rationale gates.
 *  - `__RUN_CONTEXT__`      — non-secret metadata for artifact snapshots.
 *
 * `globalOutbound: null` blocks arbitrary `fetch` from tenant code. When the
 * manifest sets `network: true`, all outbound fetches route through the
 * platform `OutboundProxy`, which applies provider credentials without
 * exposing them to the tenant. All workflows can reach declared platform
 * tools through `env.MCP`, backed by `__MCP_BRIDGE__`.
 */

import type { WorkflowRunner } from "@cloudflare/dynamic-workflows";
import { parse as parseModuleSyntax } from "es-module-lexer/js";
import { transform } from "sucrase";
import { PLATFORM_EVIDENCE_MANIFEST } from "./evidence-core";
import { PLATFORM_REASON_MANIFEST, resolveReasonBudget } from "./reason-core";
import {
	buildTenantRunContext,
	COMPATIBILITY_DATE,
	DYNAMIC_WORKFLOWS_VERSION,
	type LoadSkillRuntimeInput,
	type SkillRuntimeEnv,
	type SkillRuntimeExportFactories,
	TENANT_WORKER_LIMITS,
} from "./runner-context";
import { RUNNER_EVIDENCE_SOURCE } from "./runner-evidence";
import { RUNNER_RPC_SOURCE } from "./runner-rpc";
import {
	WORKFLOW_CONTEXT_MODULE,
	WORKFLOW_FETCH_GATE_MODULE,
} from "./runner-sandbox";
import { RUNNER_STEPS_SOURCE } from "./runner-steps";

// Dispatch needs only AsyncLocalStorage. Keep the loaded tenant isolate off the
// broad Node compatibility surface; static-import validation separately allows
// runtime values only from `cloudflare:workflows`.
export const TENANT_COMPATIBILITY_FLAGS = [
	"nodejs_als",
	"disallow_eval_during_startup",
	"disallow_importable_env",
];

/**
 * Enforce the tenant module import boundary again at execution time. Admission
 * validation remains useful authoring feedback, but old/directly persisted
 * snapshots must never be able to import Loader platform modules or
 * `cloudflare:workers` bindings. Parsing the compiled JavaScript also removes
 * erased TypeScript-only imports before this check.
 */
export function assertTenantRuntimeImports(compiledJs: string): void {
	let imports: ReturnType<typeof parseModuleSyntax>[0];
	try {
		[imports] = parseModuleSyntax(compiledJs, "tenant-workflow.js");
	} catch (error) {
		throw new Error(
			`WORKFLOW_MODULE_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	for (const entry of imports) {
		// Only a plain static import or re-export of the workflow binding is
		// allowed. Dynamic imports, import.meta, source/defer phases, and
		// computed specifiers all remain unavailable to tenant source.
		if (
			(entry.type === "static" || entry.type === "reexport-star") &&
			entry.phase === null &&
			entry.specifier === "cloudflare:workflows"
		) {
			continue;
		}
		const specifier =
			entry.specifier ?? compiledJs.slice(entry.start, entry.end);
		throw new Error(
			`WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED: tenant workflow import ${JSON.stringify(specifier || "dynamic/import.meta")} is not allowed`,
		);
	}
}

/** Prefix platform policy before the tenant module's first executable line. */
export function tenantWorkflowModuleSource(compiledJs: string): string {
	return `import { installWorkflowFetchGate } from "./workflow-fetch-gate.js";\ninstallWorkflowFetchGate();\n${compiledJs}`;
}

/**
 * Cache key for a single workflow run's loader stub.
 *
 * The loader env captures run-scoped bridge props (`runId`, source snapshot,
 * manifest, rationale mode). Reusing a stub across runs would leak old run
 * identity into artifacts, rationale, and MCP headers, so runId is part of
 * the key by design.
 */
export function skillRuntimeStubKey(
	input: Pick<
		LoadSkillRuntimeInput,
		"skillId" | "tediId" | "runId" | "executionEpoch" | "loaderConfigHash"
	>,
): string {
	return `${input.skillId}:${input.tediId}:${input.runId}:${input.executionEpoch}:${input.loaderConfigHash}`;
}

// Bump when DISPATCH_SHIM source changes so cached isolates from a previous
// deploy don't shadow updated routing logic.
export const DISPATCH_SHIM_VERSION = "v49-safe-media-post-step";

// Bump when loader-side bridges or host orchestration change the observable
// semantics of an already-started execution epoch. Exact tenant module sources
// are hashed separately; this covers the TypeScript bridge implementations
// that cannot be introspected from a deployed Worker at runtime.
export const WORKFLOW_BRIDGE_COMPATIBILITY_VERSION =
	"v6-manifest-approval-refusal-outcomes";

function createMcpBridgeProps(
	input: LoadSkillRuntimeInput,
	env: SkillRuntimeEnv,
) {
	return {
		manifest: input.manifest,
		tediId: input.tediId,
		aggregateMcpSlug: input.aggregateMcpSlug,
		tediNamespace: input.tediNamespace ?? null,
		orgId: input.orgId,
		skillId: input.skillId,
		runId: input.runId,
		executionEpoch: input.executionEpoch,
		namespaceToSlug: input.namespaceToSlug ?? {},
		mcpBaseHost: env.MCP_URL ? new URL(env.MCP_URL).hostname : "mcp.tedix.dev",
		serviceToken: env.PLATFORM_SERVICE_TOKEN,
		startedBy: input.createdBy ?? null,
		workItemId: input.workItemId ?? null,
	};
}

/**
 * Load (or get) the dynamic worker for this skill+tenant combination and
 * return its `TenantSkillWorkflow` entrypoint as a {@link WorkflowRunner}.
 *
 * The tenant module is expected to default-export a class extending
 * `WorkflowEntrypoint` — by convention named `TenantSkillWorkflow`. The
 * loader resolves it via `getEntrypoint()`.
 */
export function loadSkillRuntime(
	env: SkillRuntimeEnv,
	input: LoadSkillRuntimeInput,
	exports: SkillRuntimeExportFactories,
): WorkflowRunner {
	// Workers Loader requires `.js`/`.mjs` filenames and bare-JS content. Strip
	// TypeScript types via sucrase. Cheap (no JIT), pure-JS, runs in Workers.
	const compiledJs = transform(input.code, {
		transforms: ["typescript"],
		disableESTransforms: true,
		preserveDynamicImport: true,
		jsxRuntime: "preserve",
	}).code;
	assertTenantRuntimeImports(compiledJs);
	const tenantWorkflowJs = tenantWorkflowModuleSource(compiledJs);

	const stub = env.LOADER.get(skillRuntimeStubKey(input), () => {
		// All bindings passed across the loader boundary are loopback RPC stubs
		// or plain non-secret values. The tenant never receives service bindings,
		// platform bearer tokens, D1, R2, or API fetchers.
		const runContext = buildTenantRunContext(input);
		const tenantEnv: Record<string, unknown> = {
			__RUN_CONTEXT__: runContext,
			__MCP_BRIDGE__: exports.McpBridge({
				props: createMcpBridgeProps(input, env),
			}),
			__ARTIFACT_BRIDGE__: exports.ArtifactBridge({
				props: { runId: input.runId },
			}),
			// Grounding runs HOST-side. Tenant code gets a labeling service, not a
			// verdict pen: the scrape, the digest, the exact/entailment decision,
			// and the score all happen behind this stub, and `score()` re-reads its
			// own sealed records instead of trusting whatever comes back across this
			// boundary. Same rule as the ArtifactBridge digest — the platform hashes
			// what it stored, never what it was told.
			__EVIDENCE_BRIDGE__: exports.EvidenceBridge({
				props: {
					runId: input.runId,
					skillId: input.skillId,
					mcp: {
						...createMcpBridgeProps(input, env),
						manifest: PLATFORM_EVIDENCE_MANIFEST,
						namespaceToSlug: input.evidenceNamespaceToSlug ?? {},
					},
				},
			}),
			// Reasoning also runs HOST-side, and for the same reason as grounding:
			// the tenant sends a prompt and gets text back, never a credential and
			// never a verdict. The declared budget is resolved from the manifest
			// here — tenant code cannot raise its own ceiling from inside the
			// sandbox, which matters because the engine retries steps and an
			// unbounded fan-out inside a retried step multiplies.
			__REASON_BRIDGE__: exports.ReasonBridge({
				props: {
					runId: input.runId,
					skillId: input.skillId,
					mcp: {
						...createMcpBridgeProps(input, env),
						manifest: PLATFORM_REASON_MANIFEST,
						namespaceToSlug: input.evidenceNamespaceToSlug ?? {},
					},
					maxCalls: resolveReasonBudget(input.manifest).maxCalls,
				},
			}),
			__RATIONALE_BRIDGE__: exports.RationaleBridge({
				props: {
					runId: input.runId,
					skillId: input.skillId,
					skillSlug: input.skillSlug ?? null,
					tediId: input.tediId,
					orgId: input.orgId,
					rationaleMode: input.manifest.rationale.mode,
					executionEpoch: input.executionEpoch,
					serviceToken: env.PLATFORM_SERVICE_TOKEN,
				},
			}),
		};

		return {
			compatibilityDate: COMPATIBILITY_DATE,
			compatibilityFlags: TENANT_COMPATIBILITY_FLAGS,
			limits: TENANT_WORKER_LIMITS,
			mainModule: "dispatch.js",
			modules: {
				// Tenant workflow code, TypeScript stripped and prefixed with the
				// platform-owned ambient-fetch gate.
				"workflow.js": tenantWorkflowJs,
				"workflow-context.js": WORKFLOW_CONTEXT_MODULE,
				"workflow-fetch-gate.js": WORKFLOW_FETCH_GATE_MODULE,
				// Dispatch shim: builds env.MCP locally from the primitive
				// bindings, then forwards run() to the user's default export.
				"dispatch.js": DISPATCH_SHIM,
			},
			env: tenantEnv,
			// Outbound policy:
			//  - `network: false` (default) → `null`, no ambient network. Tenant
			//    reaches the platform exclusively via `env.MCP`.
			//  - `network: true` → route every tenant `fetch()` through the
			//    platform OutboundProxy, which injects platform-managed provider
			//    credentials (e.g. Gemini) by host. The raw key stays in the
			//    proxy's `ctx.props` (loader-side) and never enters tenant code
			//    or the persisted Workflow payload.
			globalOutbound: input.manifest.network
				? exports.OutboundProxy({
						props: {
							geminiApiKey: env.GEMINI_API_KEY ?? null,
							googleServiceAccountKey: env.GOOGLE_SERVICE_ACCOUNT_KEY ?? null,
							organizationId: input.orgId,
							vertexVideoEndpoint: env.VERTEX_VIDEO_ENDPOINT ?? null,
						},
					})
				: null,
		};
	});

	// `getEntrypoint` returns a typed RPC stub. We assert the runner shape;
	// at runtime the tenant class must extend WorkflowEntrypoint and expose
	// `run(event, step)`.
	const entrypoint = stub.getEntrypoint("TenantSkillWorkflow", {
		limits: TENANT_WORKER_LIMITS,
	});
	return entrypoint as unknown as WorkflowRunner;
}

/**
 * Source of the dispatch shim injected as `dispatch.js` (mainModule) of the
 * tenant Worker. It:
 *
 *  1. Re-exports `TenantSkillWorkflow` as a class extending
 *     `WorkflowEntrypoint` so `getEntrypoint("TenantSkillWorkflow")` resolves.
 *  2. Builds `env.MCP` as a local Proxy over `__MCP_BRIDGE__`.
 *  3. Persists artifacts/rationale through dedicated bridge stubs.
 *  4. Forwards `run()` to the user's default-exported
 *     `{ async run(event, step, env) }` object.
 */
export const DISPATCH_SHIM = `import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { workflowCallContext } from "./workflow-context.js";
import {
  allWorkflowPromises,
  bindWorkflowFunction,
  callWorkflowFunction,
  createWorkflowError,
  createWorkflowMap,
  createWorkflowOperationSet,
  createWorkflowProxy,
  createSensitiveWorkflowError,
  createWorkflowTypeError,
  drainWorkflowOperations,
  digestWorkflowHex,
  encodeWorkflowPathSegment,
  errorWorkflow,
  finallyWorkflowPromise,
  frameWorkflowIdentity,
  freezeWorkflowValue,
  getWorkflowMapValue,
  getWorkflowDispose,
  joinWorkflowArray,
  matchWorkflowString,
  parseWorkflowJson,
  pushWorkflowArray,
  rejectWorkflowPromise,
  resolveWorkflowPromise,
  setWorkflowMapValue,
  sliceWorkflowString,
  stringifyWorkflowJson,
  testWorkflowRegex,
  thenWorkflowPromise,
  trackWorkflowOperation,
  warnWorkflow,
  withWorkflowTimeout,
  workflowObjectKeys,
  workflowOwnKeys,
  workflowBoolean,
  workflowIsoNow,
  workflowNowMs,
  workflowNumber,
  workflowString,
  workflowTimestampValue,
} from "./workflow-fetch-gate.js";
import userMod from "./workflow.js";

${RUNNER_RPC_SOURCE}${RUNNER_EVIDENCE_SOURCE}${RUNNER_STEPS_SOURCE}export class TenantSkillWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    try {
      const target = userMod && typeof userMod === "object" && userMod.default ? userMod.default : userMod;
      if (!target || typeof target.run !== "function") {
        const tk = userMod ? joinWorkflowArray(workflowObjectKeys(userMod), ",") : "(null)";
        throw createWorkflowError("DISPATCH_NO_RUN: workflow.js must default-export an object with an async run(event, step, env) method (got keys: " + tk + ")");
      }
	      // Tenant isolation: explicit allowlist of bindings the user code can see.
	      // Spreading this.env leaks platform-only bindings (D1, R2, secrets,
	      // service bindings) that the workflow has no business touching. Tenant
	      // code reaches the platform via env.MCP only.
	      //
	      // Tenant code cannot write blobs directly: a large bridge RPC inside
	      // step.do can stall the native step. The wrapper recognizes generated
	      // media outputs and writes their raw bytes only after step.do resolves.
	      const meta = freezeWorkflowValue(this.env.__RUN_CONTEXT__ || {});
	      const tenantEnv = {
	        MCP: buildMcpProxy(this.env, meta),
	        // Host-side grounding. A skill inherits verification; it does not
	        // implement it, and it cannot vouch for itself.
	        EVIDENCE: buildEvidenceProxy(this.env, meta),
	        // Ephemeral, memory-free reasoners for fan-out (judges, refuters,
	        // independent samples). Reasoning is not grounding: this returns text,
	        // and only EVIDENCE decides whether a claim is supported.
	        REASON: buildReasonProxy(this.env, meta),
	        // Non-secret, run-scoped identity and provenance. Workflow code needs
	        // this to behave identically for direct and scheduled invocations.
	        __RUN_CONTEXT__: meta,
	      };

      // One-time artifacts at workflow boot — inputs (the dispatch payload)
	      // and the capability manifest snapshot. These are read-once and never
		      // change for a given run.
	      const manifest = {
	        skillId: meta.skillId,
	        skillSlug: meta.skillSlug,
	        tediId: meta.tediId,
	        orgId: meta.orgId,
	        runId: meta.runId,
	        executionEpoch: meta.executionEpoch,
	        workItemId: meta.workItemId,
	        capabilities: meta.capabilityManifest,
	        namespaceToSlug: meta.namespaceToSlug,
	        provenance: meta.provenance,
	      };
	      const loaderConfigHash = meta.provenance && meta.provenance.runtime &&
	        meta.provenance.runtime.loaderConfigHash;
	      await allWorkflowPromises([
	        persistArtifactOnce(this.env, {
	          path: "inputs.json",
	          value: {
	            event: workflowEventSnapshot(event),
	            admittedAt: meta.admittedAt,
	          },
        }),
	        persistArtifact(this.env, {
	          path: "manifest.json",
	          value: manifest,
	        }),
	        persistArtifact(this.env, {
	          path: "epochs/" + meta.executionEpoch + "/manifest.json",
	          value: manifest,
	        }),
	        ...(loaderConfigHash ? [persistArtifactOnce(this.env, {
	          path: "epochs/" + meta.executionEpoch + "/manifests/" + loaderConfigHash + ".json",
	          value: manifest,
	        })] : []),
	      ]);

	      const timeline = makeTimeline();
	      const wrappedStep = wrapStep(step, this.env, timeline, meta);
	      const schedulePolicy = meta.capabilityManifest && meta.capabilityManifest.schedule;
	      const scheduledInference = schedulePolicy && schedulePolicy.executionKind === "inference";
	      if (scheduledInference) {
	        if (typeof target.eligibility !== "function") {
	          throw new NonRetryableError(
	            "BACKGROUND_ELIGIBILITY_REQUIRED: inference schedules must export eligibility(event, step, env)",
	            "BackgroundEligibilityContractError",
	          );
	        }
	        const eligibility = await target.eligibility(event, wrappedStep, tenantEnv);
	        const eligibilityValid = eligibility && typeof eligibility === "object" &&
	          (eligibility.status === "eligible" || eligibility.status === "no_work" || eligibility.status === "unavailable") &&
	          typeof eligibility.inputWatermark === "string" && eligibility.inputWatermark.length > 0 &&
	          Array.isArray(eligibility.evidenceRefs) && eligibility.evidenceRefs.length > 0 &&
	          eligibility.evidenceRefs.every((ref) => typeof ref === "string" && ref.length > 0);
	        if (!eligibilityValid) {
	          throw new NonRetryableError(
	            "BACKGROUND_ELIGIBILITY_INVALID: expected status, inputWatermark, and evidenceRefs",
	            "BackgroundEligibilityContractError",
	          );
	        }
	        await persistArtifact(this.env, {
	          path: "background/eligibility.json",
	          value: eligibility,
	          outcome: eligibility.status === "unavailable" ? "failure" : "success",
	        });
	        if (eligibility.status === "unavailable") {
	          throw new NonRetryableError(
	            "BACKGROUND_INPUT_UNAVAILABLE: " + (eligibility.reason || "declared inputs could not be read"),
	            "BackgroundInputUnavailableError",
	          );
	        }
	        if (eligibility.status === "no_work") {
	          const skippedOutcome = {
	            schemaVersion: 1,
	            classification: "no_change",
	            inputWatermark: eligibility.inputWatermark,
	            evidenceRefs: eligibility.evidenceRefs,
	            summary: eligibility.reason || "No actionable input",
	          };
	          await persistArtifact(this.env, {
	            path: "background/outcome.json",
	            value: skippedOutcome,
	            outcome: "success",
	          });
	          return {
	            backgroundOutcome: skippedOutcome,
	          };
	        }
	      }
	      const output = await target.run(event, wrappedStep, tenantEnv);
	      if (scheduledInference) {
	        const outcome = output && typeof output === "object" && output.backgroundOutcome;
	        const allowed = ["no_change", "observation", "proposal", "verified_action", "partial", "failed"];
	        const outcomeValid = outcome && typeof outcome === "object" && outcome.schemaVersion === 1 &&
	          allowed.includes(outcome.classification) &&
	          typeof outcome.inputWatermark === "string" && outcome.inputWatermark.length > 0 &&
	          Array.isArray(outcome.evidenceRefs) && outcome.evidenceRefs.length > 0 &&
	          outcome.evidenceRefs.every((ref) => typeof ref === "string" && ref.length > 0);
	        if (!outcomeValid) {
	          throw new NonRetryableError(
	            "BACKGROUND_OUTCOME_REQUIRED: inference schedules must return backgroundOutcome with classification, inputWatermark, and evidenceRefs",
	            "BackgroundOutcomeContractError",
	          );
	        }
	        await persistArtifact(this.env, {
	          path: "background/outcome.json",
	          value: outcome,
	          outcome: outcome.classification === "failed" ? "failure" : "success",
	        });
	      }
	      return output;
	    } catch (err) {
	      const msg = err && err.message ? err.message : workflowString(err);
	      const stack = err && err.stack ? err.stack : "";
      errorWorkflow("TENANT_RUN_ERROR " + msg + "\\n" + stack);
      throw err;
    }
  }
}
export default TenantSkillWorkflow;
`;
