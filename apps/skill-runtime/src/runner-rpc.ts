import { WORKFLOW_TOOL_REFUSAL_PATTERN } from "./workflow-call-outcome";

export const MCP_COMPLETION_FAILURE_INSPECTOR_SOURCE = `
function workflowMcpCompletionFailure(result) {
  if (!result || typeof result !== "object") return null;
  const evidence = result.completionEvidence;
  if (!evidence || typeof evidence !== "object") return null;
  const status = evidence.status;
  if (status !== "failed" && status !== "canceled") return null;
  const retry = evidence.retry && typeof evidence.retry === "object"
    ? evidence.retry
    : null;
  const detail = typeof result.error === "string"
    ? result.error
    : typeof result.message === "string"
      ? result.message
      : evidence.operation
        ? String(evidence.operation) + " reported " + status
        : "tool reported " + status;
  return {
    status,
    detail,
    nonRetryable: retry?.blocked === true || retry?.retryable === false
      || /(?:^|:\\s)(?:BAD_REQUEST|NOT_FOUND):|Input validation failed/i.test(detail),
  };
}
`;

export const MCP_PROVIDER_CONFIRMATION_INSPECTOR_SOURCE = `
function workflowMcpProviderConfirmation(result) {
  if (!result || typeof result !== "object") return "unknown";
  const evidence = result.completionEvidence;
  if (!evidence || typeof evidence !== "object") return "unknown";
  const confirmation = evidence.providerConfirmation;
  if (typeof confirmation !== "string" || !testWorkflowRegex(/\\S/, confirmation)) {
    return "unknown";
  }
  return sliceWorkflowString(confirmation, 0, 500);
}
`;

export const FACTORY_WORK_DEFAULTS_SOURCE = `
function factoryWorkDefaults(namespace, method, args, factory) {
  const input = args == null ? {} : args;
  if (!factory || !input.factoryCycle || !(method === "create_work_items" || (namespace === "tedi" && method === "work_item_create"))) return input;
  return {
   ...input,
   projectId: input.projectId ?? factory.projectId,
   objectiveId: input.objectiveId ?? factory.objectiveId,
   factoryCycle: {
    ...input.factoryCycle,
    workspaceId: input.factoryCycle.workspaceId ?? factory.workspaceId,
    blueprintRevisionId: input.factoryCycle.blueprintRevisionId ?? factory.blueprintRevisionId,
   },
  };
}
`;

export const RUNNER_RPC_SOURCE = `// Outer RPC-boundary guard for env.MCP calls. Generous because some tools are
// legitimately slow: git-backed artifact_read/write_file, and run_tedi_turn
// (which runs a full LLM turn — a report-generating judgment turn settles in
// ~30-90s). The per-step step.do timeout the tenant sets is the real governor;
// this only trips on a genuinely hung RPC. Must be >= the inner mcp-bridge
// MCP_BRIDGE_TIMEOUT_MS so it never preempts a legit in-flight call.
const BRIDGE_CALL_TIMEOUT_MS = 240000;

function disposeRpcValue(value) {
  const dispose = getWorkflowDispose(value) || (value && value.dispose);
  if (typeof dispose === "function") {
    try {
      callWorkflowFunction(dispose, value, []);
    } catch (e) {
      warnWorkflow("rpc_dispose threw", e && e.message);
    }
  }
}

function withBridgeTimeout(promise, label) {
  return withWorkflowTimeout(promise, label, BRIDGE_CALL_TIMEOUT_MS);
}

function observeRpcCall(call, label) {
  const observed = finallyWorkflowPromise(
    thenWorkflowPromise(resolveWorkflowPromise(call), (result) => {
      disposeRpcValue(result);
      return result;
    }),
    () => disposeRpcValue(call),
  );
  return withBridgeTimeout(observed, label);
}

function runWithWorkflowCallContext(active, callback) {
  return workflowCallContext.run(active, async () => {
    try {
      const value = await callback();
      // A tenant may forget to await fetch() or env.MCP. Keep the native step
      // open until every operation initiated under its authority has settled;
      // an unobserved rejection fails the step instead of being cached as a
      // false success.
      await drainWorkflowOperations(active);
      return value;
    } catch (error) {
      // Preserve the original callback/network error, but do not return while
      // other already-started requests are still in flight.
      try {
        await drainWorkflowOperations(active);
      } catch {}
      throw error;
    } finally {
      active.enabled = false;
    }
  });
}

async function buildStepId(runId, executionEpoch, stepType, stepName, stepCount) {
  const stepHash = await digestWorkflowHex(frameWorkflowIdentity([runId, executionEpoch, stepType, stepName, stepCount]));
  return "wfstep_" + stepHash;
}

async function buildCallIdentity(runId, executionEpoch, namespace, method, context) {
  const stepId = await buildStepId(runId, executionEpoch, context.stepType, context.stepName, context.stepCount);
  const idempotencyHash = await digestWorkflowHex(frameWorkflowIdentity([
    runId,
    executionEpoch,
    context.stepType,
    context.stepName,
    context.stepCount,
    context.phase,
    namespace,
    method,
    context.ordinal,
  ]));
  const callHash = await digestWorkflowHex(frameWorkflowIdentity([idempotencyHash, context.attempt]));
  return {
    stepId,
    idempotencyKey: "wfidem_" + idempotencyHash,
    callId: "wfcall_" + callHash,
  };
}

// Bounded call-payload snapshot for tool-call receipts. Receipts are evidence,
// not transport: cap the serialized size so a large scrape/report can never
// bloat the artifact store, and mark truncation honestly instead of silently
// cutting JSON mid-token. Truncation is STRUCTURE-PRESERVING: long strings
// inside the payload are clipped individually so readers (audit surfaces, the
// dashboard AI pane) can still reach fields like text or assistant.content
// on an oversized payload.
const EVIDENCE_VALUE_BUDGET = 8_192;
const EVIDENCE_STRING_CAP = 2_048;
const EVIDENCE_ARRAY_CAP = 50;
const EVIDENCE_DEPTH_CAP = 6;

function clipEvidenceStrings(value, depth) {
  if (typeof value === "string") {
    return value.length > EVIDENCE_STRING_CAP
      ? sliceWorkflowString(value, 0, EVIDENCE_STRING_CAP) + "…[truncated]"
      : value;
  }
  if (value == null || typeof value !== "object") return value;
  if (depth >= EVIDENCE_DEPTH_CAP) return "[nested]";
  if (Array.isArray(value)) {
    const clipped = value
      .slice(0, EVIDENCE_ARRAY_CAP)
      .map((v) => clipEvidenceStrings(v, depth + 1));
    if (value.length > EVIDENCE_ARRAY_CAP) {
      clipped.push("…[+" + (value.length - EVIDENCE_ARRAY_CAP) + " more]");
    }
    return clipped;
  }
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = clipEvidenceStrings(value[key], depth + 1);
  }
  return out;
}

function boundedEvidenceValue(value) {
  let text;
  try {
    text = stringifyWorkflowJson(value);
  } catch {
    text = workflowString(value);
  }
  if (typeof text !== "string") return { truncated: false, value: null };
  if (text.length <= EVIDENCE_VALUE_BUDGET) {
    return { truncated: false, value };
  }
  // Oversized: clip long strings in place so the payload SHAPE survives.
  try {
    const clipped = clipEvidenceStrings(value, 0);
    const clippedText = stringifyWorkflowJson(clipped);
    if (
      typeof clippedText === "string" &&
      clippedText.length <= EVIDENCE_VALUE_BUDGET * 4
    ) {
      return { truncated: true, sizeBytes: text.length, value: clipped };
    }
  } catch {
    // fall through to the flat preview
  }
  return {
    truncated: true,
    sizeBytes: text.length,
    preview: sliceWorkflowString(text, 0, EVIDENCE_VALUE_BUDGET),
  };
}

function redactedMcpEvidence() {
  return { redacted: true, reason: "workflow_step_sensitive_output" };
}

function redactedErrorSnapshot() {
  return {
    name: "SensitiveWorkflowStepError",
    message: "Sensitive workflow step error redacted",
    code: "WORKFLOW_SENSITIVE_ERROR_REDACTED",
    redacted: true,
  };
}

${FACTORY_WORK_DEFAULTS_SOURCE}
${MCP_COMPLETION_FAILURE_INSPECTOR_SOURCE}
${MCP_PROVIDER_CONFIRMATION_INSPECTOR_SOURCE}

function errorSnapshot(error) {
  const message = error && error.message ? workflowString(error.message) : workflowString(error);
  const inferred = matchWorkflowString(message, /^([A-Z][A-Z0-9_]+):/);
  return {
    name: error && error.name ? workflowString(error.name) : "Error",
    message,
    code: error && typeof error.code === "string"
      ? error.code
      : inferred ? inferred[1] : undefined,
  };
}

function permanentBridgeError(error) {
  const message = error && error.message ? workflowString(error.message) : workflowString(error);
  if (testWorkflowRegex(/CAPABILITY_NOT_DECLARED|ANNOTATION_VIOLATION|MCP_INPUT_REQUIRED|MCP_TASK_(?:FAILED|CANCELLED):|MCP_UPSTREAM_RESPONSE_TOO_LARGE|WORKFLOW_CALL_CONTEXT_INVALID|WORKFLOW_TEDI_TASK_ORIGIN_MISMATCH|MCP_TARGET_UNRESOLVED|MCP_BRIDGE_MISSING|(?:^|:\\s)(?:BAD_REQUEST|NOT_FOUND):|Input validation failed|unauthorized|forbidden|AUTH_/i, message)) {
    return true;
  }
  const statusMatch = matchWorkflowString(message, /MCP upstream returned\\s+(\\d{3})/i);
  if (!statusMatch) return false;
  const status = workflowNumber(statusMatch[1]);
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}

function normalizeBridgeError(error) {
  if (error instanceof NonRetryableError || !permanentBridgeError(error)) return error;
  const message = error && error.message ? workflowString(error.message) : workflowString(error);
  return new NonRetryableError(message, error && error.name ? workflowString(error.name) : "McpPermanentError");
}

async function recordWorkflowNetworkCall(env, runContext, active, request, invoke) {
  const ordinal = (active.nextNetworkOrdinal || 0) + 1;
  active.nextNetworkOrdinal = ordinal;
  const path = "epochs/" + runContext.executionEpoch + "/steps/"
    + active.stepPathSegment + "/" + (active.nativeStepCount || active.stepCount)
    + "/attempts/" + active.attempt + "/network/" + active.phase + "/" + ordinal + ".json";
  const startedAt = workflowIsoNow();
  const t0 = workflowNowMs();
  const started = {
    schemaVersion: 1,
    kind: "workflow_network_call",
    executionEpoch: runContext.executionEpoch,
    step: { name: active.stepName, count: active.stepCount },
    attempt: active.attempt,
    phase: active.phase,
    ordinal,
    method: request.method,
    host: workflowRequestHost(request),
    status: "started",
    startedAt,
    httpStatus: null,
  };
  await persistArtifact(env, { path, value: started, outcome: "pending", attempt: active.attempt });
  let httpStatus = null;
  let response;
  try {
    response = await invoke((value) => { httpStatus = value.status; });
  } catch (error) {
    await persistArtifact(env, {
      path,
      value: { ...started, status: "failed", httpStatus, completedAt: workflowIsoNow(), durationMs: workflowNowMs() - t0 },
      outcome: "failure",
      attempt: active.attempt,
    });
    throw error;
  }
  const success = httpStatus >= 200 && httpStatus < 400;
  await persistArtifact(env, {
    path,
    value: { ...started, status: success ? "succeeded" : "failed", httpStatus, completedAt: workflowIsoNow(), durationMs: workflowNowMs() - t0 },
    outcome: success ? "success" : "failure",
    attempt: active.attempt,
  });
  return response;
}

function buildMcpProxy(env, runContext) {
  const bridge = env.__MCP_BRIDGE__;
  if (!bridge || typeof bridge.call !== "function") {
    throw createWorkflowError("MCP_BRIDGE_MISSING: tenant capability bridge is unavailable");
  }
  return createWorkflowProxy({}, {
    get(_t, namespace) {
      if (typeof namespace !== "string") return undefined;
      return createWorkflowProxy({}, {
        get(__t, method) {
          if (typeof method !== "string") return undefined;
          return (args) => {
            const active = workflowCallContext.getStore();
            if (!active || active.enabled !== true) {
              return rejectWorkflowPromise(new NonRetryableError(
                "MCP_OUTSIDE_STEP: env.MCP calls must run inside a step.do callback or rollback handler",
                "McpOutsideStepError",
              ));
            }
            const operation = (async () => {
              // Allocate before the first await so concurrent calls retain the
              // deterministic source-order ordinal for this attempt.
              const ordinal = active.nextOrdinal++;
              const workflow = {
                stepName: active.stepName,
                stepCount: active.stepCount,
                stepType: "do",
                attempt: active.attempt,
                phase: active.phase,
                ordinal,
              };
              const effectiveArgs = factoryWorkDefaults(namespace, method, args, runContext.factory);
              const requestJson = stringifyWorkflowJson(effectiveArgs);
              const requestArgs = parseWorkflowJson(requestJson);
              const requestDigest = await digestWorkflowHex(requestJson);
              if (active.continuationBinding && (ordinal !== 1 || namespace !== active.continuationBinding.namespace ||
                  method !== active.continuationBinding.method || requestDigest !== active.continuationBinding.requestDigest)) {
                throw new NonRetryableError("MCP_CONNECTION_RECOVERY_CALL_CHANGED: the pending operation changed");
              }
              const identity = await buildCallIdentity(
                runContext.runId,
                runContext.executionEpoch,
                namespace,
                method,
                workflow,
              );
              const path = "epochs/" + runContext.executionEpoch + "/steps/"
                + active.stepPathSegment + "/" + (active.nativeStepCount || active.stepCount)
                + "/attempts/" + active.attempt + "/calls/" + active.phase + "/" + ordinal + ".json";
              const t0 = workflowNowMs();
              const startedAt = workflowIsoNow();
              const started = {
                schemaVersion: 2,
                kind: "workflow_mcp_call",
                executionEpoch: runContext.executionEpoch,
                step: { id: identity.stepId, name: active.stepName, count: active.stepCount },
                attempt: active.attempt,
                phase: active.phase,
                ordinal,
                namespace,
                method,
                callId: identity.callId,
                idempotencyKey: identity.idempotencyKey,
                idempotency: {
                  key: identity.idempotencyKey,
                  requested: true,
                  providerConfirmation: "unknown",
                },
                status: "started",
                startedAt,
                // Bounded request snapshot: the decision-provenance surfaces
                // rationale, dashboard "What the AI was asked") read this back.
                request: active.sensitiveEvidence
                  ? redactedMcpEvidence()
                  : boundedEvidenceValue(requestArgs),
              };
              await persistArtifact(env, { path, value: started, outcome: "pending", attempt: active.attempt });
              let tediTaskReference;
              try {
                const bridgeResult = await observeRpcCall(bridge.call({
                  namespace,
                  method,
                  args: requestArgs,
                  workflow,
                  sensitiveOutput: active.sensitiveEvidence,
                  receiptStepCount: active.nativeStepCount || active.stepCount,
                  ...(active.continuationBinding ? { connectionBinding: active.continuationBinding.recovery } : {}),
                }), namespace + "." + method);
                if (bridgeResult && bridgeResult.__tedixConnectionRequired === true) {
                  const recovery = bridgeResult.recovery;
                  if (!recovery || typeof recovery.connectionInstanceId !== "string" ||
                    !/^[0-9a-f-]{36}$/i.test(recovery.connectionInstanceId) ||
                    (recovery.scope !== "tenant" && recovery.scope !== "user")) {
                    throw new NonRetryableError("MCP_CONNECTION_RECOVERY_INVALID: invalid pinned credential outcome");
                  }
                  const error = new NonRetryableError("MCP_CONNECTION_REQUIRED: reconnect the selected account");
                  if (active.phase === "run" && ordinal === 1 && active.nextOrdinal === 2 && !active.directNetworkStarted) {
                    active.connectionRequired = { error, recovery, namespace, method, requestDigest };
                  }
                  throw error;
                }
                if (bridgeResult && (bridgeResult.__tedixMcpResult === true || bridgeResult.__tedixMcpFailure === true)) {
                  tediTaskReference = bridgeResult.tediTaskReference;
                  if (bridgeResult.__tedixMcpFailure === true) throw createWorkflowError(bridgeResult.error.message);
                }
                const result = bridgeResult && bridgeResult.__tedixMcpResult === true ? bridgeResult.value : bridgeResult;
                const reportedFailure = workflowMcpCompletionFailure(result);
                if (reportedFailure) {
                  const message = "MCP_TOOL_REPORTED_FAILURE: " + namespace + "." + method
                    + " returned completionEvidence.status=" + reportedFailure.status
                    + ": " + sliceWorkflowString(workflowString(reportedFailure.detail), 0, 1000);
                  if (reportedFailure.nonRetryable) {
                    throw new NonRetryableError(message, "McpToolReportedFailure");
                  }
                  throw createWorkflowError(message);
                }
                const providerConfirmation = workflowMcpProviderConfirmation(result);
                await persistArtifact(env, {
                  path,
                  value: {
                    ...started,
                    idempotency: {
                      ...started.idempotency,
                      providerConfirmation,
                    },
                    status: "succeeded",
                    completedAt: workflowIsoNow(),
                    durationMs: workflowNowMs() - t0,
                    ...(!active.sensitiveEvidence && tediTaskReference ? { tediTaskReference } : {}),
                    // Bounded response snapshot — same evidence budget as request.
                    response: active.sensitiveEvidence
                      ? redactedMcpEvidence()
                      : boundedEvidenceValue(result),
                  },
                  outcome: "success",
                  attempt: active.attempt,
                });
                return result;
              } catch (error) {
                await persistArtifact(env, {
                  path,
                  value: {
                    ...started,
                    status: "failed",
                    completedAt: workflowIsoNow(),
                    durationMs: workflowNowMs() - t0,
                    ...(!active.sensitiveEvidence && tediTaskReference ? { tediTaskReference } : {}),
                    refused: testWorkflowRegex(new RegExp(${JSON.stringify(WORKFLOW_TOOL_REFUSAL_PATTERN)}, "i"), error && error.message ? workflowString(error.message) : workflowString(error)),
                    error: active.sensitiveEvidence
                      ? redactedErrorSnapshot()
                      : errorSnapshot(error),
                    retryable: !(error instanceof NonRetryableError) && !permanentBridgeError(error),
                  },
                  outcome: "failure",
                  attempt: active.attempt,
                });
                throw normalizeBridgeError(error);
              }
            })();
            return trackWorkflowOperation(active, operation);
          };
        }
      });
    }
  });
}

// env.EVIDENCE — the host-side grounding primitive.
//
// Same durable-step discipline as env.MCP: calls must run inside step.do (or a
// rollback), they are tracked so an unawaited call still fails its step, and the
// engine-owned step coordinates ride along so the platform can derive the MCP
// idempotency identity for the scrape.
//
// Nothing about the VERDICT crosses this boundary outbound. The tenant sends
// {url, quote} and {claims}; the platform sends back a label it computed and
// sealed itself. A workflow cannot author "verified: true", and cannot suppress
// a failing score — EVIDENCE.score() re-reads the sealed host-written records.
function buildEvidenceProxy(env, runContext) {
  const bridge = env.__EVIDENCE_BRIDGE__;
  const invoke = (method) => (args) => {
    if (!bridge || typeof bridge[method] !== "function") {
      return rejectWorkflowPromise(new NonRetryableError(
        "EVIDENCE_BRIDGE_MISSING: the platform grounding bridge is unavailable for this run",
        "EvidenceBridgeMissingError",
      ));
    }
    const active = workflowCallContext.getStore();
    if (!active || active.enabled !== true) {
      return rejectWorkflowPromise(new NonRetryableError(
        "EVIDENCE_OUTSIDE_STEP: env.EVIDENCE calls must run inside a step.do callback or rollback handler",
        "EvidenceOutsideStepError",
      ));
    }
    const operation = (async () => {
      const ordinal = active.nextOrdinal++;
      const workflow = {
        stepName: active.stepName,
        stepCount: active.stepCount,
        stepType: "do",
        attempt: active.attempt,
        phase: active.phase,
        ordinal,
      };
      try {
        // \`workflow\` is applied last: a tenant-supplied step context can never
        // shadow the engine's own coordinates.
        return await observeRpcCall(
          bridge[method]({ ...(args == null ? {} : args), workflow }),
          "evidence." + method,
        );
      } catch (error) {
        throw normalizeBridgeError(error);
      }
    })();
    return trackWorkflowOperation(active, operation);
  };
  // \`calibrate\` is judge-only: it runs the production entailment judge over
  // caller-supplied fixed passages and returns labels for scoring the JUDGE.
  // It writes no evidence/<id>.json records, so nothing it produces can be
  // read back by score() — calibration can never mint grounding.
  // cacheGet/cachePut memoize the discovery phase (public research), not verdicts:
  // verify()/score() still run host-side on whatever the cache returns, so a cache
  // can never mint grounding — it only saves the expensive, variance-prone re-gather.
  return { verify: invoke("verify"), score: invoke("score"), calibrate: invoke("calibrate"), cacheGet: invoke("cacheGet"), cachePut: invoke("cachePut") };
}

// env.REASON — ephemeral, memory-free reasoners for fan-out.
//
// Same durable-step discipline as env.MCP and env.EVIDENCE: calls must run
// inside step.do (or a rollback), they are tracked so an unawaited call still
// fails its step, and the engine's own step coordinates are applied last so
// tenant args can never shadow them.
//
// Each call becomes one lean workflow-synthesis session, which the tedi runtime
// serves from a per-session tool-free facet — so \`Promise.all\` over N asks
// really is N independent reasoners, none of which read or write the tedi's
// memory. The BUDGET lives on the host props (manifest-derived), not here:
// tenant code must not be able to raise its own ceiling.
//
// Reasoning is not grounding. This returns text; a claim only becomes supported
// through env.EVIDENCE, which re-reads host-sealed records. A confident fan-out
// is still not evidence.
function buildReasonProxy(env, runContext) {
  const bridge = env.__REASON_BRIDGE__;
  return {
    ask: (args) => {
      if (!bridge || typeof bridge.ask !== "function") {
        return rejectWorkflowPromise(new NonRetryableError(
          "REASON_NOT_DECLARED: declare \`capabilities.reason\` in SKILL.md to use env.REASON",
          "ReasonNotDeclaredError",
        ));
      }
      const active = workflowCallContext.getStore();
      if (!active || active.enabled !== true) {
        return rejectWorkflowPromise(new NonRetryableError(
          "REASON_OUTSIDE_STEP: env.REASON calls must run inside a step.do callback or rollback handler",
          "ReasonOutsideStepError",
        ));
      }
      const operation = (async () => {
        const ordinal = active.nextOrdinal++;
        const workflow = {
          stepName: active.stepName,
          stepCount: active.stepCount,
          stepType: "do",
          attempt: active.attempt,
          phase: active.phase,
          ordinal,
        };
        try {
          return await observeRpcCall(
            bridge.ask({ ...(args == null ? {} : args), workflow }),
            "reason.ask",
          );
        } catch (error) {
          throw normalizeBridgeError(error);
        }
      })();
      return trackWorkflowOperation(active, operation);
    },
  };
}

`;
