export const RUNNER_STEPS_SOURCE = `function configSnapshot(config) {
  if (config == null) return {};
  try {
    return parseWorkflowJson(stringifyWorkflowJson(config, (_key, value) =>
      typeof value === "function" ? "[dynamic function]" : value));
  } catch {
    return { uninspectable: true };
  }
}

function attemptPath(executionEpoch, stepPathSegment, stepCount, attempt) {
  return "epochs/" + executionEpoch + "/steps/" + stepPathSegment + "/" + stepCount
    + "/attempts/" + attempt + ".json";
}

function wrapStep(step, env, timeline, runContext) {
  const wrapped = {};
  const invocationCounts = createWorkflowMap();
  const nextInvocationCount = (kind, name) => {
    const key = kind + ":" + name;
    const count = (getWorkflowMapValue(invocationCounts, key) || 0) + 1;
    setWorkflowMapValue(invocationCounts, key, count);
    return count;
  };
  for (const k of workflowOwnKeys(step)) {
    const orig = step[k];
    wrapped[k] = typeof orig === "function" ? bindWorkflowFunction(orig, step) : orig;
  }
  wrapped.do = async (name, configOrFn, fnOrRollback, maybeRollback) => {
	const encodedStepName = encodeWorkflowPathSegment(name);
    const hasConfig = typeof configOrFn !== "function";
    const config = hasConfig ? configOrFn : undefined;
	const declaredSensitiveOutput = workflowBoolean(
		config && config.sensitive === "output",
	);
    const fn = hasConfig ? fnOrRollback : configOrFn;
    const rollbackOptions = hasConfig ? maybeRollback : fnOrRollback;
    if (typeof fn !== "function") {
      throw createWorkflowTypeError("step.do requires a callback");
    }
    let lastFailure = null;
    let logicalCount = null;
    let recoveryRound = 0;
    let continuationBinding = null;
    let activeContext = null;
    const callback = async (ctx) => {
      logicalCount = logicalCount || ctx.step.count;
      const stepId = await buildStepId(
        runContext.runId,
        runContext.executionEpoch,
        "do",
        ctx.step.name,
        ctx.step.count,
      );
      const path = attemptPath(runContext.executionEpoch, encodedStepName, ctx.step.count, ctx.attempt);
      const startedAt = workflowIsoNow();
      const t0 = workflowNowMs();
      // Prefer the author-supplied config: Cloudflare may omit sensitivity from
      // resolved ctx.config even when it honors the storage behavior. Keeping
      // both checks makes Tedix evidence fail closed if the runtime shape drifts.
      const sensitiveOutput = workflowBoolean(
		declaredSensitiveOutput ||
        (ctx.config && ctx.config.sensitive === "output"),
      );
      const started = {
        schemaVersion: 1,
        kind: "workflow_step_attempt",
        executionEpoch: runContext.executionEpoch,
        step: { id: stepId, name: ctx.step.name, count: ctx.step.count, type: "do" },
        attempt: ctx.attempt,
        config: configSnapshot(ctx.config),
        status: "started",
        startedAt,
        sensitiveOutput,
      };
      timeline.push({
        kind: "step.do",
        name: ctx.step.name,
        count: ctx.step.count,
        attempt: ctx.attempt,
        config: started.config,
        outcome: "started",
      });
      await allWorkflowPromises([
        persistArtifact(env, { path, value: started, outcome: "pending", attempt: ctx.attempt }),
        persistArtifact(env, { path: "timeline.json", value: timeline.snapshot() }),
      ]);
      try {
        activeContext = {
          stepName: ctx.step.name,
          stepCount: logicalCount,
          nativeStepCount: ctx.step.count,
          continuationBinding,
          attempt: ctx.attempt,
          phase: "run",
          stepPathSegment: encodedStepName,
          sensitiveEvidence: sensitiveOutput,
          nextOrdinal: 1,
          pendingOperations: createWorkflowOperationSet(),
          enabled: true,
        };
        const logicalContext = { ...ctx, step: { ...ctx.step, count: logicalCount } };
        const value = await runWithWorkflowCallContext(activeContext, () => fn(logicalContext));
        if (value && value.__tedixPendingConnection) {
          throw new NonRetryableError("WORKFLOW_RESERVED_RESULT: reserved connection recovery output");
        }
        const durationMs = workflowNowMs() - t0;
        const media = sensitiveOutput ? null : stepMediaArtifact(value, encodedStepName);
        const output = sensitiveOutput
          ? { redacted: true, reason: "workflow_step_sensitive_output" }
          : mediaOutputEvidence(value, media);
        timeline.push({
          kind: "step.do",
          name: ctx.step.name,
          count: ctx.step.count,
          attempt: ctx.attempt,
          outcome: "success",
          durationMs,
          sensitiveOutput,
        });
        await allWorkflowPromises([
          persistArtifact(env, {
            path,
            value: {
              ...started,
              status: "succeeded",
              completedAt: workflowIsoNow(),
              durationMs,
              outputArtifactPath: "outputs/" + encodedStepName + ".json",
              ...(sensitiveOutput ? { output } : {}),
            },
            outcome: "success",
            attempt: ctx.attempt,
          }),
          persistArtifact(env, { path: "timeline.json", value: timeline.snapshot() }),
          persistArtifact(env, {
            path: "outputs/" + encodedStepName + ".json",
            value: {
              value: output,
              durationMs,
              stepCount: ctx.step.count,
              attempt: ctx.attempt,
              sensitiveOutput,
            },
            outcome: "success",
            attempt: ctx.attempt,
          }),
        ]);
        return value;
      } catch (error) {
        if (activeContext && activeContext.connectionRequired &&
            error === activeContext.connectionRequired.error &&
            activeContext.nextOrdinal === 2 && !activeContext.directNetworkStarted) {
          return {
            __tedixPendingConnection: true,
            recovery: activeContext.connectionRequired.recovery,
            namespace: activeContext.connectionRequired.namespace,
            method: activeContext.connectionRequired.method,
            requestDigest: activeContext.connectionRequired.requestDigest,
            logicalCount,
          };
        }
        const durationMs = workflowNowMs() - t0;
		const failure = sensitiveOutput
			? redactedErrorSnapshot()
			: errorSnapshot(error);
        const retryable = !(error instanceof NonRetryableError);
        lastFailure = { error: failure, durationMs, attempt: ctx.attempt, count: ctx.step.count, retryable };
        timeline.push({
          kind: "step.do",
          name: ctx.step.name,
          count: ctx.step.count,
          attempt: ctx.attempt,
          outcome: "failure",
          durationMs,
          error: failure,
        });
        await allWorkflowPromises([
          persistArtifact(env, {
            path,
            value: {
              ...started,
              status: "failed",
              completedAt: workflowIsoNow(),
              durationMs,
              error: failure,
              retryable,
            },
            outcome: "failure",
            attempt: ctx.attempt,
          }),
          persistArtifact(env, { path: "timeline.json", value: timeline.snapshot() }),
        ]);
		throw sensitiveOutput ? createSensitiveWorkflowError(error) : error;
      }
    };

    let wrappedRollback;
    if (rollbackOptions && typeof rollbackOptions.rollback === "function") {
      wrappedRollback = {
        ...rollbackOptions,
        rollback: async (rollbackContext) => {
          // A pending credential step never executed a provider operation.
          if (rollbackContext.output && rollbackContext.output.__tedixPendingConnection === true) return;
          const ctx = rollbackContext.ctx;
          const stepId = await buildStepId(
            runContext.runId,
            runContext.executionEpoch,
            "do",
            ctx.step.name,
            ctx.step.count,
          );
          const attemptRecordPath = attemptPath(
            runContext.executionEpoch,
            encodedStepName,
            ctx.step.count,
            ctx.attempt,
          );
          // attemptPath() always returns a platform-owned JSON path. Slice
          // that fixed suffix with the captured String intrinsic instead of
          // RegExp replacement, whose Symbol.replace hook tenant code could
          // mutate after module evaluation.
          const path = sliceWorkflowString(attemptRecordPath, 0, -5) + "/rollback.json";
          const startedAt = workflowIsoNow();
          const t0 = workflowNowMs();
          const started = {
            schemaVersion: 1,
            kind: "workflow_step_rollback",
            executionEpoch: runContext.executionEpoch,
            step: { id: stepId, name: ctx.step.name, count: ctx.step.count, type: "do" },
            attempt: ctx.attempt,
            config: configSnapshot(rollbackOptions.rollbackConfig),
            status: "started",
            startedAt,
			sensitiveOutput: declaredSensitiveOutput,
          };
          timeline.push({
            kind: "step.rollback",
            name: ctx.step.name,
            count: ctx.step.count,
            attempt: ctx.attempt,
            outcome: "started",
          });
          await allWorkflowPromises([
            persistArtifact(env, { path, value: started, outcome: "pending", attempt: ctx.attempt }),
            persistArtifact(env, { path: "timeline.json", value: timeline.snapshot() }),
          ]);
          try {
            const activeContext = {
              stepName: ctx.step.name,
              stepCount: ctx.step.count,
              attempt: ctx.attempt,
              phase: "rollback",
              stepPathSegment: encodedStepName,
              sensitiveEvidence: declaredSensitiveOutput,
              nextOrdinal: 1,
              pendingOperations: createWorkflowOperationSet(),
              enabled: true,
            };
            await runWithWorkflowCallContext(activeContext, () => rollbackOptions.rollback(rollbackContext));
            const durationMs = workflowNowMs() - t0;
            timeline.push({
              kind: "step.rollback",
              name: ctx.step.name,
              count: ctx.step.count,
              attempt: ctx.attempt,
              outcome: "success",
              durationMs,
            });
            await allWorkflowPromises([
              persistArtifact(env, {
                path,
                value: {
                  ...started,
                  status: "succeeded",
                  completedAt: workflowIsoNow(),
                  durationMs,
                },
                outcome: "success",
                attempt: ctx.attempt,
              }),
              persistArtifact(env, { path: "timeline.json", value: timeline.snapshot() }),
            ]);
          } catch (error) {
            const durationMs = workflowNowMs() - t0;
			const failure = declaredSensitiveOutput
				? redactedErrorSnapshot()
				: errorSnapshot(error);
            timeline.push({
              kind: "step.rollback",
              name: ctx.step.name,
              count: ctx.step.count,
              attempt: ctx.attempt,
              outcome: "failure",
              durationMs,
              error: failure,
            });
            await allWorkflowPromises([
              persistArtifact(env, {
                path,
                value: {
                  ...started,
                  status: "failed",
                  completedAt: workflowIsoNow(),
                  durationMs,
                  error: failure,
                  retryable: !(error instanceof NonRetryableError),
                },
                outcome: "failure",
                attempt: ctx.attempt,
              }),
              persistArtifact(env, { path: "timeline.json", value: timeline.snapshot() }),
            ]);
			throw declaredSensitiveOutput
				? createSensitiveWorkflowError(error)
				: error;
          }
        },
      };
    }

    try {
      let value;
      while (true) {
        if (hasConfig) {
          value = wrappedRollback
            ? await step.do(name, config, callback, wrappedRollback)
            : await step.do(name, config, callback);
        } else {
          value = wrappedRollback
            ? await step.do(name, callback, wrappedRollback)
            : await step.do(name, callback);
        }
        if (!value || value.__tedixPendingConnection !== true) break;
        logicalCount = value.logicalCount;
        continuationBinding = { namespace: value.namespace, method: value.method, requestDigest: value.requestDigest, recovery: value.recovery };
        if (++recoveryRound > 3) throw new NonRetryableError("MCP_CONNECTION_RECOVERY_LIMIT: reconnect attempts exhausted");
        const digest = await digestWorkflowHex(frameWorkflowIdentity([runContext.runId, runContext.executionEpoch, name, logicalCount, recoveryRound]));
        const eventType = "connection_recovery_" + sliceWorkflowString(digest, 0, 24);
        const recoveryPath = "epochs/" + runContext.executionEpoch + "/controls/" + eventType + ".json";
        const pending = {
          schemaVersion: 1, status: "waiting", eventType,
          executionEpoch: runContext.executionEpoch,
          stepName: name, logicalCount,
          namespace: value.namespace, method: value.method,
          requestDigest: value.requestDigest,
          recovery: value.recovery,
        };
        await persistConnectionControl(env, { path: recoveryPath, value: pending, outcome: "pending" });
        const answer = await wrapped.waitForEvent("Reconnect " + name + " " + recoveryRound, { type: eventType, timeout: "24 hours", connectionRecovery: pending });
        if (!answer || !answer.payload || answer.payload.connectionVerified !== true || answer.payload.eventType !== eventType) {
          throw new NonRetryableError("MCP_CONNECTION_RECOVERY_UNVERIFIED: connection continuation was not verified");
        }
        await persistConnectionControl(env, { path: recoveryPath, value: { ...pending, status: "resolved" }, outcome: "success" });
      }
      const media = declaredSensitiveOutput ? null : stepMediaArtifact(value, encodedStepName);
      if (media) await persistStepMediaArtifact(env, media);
      return value;
    } catch (error) {
      const failure = lastFailure || {
		error: declaredSensitiveOutput
			? redactedErrorSnapshot()
			: errorSnapshot(error),
        durationMs: undefined,
        retryable: !(error instanceof NonRetryableError),
      };
      await persistArtifact(env, {
        path: "outputs/" + encodedStepName + ".error.json",
        value: {
          error: failure.error,
          durationMs: failure.durationMs,
          stepCount: failure.count,
          attempt: failure.attempt,
          retryable: failure.retryable,
        },
        outcome: "failure",
        attempt: failure.attempt,
      });
      await persistRationale(env, {
        gate: "step_do_failure",
        stepName: name,
        error: failure.error,
        durationMs: failure.durationMs,
        attempt: failure.attempt,
        stepCount: failure.count,
        retryable: failure.retryable,
      });
		throw declaredSensitiveOutput
			? createSensitiveWorkflowError(error)
			: error;
    }
  };
  wrapped.sleep = async (name, duration) => {
    const count = nextInvocationCount("sleep", name);
    const stepId = await buildStepId(runContext.runId, runContext.executionEpoch, "sleep", name, count);
    const path = "epochs/" + runContext.executionEpoch + "/steps/" + encodeWorkflowPathSegment(name) + "/" + count + "/sleep.json";
    const startedAt = workflowIsoNow();
    const record = {
      schemaVersion: 1,
      kind: "workflow_step_sleep",
      executionEpoch: runContext.executionEpoch,
      step: { id: stepId, name, count, type: "sleep" },
      status: "sleeping",
      duration,
      startedAt,
    };
    timeline.push({ kind: "step.sleep", name, count, duration });
    await allWorkflowPromises([
      persistArtifact(env, { path, value: record, outcome: "pending" }),
      persistArtifact(env, { path: "timeline.json", value: timeline.snapshot() }),
    ]);
    try {
      await step.sleep(name, duration);
      await persistArtifact(env, {
        path,
        value: { ...record, status: "resolved", resolvedAt: workflowIsoNow() },
        outcome: "success",
      });
    } catch (error) {
      await persistArtifact(env, {
        path,
        value: {
          ...record,
          status: "failed",
          completedAt: workflowIsoNow(),
          error: errorSnapshot(error),
        },
        outcome: "failure",
      });
      throw error;
    }
  };
  wrapped.sleepUntil = async (name, timestamp) => {
    const count = nextInvocationCount("sleepUntil", name);
    const stepId = await buildStepId(runContext.runId, runContext.executionEpoch, "sleepUntil", name, count);
    const path = "epochs/" + runContext.executionEpoch + "/steps/" + encodeWorkflowPathSegment(name) + "/" + count + "/sleepUntil.json";
    const wakeAt = workflowTimestampValue(timestamp);
    const record = {
      schemaVersion: 1,
      kind: "workflow_step_sleep_until",
      executionEpoch: runContext.executionEpoch,
      step: { id: stepId, name, count, type: "sleepUntil" },
      status: "sleeping",
      wakeAt,
      startedAt: workflowIsoNow(),
    };
    timeline.push({
      kind: "step.sleepUntil",
      name,
      count,
      timestamp: wakeAt,
    });
    await allWorkflowPromises([
      persistArtifact(env, { path, value: record, outcome: "pending" }),
      persistArtifact(env, { path: "timeline.json", value: timeline.snapshot() }),
    ]);
    try {
      await step.sleepUntil(name, timestamp);
      await persistArtifact(env, {
        path,
        value: { ...record, status: "resolved", resolvedAt: workflowIsoNow() },
        outcome: "success",
      });
    } catch (error) {
      await persistArtifact(env, {
        path,
        value: {
          ...record,
          status: "failed",
          completedAt: workflowIsoNow(),
          error: errorSnapshot(error),
        },
        outcome: "failure",
      });
      throw error;
    }
  };
  wrapped.waitForEvent = async (name, opts) => {
    const eventType = opts && opts.type;
    if (typeof eventType !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(eventType)) {
      throw new TypeError("WORKFLOW_INVALID_EVENT_TYPE: event type must use 1-100 letters, digits, hyphens, or underscores");
    }
    const count = nextInvocationCount("waitForEvent", name);
    const stepId = await buildStepId(runContext.runId, runContext.executionEpoch, "waitForEvent", name, count);
    const path = "epochs/" + runContext.executionEpoch + "/steps/" + encodeWorkflowPathSegment(name) + "/" + count + "/waitForEvent.json";
    const record = {
      schemaVersion: 1,
      kind: "workflow_step_wait_for_event",
      executionEpoch: runContext.executionEpoch,
      step: { id: stepId, name, count, type: "waitForEvent" },
      status: "waiting",
      eventType,
      timeout: opts && opts.timeout,
      waitingAt: workflowIsoNow(),
      ...(opts.connectionRecovery ? { connectionRecovery: opts.connectionRecovery } : {}),
    };
    timeline.push({ kind: "step.waitForEvent", name, count, type: eventType, status: "waiting" });
    await allWorkflowPromises([
      persistArtifact(env, { path, value: record, outcome: "pending" }),
      persistArtifact(env, { path: "timeline.json", value: timeline.snapshot() }),
    ]);
    // G — pause gate (gate 2a). Long-lived rationale, intentionally left
    // open (no outcomeStatus) so it stays visible in the timeline as
    // "waiting on X". Resume emits its own success record.
    await persistRationale(env, {
      gate: "wait_for_event_pause",
      stepName: name,
      stepCount: count,
      eventType,
      timeout: opts && opts.timeout,
    });
    let result;
    try {
      result = await step.waitForEvent(name, { type: opts.type, ...(opts.timeout ? { timeout: opts.timeout } : {}) });
    } catch (error) {
      await persistArtifact(env, {
        path,
        value: {
          ...record,
          status: "failed",
          completedAt: workflowIsoNow(),
          error: errorSnapshot(error),
        },
        outcome: "failure",
      });
      throw error;
    }
    const sensitivePayload = result && result.sensitive === "output";
    timeline.push({
      kind: "step.waitForEvent",
      name,
      count,
      type: opts && opts.type,
      status: "resolved",
      payload: sensitivePayload
        ? { redacted: true, reason: "workflow_event_sensitive_output" }
        : result && result.payload,
    });
    await allWorkflowPromises([
      persistArtifact(env, {
        path,
        value: {
          ...record,
          status: "resolved",
          resolvedAt: workflowIsoNow(),
          eventTimestamp: result && result.timestamp,
          sensitivePayload,
        },
        outcome: "success",
      }),
      persistArtifact(env, { path: "timeline.json", value: timeline.snapshot() }),
    ]);
    // G — resume gate (gate 2b).
    await persistRationale(env, {
      gate: "wait_for_event_resume",
      stepName: name,
      stepCount: count,
      eventType: opts && opts.type,
      payload: sensitivePayload ? { redacted: true } : result && result.payload,
    });
	    const eventSnapshot = result && typeof result === "object"
	      ? {
	          payload: result.payload,
	          timestamp: result.timestamp,
	          type: result.type,
	        }
	      : result;
	    disposeRpcValue(result);
	    return eventSnapshot;
  };
  return wrapped;
}

`;
