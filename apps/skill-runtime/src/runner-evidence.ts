export const RUNNER_EVIDENCE_SOURCE = `// Operational receipts are required. Optional display artifacts remain best-effort.
function persistArtifact(env, payload) {
  const required = payload && (testWorkflowRegex(/^timeline\\//, payload.path) ||
    (payload.value && testWorkflowRegex(/^workflow_(?:step_|mcp_call$|network_call$)/, payload.value.kind)));
  if (required) {
    if (!env.__ARTIFACT_BRIDGE__ || typeof env.__ARTIFACT_BRIDGE__.record !== "function") {
      return rejectWorkflowPromise(createWorkflowError("WORKFLOW_TIMELINE_STORE_UNAVAILABLE"));
    }
    return observeRpcCall(env.__ARTIFACT_BRIDGE__.record(payload), "timeline.record:" + payload.path);
  }
  if (!env.__ARTIFACT_BRIDGE__ || typeof env.__ARTIFACT_BRIDGE__.record !== "function") return resolveWorkflowPromise();
  return thenWorkflowPromise(
    observeRpcCall(env.__ARTIFACT_BRIDGE__.record(payload), "artifact.record:" + (payload && payload.path ? payload.path : "unknown")),
    undefined,
    (e) => warnWorkflow("artifact_record threw", e && e.message),
  );
}

function persistArtifactOnce(env, payload) {
  if (!env.__ARTIFACT_BRIDGE__ || typeof env.__ARTIFACT_BRIDGE__.recordOnce !== "function") return resolveWorkflowPromise();
  return thenWorkflowPromise(
    observeRpcCall(env.__ARTIFACT_BRIDGE__.recordOnce(payload), "artifact.recordOnce:" + (payload && payload.path ? payload.path : "unknown")),
    undefined,
    (e) => warnWorkflow("artifact_record_once threw", e && e.message),
  );
}

function stepMediaArtifact(value, encodedStepName) {
  if (!value || typeof value !== "object") return null;
  const base64 = typeof value.imageBase64 === "string"
    ? value.imageBase64
    : typeof value.bytesBase64Encoded === "string"
      ? value.bytesBase64Encoded
      : null;
  const mimeType = typeof value.mimeType === "string" ? value.mimeType : null;
  if (!base64 || !mimeType || !matchWorkflowString(mimeType, /^(?:audio|image|video)\\//)) return null;
  return { path: "outputs/" + encodedStepName + ".media", base64, mimeType };
}

function mediaOutputEvidence(value, media) {
  if (!media) return value;
  return {
    ok: value.ok,
    status: value.status,
    mimeType: media.mimeType,
    bytes: value.bytes,
    artifactPath: media.path,
  };
}

async function persistStepMediaArtifact(env, media) {
  if (!env.__ARTIFACT_BRIDGE__ || typeof env.__ARTIFACT_BRIDGE__.writeBlob !== "function") {
    throw createWorkflowError("ARTIFACT_MEDIA_STORE_UNAVAILABLE: cannot preserve generated media");
  }
  await observeRpcCall(env.__ARTIFACT_BRIDGE__.writeBlob(media), "artifact.writeBlob:" + media.path);
}

// Reconnect admission reads this receipt; unlike display evidence it must be
// durably stored before a native wait or continuation can begin.
async function persistConnectionControl(env, payload) {
  if (!env.__ARTIFACT_BRIDGE__ || typeof env.__ARTIFACT_BRIDGE__.record !== "function") {
    throw new NonRetryableError("MCP_CONNECTION_RECOVERY_STORE_UNAVAILABLE: cannot preserve pending operation");
  }
  await observeRpcCall(env.__ARTIFACT_BRIDGE__.record(payload), "connection.control");
}

// G — Rationale emission. Same best-effort semantics. Honors the manifest's
// capabilities.rationale.mode flag (off | important | all, default important).
// Important = dispatch + waitForEvent gates + step.do failures. "all" is
// reserved for future per-step records.
function persistRationale(env, payload) {
  if (!env.__RATIONALE_BRIDGE__ || typeof env.__RATIONALE_BRIDGE__.record !== "function") return resolveWorkflowPromise();
  return thenWorkflowPromise(
    observeRpcCall(env.__RATIONALE_BRIDGE__.record(payload), "rationale.record:" + (payload && payload.gate ? payload.gate : "unknown")),
    undefined,
    (e) => warnWorkflow("rationale_record threw", e && e.message),
  );
}

// Single shared timeline record (Option 1 — snapshot, not append-only).
// Each step.do/sleep/waitForEvent appends to this in-memory array, then
// the wrapper fires a fresh artifact write each time. The (run_id, path)
// unique index upserts so engine retries don't duplicate.
function makeTimeline() {
  const events = [];
  return {
    push(ev) { pushWorkflowArray(events, { ...ev, ts: workflowIsoNow() }); },
    snapshot() { return { events }; },
  };
}

function workflowEventSnapshot(event) {
  if (!event || typeof event !== "object") return event == null ? null : event;
  // dynamic-workflows 0.1.1 currently forwards a reduced envelope. Preserve
  // public WorkflowEvent fields when a future version supplies them; never
  // infer or reconstruct the package's private dispatcher envelope.
  return {
    payload: event.payload,
    timestamp: event.timestamp,
    instanceId: event.instanceId,
    workflowName: event.workflowName,
    schedule: event.schedule,
  };
}

`;
