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
import type { CapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { parse as parseModuleSyntax } from "es-module-lexer/js";
import { transform } from "sucrase";
import type { ArtifactBridge } from "./artifacts";
import type { EvidenceBridge, EvidenceBridgeProps } from "./evidence";
import { PLATFORM_EVIDENCE_MANIFEST } from "./evidence-core";
import type { ReasonBridge } from "./reason";
import {
	PLATFORM_REASON_MANIFEST,
	type ReasonBridgeProps,
	resolveReasonBudget,
} from "./reason-core";
import type { McpBridge, McpBridgeProps } from "./mcp-bridge";
import type { RationaleBridge } from "./rationale";

export interface LoadSkillRuntimeInput {
	skillId: string;
	/** Human-readable slug from skill_entries (used in rationale evidence
	 *  and Tedix OS timeline labels). */
	skillSlug?: string | null;
	tediId: string;
	/** Owning organization's Code Mode aggregate app slug. */
	aggregateMcpSlug: string;
	/** Owning tedi's configured namespace within that aggregate. */
	tediNamespace?: string | null;
	orgId: string;
	runId: string;
	executionEpoch: number;
	admittedAt: string;
	/**
	 * Run-starter provenance from the admission row:
	 * "user:<descopeUserId>" for operator-started runs, "agent:"/"tedi:"/auth
	 * class otherwise. Rides the bridge headers so the gateway can attest
	 * operator consent on tedi-bound calls; tenant code never sees or sets it.
	 */
	createdBy?: string | null;
	/** Work Item pinned at admission and inherited by every MCP call. */
	workItemId?: string | null;
	/**
	 * SHA-256 of every non-secret input that affects the Loader callback's
	 * WorkerCode/config. Cloudflare requires one Loader id to resolve to the
	 * same config forever; changing this hash deliberately selects a new id.
	 */
	loaderConfigHash: string;
	/** Source of the tenant's `scripts/workflow.ts`. */
	code: string;
	manifest: CapabilityManifest;
	/** Provenance derived from the authoritative run-pinned snapshot. */
	provenance: {
		source: {
			workflowSha256: string;
			skillDocSha256: string;
			skillRevision: number | null;
			skillSlug: string | null;
		};
		runtime: {
			workerVersionId: string;
			workerVersionTag: string;
			workerVersionTimestamp: string;
			executionCompatibilityHash: string;
			dispatchShimVersion: string;
			compatibilityDate: string;
			dynamicWorkflowsVersion: string;
			loaderConfigHash: string;
			tenantCpuMs: number;
			tenantSubRequests: number;
		};
	};
	/**
	 * Map from manifest namespace (what the tenant types — e.g. `peec`)
	 * to the real apps/mcp slug (e.g. `peec-tedix`). Resolved by the
	 * factory at workflow-boot time so the dispatch shim has zero-cost
	 * lookups per call. If a namespace has no entry, the dispatch shim
	 * falls back to the namespace itself with `_` → `-` mapping.
	 */
	namespaceToSlug?: Record<string, string>;
	/**
	 * Namespace→slug routing for the PLATFORM's evidence scrape. Resolved
	 * separately from the tenant map so grounding never depends on (and never
	 * widens) what the skill happens to declare.
	 */
	evidenceNamespaceToSlug?: Record<string, string>;
}

export function buildTenantRunContext(
	input: Pick<
		LoadSkillRuntimeInput,
		| "skillId"
		| "skillSlug"
		| "tediId"
		| "orgId"
		| "runId"
		| "executionEpoch"
		| "admittedAt"
		| "workItemId"
		| "manifest"
		| "namespaceToSlug"
		| "provenance"
	>,
) {
	return {
		skillId: input.skillId,
		skillSlug: input.skillSlug ?? null,
		tediId: input.tediId,
		orgId: input.orgId,
		runId: input.runId,
		executionEpoch: input.executionEpoch,
		admittedAt: input.admittedAt,
		workItemId: input.workItemId ?? null,
		capabilityManifest: input.manifest,
		namespaceToSlug: input.namespaceToSlug ?? {},
		provenance: input.provenance,
	};
}

export interface SkillRuntimeEnv {
	LOADER: WorkerLoader;
	PLATFORM_SERVICE_TOKEN: string;
	MCP_URL?: string;
	/**
	 * Platform-global Gemini key, injected into `network: true` skill
	 * workflows' outbound requests by {@link SkillRuntimeExportFactories.OutboundProxy}.
	 * Optional so a missing secret never blocks dispatch — the proxy simply
	 * forwards uncredentialed and Gemini returns its own auth error.
	 */
	GEMINI_API_KEY?: string;
	/** Service-account JSON used by the outbound proxy for Vertex OAuth. */
	GOOGLE_SERVICE_ACCOUNT_KEY?: string;
	/** Vertex model collection endpoint used by the media import bridge. */
	VERTEX_VIDEO_ENDPOINT?: string;
	/** Tenant-owned video asset storage; access remains restricted to the proxy. */
	VIDEO_BUCKET: R2Bucket;
}

export interface SkillRuntimeExportFactories {
	McpBridge(opts: { props: McpBridgeProps }): Fetcher<McpBridge>;
	ArtifactBridge(opts: { props: { runId: string } }): Fetcher<ArtifactBridge>;
	EvidenceBridge(opts: { props: EvidenceBridgeProps }): Fetcher<EvidenceBridge>;
	ReasonBridge(opts: { props: ReasonBridgeProps }): Fetcher<ReasonBridge>;
	RationaleBridge(opts: {
		props: {
			runId: string;
			skillId: string;
			skillSlug: string | null;
			tediId: string;
			orgId: string;
			rationaleMode: CapabilityManifest["rationale"]["mode"];
			executionEpoch: number;
			serviceToken: string;
		};
	}): Fetcher<RationaleBridge>;
	OutboundProxy(opts: {
		props: {
			geminiApiKey?: string | null;
			googleServiceAccountKey?: string | null;
			organizationId?: string | null;
			vertexVideoEndpoint?: string | null;
		};
	}): Fetcher;
}

export const COMPATIBILITY_DATE = "2026-06-11";
export const DYNAMIC_WORKFLOWS_VERSION = "0.1.1";
export const TENANT_WORKER_LIMITS = {
	cpuMs: 60_000,
	subRequests: 1_000,
} as const;
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

/**
 * Shared call context for the injected dispatch and network-gate modules.
 * One module instance is loaded per tenant isolate, so both MCP and fetch
 * consult the exact same active native step/rollback context.
 */
export const WORKFLOW_CONTEXT_MODULE = `import { AsyncLocalStorage } from "node:async_hooks";
export const workflowCallContext = new AsyncLocalStorage();
`;

/** Exact gate implementation embedded in the loaded Worker's network module. */
export const WORKFLOW_FETCH_GATE_FACTORY_SOURCE = `function createWorkflowFetchGate(getActiveContext, platformFetch, createBlockedError, createOperation, trackOperation, rejectOperation, prepareRequestArgs = (args) => args, validateResponse = (response) => response) {
  return function workflowStepFetchGate(...args) {
    const active = getActiveContext();
    if (!active || active.enabled !== true || !active.pendingOperations || typeof active.pendingOperations.add !== "function" || (active.phase !== "run" && active.phase !== "rollback")) {
      return rejectOperation(createBlockedError());
    }
    return trackOperation(active, createOperation(async () => {
      const requestArgs = prepareRequestArgs(args);
      const response = await platformFetch(...requestArgs);
      return validateResponse(response);
    }));
  };
}`;

export const SENSITIVE_WORKFLOW_ERROR_FACTORY_SOURCE = `function createSensitiveWorkflowError(error) {
  const message = "WORKFLOW_SENSITIVE_ERROR_REDACTED: sensitive workflow step failed";
  const nonRetryable = error instanceof NonRetryableError;
  const sanitized = nonRetryable
    ? new NonRetryableError(message)
    : createWorkflowError(message);
  if (!nonRetryable) {
    apply(nativeDefineProperty, NativeObject, [sanitized, "name", {
      value: "SensitiveWorkflowStepError",
      configurable: true,
    }]);
  }
  apply(nativeDefineProperty, NativeObject, [sanitized, "code", {
    value: "WORKFLOW_SENSITIVE_ERROR_REDACTED",
    configurable: true,
  }]);
  return sanitized;
}`;

/**
 * Install the step-context gate before any tenant module body statements run.
 * OutboundProxy remains the actual outbound/credential policy; this gate only
 * enforces the durable execution boundary.
 */
export const WORKFLOW_FETCH_GATE_MODULE = `import { NonRetryableError } from "cloudflare:workflows";
import { workflowCallContext } from "./workflow-context.js";

// Capture authority-sensitive intrinsics before tenant module evaluation. The
// tenant may mutate globals in its module body, but every platform operation
// continues through these pristine references.
const NativePromise = Promise;
const NativeArray = Array;
const NativeObject = Object;
const NativeReflect = Reflect;
const NativeJson = JSON;
const NativeFunction = Function;
const NativeRegExp = RegExp;
const NativeError = Error;
const NativeTypeError = TypeError;
const NativeSymbol = Symbol;
const NativeHeaders = Headers;
const NativeRequest = Request;
const NativeResponse = Response;
const NativeReadableStream = ReadableStream;
const NativeReadableStreamDefaultReader = ReadableStreamDefaultReader;
const NativeWebSocket = globalThis.WebSocket;
const NativeWebSocketPair = globalThis.WebSocketPair;
const NativeEventSource = globalThis.EventSource;
const NativeNavigator = globalThis.navigator;
const NativeSet = Set;
const NativeMap = Map;
const NativeProxy = Proxy;
const NativeDate = Date;
const NativeTextEncoder = TextEncoder;
const NativeString = String;
const NativeBoolean = Boolean;
const NativeNumber = Number;
const NativeUint8Array = Uint8Array;
const nativeApply = Reflect.apply;
const nativeOwnKeys = Reflect.ownKeys;
const nativeBind = Function.prototype.bind;
const nativePromiseResolve = NativePromise.resolve;
const nativePromiseReject = NativePromise.reject;
const nativePromiseAll = NativePromise.all;
const nativePromiseAllSettled = NativePromise.allSettled;
const nativePromiseRace = NativePromise.race;
const nativePromiseThen = NativePromise.prototype.then;
const nativePromiseFinally = NativePromise.prototype.finally;
const nativeSetAdd = NativeSet.prototype.add;
const nativeSetDelete = NativeSet.prototype.delete;
const nativeSetHas = NativeSet.prototype.has;
const nativeSetValues = NativeSet.prototype.values;
const nativeSetSize = Object.getOwnPropertyDescriptor(NativeSet.prototype, "size").get;
const nativeMapGet = NativeMap.prototype.get;
const nativeMapSet = NativeMap.prototype.set;
const nativeArrayFrom = Array.from;
const nativeArrayPush = Array.prototype.push;
const nativeArrayJoin = Array.prototype.join;
const nativeObjectFreeze = Object.freeze;
const nativeObjectKeys = Object.keys;
const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const nativeGetPrototypeOf = Object.getPrototypeOf;
const nativeDefineProperty = Object.defineProperty;
const nativeJsonParse = JSON.parse;
const nativeJsonStringify = JSON.stringify;
const nativeStringPadStart = String.prototype.padStart;
const nativeStringSlice = String.prototype.slice;
const nativeNumberToString = Number.prototype.toString;
const nativeRegExpExec = RegExp.prototype.exec;
const nativeEncodeURIComponent = encodeURIComponent;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const nativeStructuredClone = globalThis.structuredClone.bind(globalThis);
const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
const nativeDateNow = NativeDate.now;
const nativeDateToISOString = NativeDate.prototype.toISOString;
const nativeTextEncode = NativeTextEncoder.prototype.encode;
const nativeHeadersGet = NativeHeaders.prototype.get;
const nativeHeadersHas = NativeHeaders.prototype.has;
const nativeWebSocketClose = NativeWebSocket && NativeWebSocket.prototype.close;
const nativeReadableStreamGetReader = NativeReadableStream.prototype.getReader;
const nativeReadableStreamCancel = NativeReadableStream.prototype.cancel;
const nativeReaderRead = NativeReadableStreamDefaultReader.prototype.read;
const nativeReaderCancel = NativeReadableStreamDefaultReader.prototype.cancel;
const nativeReaderReleaseLock =
  NativeReadableStreamDefaultReader.prototype.releaseLock;
const nativeUint8ArraySet = NativeUint8Array.prototype.set;
const nativeNavigatorPrototype = apply(
  nativeGetPrototypeOf,
  NativeObject,
  [NativeNavigator],
);
const nativeGlobalPrototype = apply(
  nativeGetPrototypeOf,
  NativeObject,
  [globalThis],
);
const nativeConsoleWarn = console.warn.bind(console);
const nativeConsoleError = console.error.bind(console);
const nativeDisposeSymbol = NativeSymbol.dispose;

function apply(fn, receiver, args) {
  return nativeApply(fn, receiver, args);
}

export function resolveWorkflowPromise(value) {
  return apply(nativePromiseResolve, NativePromise, [value]);
}

export function rejectWorkflowPromise(error) {
  return apply(nativePromiseReject, NativePromise, [error]);
}

export function thenWorkflowPromise(promise, onFulfilled, onRejected) {
  return apply(nativePromiseThen, promise, [onFulfilled, onRejected]);
}

export function finallyWorkflowPromise(promise, onFinally) {
  return apply(nativePromiseFinally, promise, [onFinally]);
}

export function allWorkflowPromises(values) {
  return apply(nativePromiseAll, NativePromise, [values]);
}

function allSettledWorkflowPromises(values) {
  return apply(nativePromiseAllSettled, NativePromise, [values]);
}

export function raceWorkflowPromises(values) {
  return apply(nativePromiseRace, NativePromise, [values]);
}

export function createWorkflowPromise(executor) {
  return new NativePromise(executor);
}

export function createWorkflowError(message) {
  return new NativeError(message);
}

export function createWorkflowTypeError(message) {
  return new NativeTypeError(message);
}

${SENSITIVE_WORKFLOW_ERROR_FACTORY_SOURCE}
export { createSensitiveWorkflowError };

export function warnWorkflow(...args) {
  return nativeConsoleWarn(...args);
}

export function errorWorkflow(...args) {
  return nativeConsoleError(...args);
}

export function createWorkflowOperationSet() {
  return new NativeSet();
}

export function createWorkflowMap() {
  return new NativeMap();
}

export function getWorkflowMapValue(map, key) {
  return apply(nativeMapGet, map, [key]);
}

export function setWorkflowMapValue(map, key, value) {
  apply(nativeMapSet, map, [key, value]);
}

export function createWorkflowProxy(target, handler) {
  return new NativeProxy(target, handler);
}

export function workflowOwnKeys(value) {
  return apply(nativeOwnKeys, NativeReflect, [value]);
}

export function bindWorkflowFunction(fn, receiver) {
  return apply(nativeBind, fn, [receiver]);
}

export function callWorkflowFunction(fn, receiver, args) {
  return apply(fn, receiver, args);
}

export function getWorkflowDispose(value) {
  return value && (nativeDisposeSymbol ? value[nativeDisposeSymbol] : undefined);
}

export function workflowString(value) {
  return apply(NativeString, undefined, [value]);
}

export function workflowBoolean(value) {
  return apply(NativeBoolean, undefined, [value]);
}

export function workflowNumber(value) {
  return apply(NativeNumber, undefined, [value]);
}

export function pushWorkflowArray(array, value) {
  return apply(nativeArrayPush, array, [value]);
}

export function joinWorkflowArray(array, separator) {
  return apply(nativeArrayJoin, array, [separator]);
}

export function workflowObjectKeys(value) {
  return apply(nativeObjectKeys, NativeObject, [value]);
}

export function stringifyWorkflowJson(value, replacer) {
  return apply(nativeJsonStringify, NativeJson, [value, replacer]);
}

export function parseWorkflowJson(value) {
  return apply(nativeJsonParse, NativeJson, [value]);
}

export function matchWorkflowString(value, expression) {
  return apply(nativeRegExpExec, expression, [value]);
}

export function sliceWorkflowString(value, start, end) {
  return apply(nativeStringSlice, value, [start, end]);
}

export function testWorkflowRegex(expression, value) {
  return apply(nativeRegExpExec, expression, [value]) !== null;
}

export function encodeWorkflowPathSegment(value) {
  const encoded = apply(nativeEncodeURIComponent, undefined, [workflowString(value)]);
  const parts = [];
  for (let index = 0; index < encoded.length; index++) {
    pushWorkflowArray(parts, encoded[index] === "." ? "%2E" : encoded[index]);
  }
	const encodedPayload = joinWorkflowArray(parts, "");
  const safe = "x:" + encodedPayload;
  if (encodedPayload.length === 0 || safe.length > 160) {
    throw createWorkflowTypeError(
      "WORKFLOW_ARTIFACT_SEGMENT_INVALID: encoded workflow names must be between 1 and 160 bytes",
    );
  }
  return safe;
}

function deepFreezeWorkflowValue(value, seen) {
  if (value == null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (apply(nativeSetHas, seen, [value])) return value;
  apply(nativeSetAdd, seen, [value]);
  const keys = workflowOwnKeys(value);
  for (let index = 0; index < keys.length; index++) {
    deepFreezeWorkflowValue(value[keys[index]], seen);
  }
  return apply(nativeObjectFreeze, NativeObject, [value]);
}

export function freezeWorkflowValue(value) {
  return deepFreezeWorkflowValue(nativeStructuredClone(value), new NativeSet());
}

export function workflowIsoNow() {
  return apply(nativeDateToISOString, new NativeDate(), []);
}

export function workflowNowMs() {
  return apply(nativeDateNow, NativeDate, []);
}

export function digestWorkflowText(value) {
  const bytes = apply(nativeTextEncode, new NativeTextEncoder(), [value]);
  return nativeDigest("SHA-256", bytes);
}

export function frameWorkflowIdentity(parts) {
  const framed = [];
  for (let index = 0; index < parts.length; index++) {
    const value = workflowString(parts[index]);
    pushWorkflowArray(framed, value.length + ":" + value);
  }
  return joinWorkflowArray(framed, "|");
}

export async function digestWorkflowHex(value) {
  const digest = await digestWorkflowText(value);
  const bytes = new NativeUint8Array(digest);
  const parts = [];
  for (let index = 0; index < bytes.length; index++) {
    const hex = apply(nativeNumberToString, bytes[index], [16]);
    pushWorkflowArray(parts, apply(nativeStringPadStart, hex, [2, "0"]));
  }
  return joinWorkflowArray(parts, "");
}

export function workflowTimestampValue(value) {
  return value instanceof NativeDate
    ? apply(nativeDateToISOString, value, [])
    : value;
}

export function withWorkflowTimeout(promise, label, timeoutMs) {
  if (!label) return promise;
  let timer;
  const timeout = createWorkflowPromise((_, reject) => {
    timer = nativeSetTimeout(() => {
      reject(createWorkflowError("BRIDGE_CALL_TIMEOUT: " + label + " did not settle within " + timeoutMs + "ms"));
    }, timeoutMs);
  });
  return finallyWorkflowPromise(
    raceWorkflowPromises([promise, timeout]),
    () => nativeClearTimeout(timer),
  );
}

function operationThenable(active, record) {
  const wrapChild = (child) => trackWorkflowOperation(active, child);
  const thenable = {
    then(onFulfilled, onRejected) {
      record.observed = true;
      return wrapChild(thenWorkflowPromise(record.promise, onFulfilled, onRejected));
    },
    catch(onRejected) {
      record.observed = true;
      return wrapChild(thenWorkflowPromise(record.promise, undefined, onRejected));
    },
    finally(onFinally) {
      record.observed = true;
      return wrapChild(finallyWorkflowPromise(record.promise, onFinally));
    },
  };
  return apply(nativeObjectFreeze, NativeObject, [thenable]);
}

export function trackWorkflowOperation(active, operation) {
  const pending = resolveWorkflowPromise(operation);
  const record = { promise: pending, observed: false };
  apply(nativeSetAdd, active.pendingOperations, [record]);
  // Attach a rejection observer immediately so a quickly rejected floated
  // operation remains evidence for drain instead of becoming an unhandled
  // promise before the callback closes.
  thenWorkflowPromise(pending, () => undefined, () => undefined);
  return operationThenable(active, record);
}

export async function drainWorkflowOperations(active) {
  let unobservedFailure;
  while (apply(nativeSetSize, active.pendingOperations, []) > 0) {
    const iterator = apply(nativeSetValues, active.pendingOperations, []);
    const records = apply(nativeArrayFrom, NativeArray, [iterator]);
    const promises = [];
    for (let index = 0; index < records.length; index++) {
      apply(nativeArrayPush, promises, [records[index].promise]);
    }
    const outcomes = await allSettledWorkflowPromises(
      promises,
    );
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      apply(nativeSetDelete, active.pendingOperations, [record]);
      const outcome = outcomes[index];
      if (!record.observed && outcome && outcome.status === "rejected" && unobservedFailure === undefined) {
        unobservedFailure = outcome.reason;
      }
    }
  }
  if (unobservedFailure !== undefined) throw unobservedFailure;
}

export function createWorkflowOperation(callback) {
  return thenWorkflowPromise(resolveWorkflowPromise(undefined), callback);
}

const platformFetch = globalThis.fetch.bind(globalThis);
${WORKFLOW_FETCH_GATE_FACTORY_SOURCE}

function workflowWebSocketError() {
  return new NonRetryableError(
    "WORKFLOW_WEBSOCKET_DISABLED: streaming socket lifetimes cannot be bounded by a durable workflow step",
    "WorkflowWebSocketDisabledError",
  );
}

function prepareWorkflowRequestArgs(args) {
  const request = new NativeRequest(args[0], args[1]);
  const upgrade = apply(nativeHeadersGet, request.headers, ["upgrade"]);
  const hasSocketKey = apply(nativeHeadersHas, request.headers, ["sec-websocket-key"]);
  if ((upgrade && workflowString(upgrade).toLowerCase() === "websocket") || hasSocketKey) {
    throw workflowWebSocketError();
  }
  return [request];
}

const MAX_WORKFLOW_FETCH_RESPONSE_BYTES = 8 * 1024 * 1024;
async function validateWorkflowFetchResponse(response) {
  const socket = response && response.webSocket;
  if (socket && nativeWebSocketClose) {
    try {
      apply(nativeWebSocketClose, socket, [1000, "workflow socket disabled"]);
    } catch {}
  }
  if (socket) throw workflowWebSocketError();
  const contentLength = apply(nativeHeadersGet, response.headers, ["content-length"]);
  if (contentLength && workflowNumber(contentLength) > MAX_WORKFLOW_FETCH_RESPONSE_BYTES) {
	if (response.body) {
		try {
			await apply(nativeReadableStreamCancel, response.body, ["workflow response too large"]);
		} catch {}
	}
    throw new NonRetryableError(
      "WORKFLOW_FETCH_RESPONSE_TOO_LARGE: response exceeds the 8 MiB durable step boundary",
      "WorkflowFetchResponseTooLargeError",
    );
  }
  if (!response.body) {
    return new NativeResponse(null, {
      status: response.status,
      statusText: response.statusText,
      headers: new NativeHeaders(response.headers),
    });
  }
  const reader = apply(nativeReadableStreamGetReader, response.body, []);
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const part = await apply(nativeReaderRead, reader, []);
      if (part.done) break;
      const chunk = part.value instanceof NativeUint8Array
        ? part.value
        : new NativeUint8Array(part.value);
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_WORKFLOW_FETCH_RESPONSE_BYTES) {
        try {
          await apply(nativeReaderCancel, reader, ["workflow response too large"]);
        } catch {}
        throw new NonRetryableError(
          "WORKFLOW_FETCH_RESPONSE_TOO_LARGE: response exceeds the 8 MiB durable step boundary",
          "WorkflowFetchResponseTooLargeError",
        );
      }
      pushWorkflowArray(chunks, chunk);
    }
	} catch (error) {
		try {
			await apply(nativeReaderCancel, reader, ["workflow response materialization failed"]);
		} catch {}
		throw error;
  } finally {
    try {
      apply(nativeReaderReleaseLock, reader, []);
    } catch {}
  }
  const body = new NativeUint8Array(totalBytes);
  let offset = 0;
  for (let index = 0; index < chunks.length; index++) {
    apply(nativeUint8ArraySet, body, [chunks[index], offset]);
    offset += chunks[index].byteLength;
  }
  return new NativeResponse(totalBytes === 0 ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: new NativeHeaders(response.headers),
  });
}

const gatedFetch = createWorkflowFetchGate(
  () => workflowCallContext.getStore(),
  platformFetch,
  () => new NonRetryableError(
    "WORKFLOW_NETWORK_OUTSIDE_STEP: direct fetch() must run inside a step.do callback or rollback handler",
    "WorkflowNetworkOutsideStepError",
  ),
  createWorkflowOperation,
  trackWorkflowOperation,
  rejectWorkflowPromise,
	prepareWorkflowRequestArgs,
	validateWorkflowFetchResponse,
);

const blockedCaches = createWorkflowProxy({}, {
  get() {
    throw new NonRetryableError(
      "WORKFLOW_CACHE_API_DISABLED: tenant workflows must persist durable state through step outputs or artifacts",
      "WorkflowCacheApiDisabledError",
    );
  },
});

function BlockedWorkflowWebSocket() {
  throw workflowWebSocketError();
}

function BlockedWorkflowEventSource() {
  throw new NonRetryableError(
    "WORKFLOW_EVENT_SOURCE_DISABLED: streaming event lifetimes cannot be bounded by a durable workflow step",
    "WorkflowEventSourceDisabledError",
  );
}

function BlockedWorkflowWebSocketPair() {
  throw workflowWebSocketError();
}

function blockedWorkflowBeacon() {
  throw new NonRetryableError(
    "WORKFLOW_BEACON_DISABLED: fire-and-forget network calls are incompatible with durable workflow evidence",
    "WorkflowBeaconDisabledError",
  );
}

function hardenWorkflowPrimordials() {
  // Error.prototype.name becomes non-writable when the primordial is frozen.
  // Cloudflare's NonRetryableError constructor assigns this.name, so give its
  // immediate prototype a writable shadow before freezing the parent chain.
  // The constructor then creates an own property without weakening Error itself.
  const nonRetryableNameDescriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [NonRetryableError.prototype, "name"]);
  if (!nonRetryableNameDescriptor || nonRetryableNameDescriptor.configurable === true) {
    apply(nativeDefineProperty, NativeObject, [NonRetryableError.prototype, "name", {
      value: "NonRetryableError",
      writable: true,
      configurable: false,
      enumerable: false,
    }]);
  }
  const values = [
    NativePromise, NativePromise.prototype,
    NativeArray, NativeArray.prototype,
    NativeObject, NativeObject.prototype,
    NativeFunction, NativeFunction.prototype,
    NativeRegExp, NativeRegExp.prototype,
    NativeString, NativeString.prototype,
    NativeNumber, NativeNumber.prototype,
    NativeBoolean, NativeBoolean.prototype,
    NativeDate, NativeDate.prototype,
    NativeMap, NativeMap.prototype,
    NativeSet, NativeSet.prototype,
    NativeError, NativeError.prototype,
    NativeTypeError, NativeTypeError.prototype,
    NativeSymbol, NativeSymbol.prototype,
    NativeHeaders, NativeHeaders.prototype,
    NativeRequest, NativeRequest.prototype,
    NativeResponse, NativeResponse.prototype,
		NativeReadableStream, NativeReadableStream.prototype,
		NativeReadableStreamDefaultReader,
		NativeReadableStreamDefaultReader.prototype,
    NativeWebSocket, NativeWebSocket && NativeWebSocket.prototype,
		NativeWebSocketPair, NativeWebSocketPair && NativeWebSocketPair.prototype,
    NativeEventSource, NativeEventSource && NativeEventSource.prototype,
		NativeNavigator, nativeNavigatorPrototype,
    NativeTextEncoder, NativeTextEncoder.prototype,
    NativeUint8Array, NativeUint8Array.prototype,
		// The constructor is frozen, while its prototype keeps the writable name
		// shadow installed above so valid instances can assign an own name.
		NonRetryableError,
    NativeJson, NativeReflect,
		BlockedWorkflowWebSocket, BlockedWorkflowWebSocket.prototype,
		BlockedWorkflowEventSource, BlockedWorkflowEventSource.prototype,
		BlockedWorkflowWebSocketPair, BlockedWorkflowWebSocketPair.prototype,
		blockedWorkflowBeacon,
		nativeGlobalPrototype,
  ];
  for (let index = 0; index < values.length; index++) {
    apply(nativeObjectFreeze, NativeObject, [values[index]]);
  }
}

export function installWorkflowFetchGate() {
	const prototypeFetchDescriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeGlobalPrototype, "fetch"]);
	if (prototypeFetchDescriptor && prototypeFetchDescriptor.configurable === false && prototypeFetchDescriptor.writable !== true && prototypeFetchDescriptor.value !== gatedFetch) {
		throw new NonRetryableError(
			"WORKFLOW_FETCH_GATE_UNAVAILABLE: the tenant prototype fetch authority could not be disabled",
			"WorkflowFetchGateUnavailableError",
		);
	}
	apply(nativeDefineProperty, NativeObject, [nativeGlobalPrototype, "fetch", {
		value: gatedFetch,
		writable: false,
		configurable: false,
		enumerable: prototypeFetchDescriptor ? prototypeFetchDescriptor.enumerable : true,
	}]);
	const descriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [globalThis, "fetch"]);
	apply(nativeDefineProperty, NativeObject, [globalThis, "fetch", {
    value: gatedFetch,
    writable: false,
    configurable: false,
    enumerable: descriptor ? descriptor.enumerable : true,
  }]);
	const cacheDescriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [globalThis, "caches"]);
  if (cacheDescriptor && cacheDescriptor.configurable === false && cacheDescriptor.writable !== true) {
    throw new NonRetryableError(
      "WORKFLOW_CACHE_GATE_UNAVAILABLE: the tenant cache authority could not be disabled",
      "WorkflowCacheGateUnavailableError",
    );
  }
	apply(nativeDefineProperty, NativeObject, [globalThis, "caches", {
    value: blockedCaches,
    writable: false,
    configurable: false,
    enumerable: cacheDescriptor ? cacheDescriptor.enumerable : true,
  }]);
	const prototypeCacheDescriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeGlobalPrototype, "caches"]);
	if (prototypeCacheDescriptor && prototypeCacheDescriptor.configurable === false && prototypeCacheDescriptor.writable !== true && prototypeCacheDescriptor.value !== blockedCaches) {
		throw new NonRetryableError(
			"WORKFLOW_CACHE_GATE_UNAVAILABLE: the tenant prototype cache authority could not be disabled",
			"WorkflowCacheGateUnavailableError",
		);
	}
	apply(nativeDefineProperty, NativeObject, [nativeGlobalPrototype, "caches", {
		value: blockedCaches,
		writable: false,
		configurable: false,
		enumerable: prototypeCacheDescriptor ? prototypeCacheDescriptor.enumerable : true,
	}]);
	const webSocketDescriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [globalThis, "WebSocket"]);
	if (webSocketDescriptor && webSocketDescriptor.configurable === false && webSocketDescriptor.writable !== true && webSocketDescriptor.value !== BlockedWorkflowWebSocket) {
		throw new NonRetryableError(
			"WORKFLOW_WEBSOCKET_GATE_UNAVAILABLE: the tenant WebSocket authority could not be disabled",
			"WorkflowWebSocketGateUnavailableError",
		);
	}
	apply(nativeDefineProperty, NativeObject, [globalThis, "WebSocket", {
		value: BlockedWorkflowWebSocket,
		writable: false,
		configurable: false,
		enumerable: webSocketDescriptor ? webSocketDescriptor.enumerable : true,
	}]);
	const prototypeWebSocketDescriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeGlobalPrototype, "WebSocket"]);
	if (prototypeWebSocketDescriptor && prototypeWebSocketDescriptor.configurable === false && prototypeWebSocketDescriptor.writable !== true && prototypeWebSocketDescriptor.value !== BlockedWorkflowWebSocket) {
		throw new NonRetryableError(
			"WORKFLOW_WEBSOCKET_GATE_UNAVAILABLE: the tenant prototype WebSocket authority could not be disabled",
			"WorkflowWebSocketGateUnavailableError",
		);
	}
	apply(nativeDefineProperty, NativeObject, [nativeGlobalPrototype, "WebSocket", {
		value: BlockedWorkflowWebSocket,
		writable: false,
		configurable: false,
		enumerable: prototypeWebSocketDescriptor ? prototypeWebSocketDescriptor.enumerable : true,
	}]);
	if (NativeWebSocket && NativeWebSocket.prototype) {
		apply(nativeDefineProperty, NativeObject, [NativeWebSocket.prototype, "constructor", {
			value: BlockedWorkflowWebSocket,
			writable: false,
			configurable: false,
			enumerable: false,
		}]);
	}
	const webSocketPairDescriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [globalThis, "WebSocketPair"]);
	if (webSocketPairDescriptor && webSocketPairDescriptor.configurable === false && webSocketPairDescriptor.writable !== true && webSocketPairDescriptor.value !== BlockedWorkflowWebSocketPair) {
		throw new NonRetryableError(
			"WORKFLOW_WEBSOCKET_GATE_UNAVAILABLE: the tenant WebSocketPair authority could not be disabled",
			"WorkflowWebSocketGateUnavailableError",
		);
	}
	apply(nativeDefineProperty, NativeObject, [globalThis, "WebSocketPair", {
		value: BlockedWorkflowWebSocketPair,
		writable: false,
		configurable: false,
		enumerable: webSocketPairDescriptor ? webSocketPairDescriptor.enumerable : true,
	}]);
	const prototypeWebSocketPairDescriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeGlobalPrototype, "WebSocketPair"]);
	if (prototypeWebSocketPairDescriptor && prototypeWebSocketPairDescriptor.configurable === false && prototypeWebSocketPairDescriptor.writable !== true && prototypeWebSocketPairDescriptor.value !== BlockedWorkflowWebSocketPair) {
		throw new NonRetryableError(
			"WORKFLOW_WEBSOCKET_GATE_UNAVAILABLE: the tenant prototype WebSocketPair authority could not be disabled",
			"WorkflowWebSocketGateUnavailableError",
		);
	}
	apply(nativeDefineProperty, NativeObject, [nativeGlobalPrototype, "WebSocketPair", {
		value: BlockedWorkflowWebSocketPair,
		writable: false,
		configurable: false,
		enumerable: prototypeWebSocketPairDescriptor ? prototypeWebSocketPairDescriptor.enumerable : true,
	}]);
	const eventSourceDescriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [globalThis, "EventSource"]);
	if (eventSourceDescriptor && eventSourceDescriptor.configurable === false && eventSourceDescriptor.writable !== true && eventSourceDescriptor.value !== BlockedWorkflowEventSource) {
		throw new NonRetryableError(
			"WORKFLOW_EVENT_SOURCE_GATE_UNAVAILABLE: the tenant EventSource authority could not be disabled",
			"WorkflowEventSourceGateUnavailableError",
		);
	}
	apply(nativeDefineProperty, NativeObject, [globalThis, "EventSource", {
		value: BlockedWorkflowEventSource,
		writable: false,
		configurable: false,
		enumerable: eventSourceDescriptor ? eventSourceDescriptor.enumerable : true,
	}]);
	const prototypeEventSourceDescriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeGlobalPrototype, "EventSource"]);
	if (prototypeEventSourceDescriptor && prototypeEventSourceDescriptor.configurable === false && prototypeEventSourceDescriptor.writable !== true && prototypeEventSourceDescriptor.value !== BlockedWorkflowEventSource) {
		throw new NonRetryableError(
			"WORKFLOW_EVENT_SOURCE_GATE_UNAVAILABLE: the tenant prototype EventSource authority could not be disabled",
			"WorkflowEventSourceGateUnavailableError",
		);
	}
	apply(nativeDefineProperty, NativeObject, [nativeGlobalPrototype, "EventSource", {
		value: BlockedWorkflowEventSource,
		writable: false,
		configurable: false,
		enumerable: prototypeEventSourceDescriptor ? prototypeEventSourceDescriptor.enumerable : true,
	}]);
	const beaconDescriptor = apply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeNavigatorPrototype, "sendBeacon"]);
	if (beaconDescriptor && beaconDescriptor.configurable === false && beaconDescriptor.writable !== true && beaconDescriptor.value !== blockedWorkflowBeacon) {
		throw new NonRetryableError(
			"WORKFLOW_BEACON_GATE_UNAVAILABLE: the tenant beacon authority could not be disabled",
			"WorkflowBeaconGateUnavailableError",
		);
	}
	apply(nativeDefineProperty, NativeObject, [nativeNavigatorPrototype, "sendBeacon", {
		value: blockedWorkflowBeacon,
		writable: false,
		configurable: false,
		enumerable: beaconDescriptor ? beaconDescriptor.enumerable : true,
	}]);
	apply(nativeDefineProperty, NativeObject, [NativeNavigator, "sendBeacon", {
		value: blockedWorkflowBeacon,
		writable: false,
		configurable: false,
		enumerable: true,
	}]);
	hardenWorkflowPrimordials();
}
`;

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
export const DISPATCH_SHIM_VERSION = "v45-provider-confirmation";

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

// Bump when loader-side bridges or host orchestration change the observable
// semantics of an already-started execution epoch. Exact tenant module sources
// are hashed separately; this covers the TypeScript bridge implementations
// that cannot be introspected from a deployed Worker at runtime.
export const WORKFLOW_BRIDGE_COMPATIBILITY_VERSION =
	"v4-os-output-work-item-lineage";

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

// Outer RPC-boundary guard for env.MCP calls. Generous because some tools are
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
  if (testWorkflowRegex(/CAPABILITY_NOT_DECLARED|ANNOTATION_VIOLATION|MCP_INPUT_REQUIRED|MCP_UPSTREAM_RESPONSE_TOO_LARGE|WORKFLOW_CALL_CONTEXT_INVALID|MCP_TARGET_UNRESOLVED|MCP_BRIDGE_MISSING|(?:^|:\\s)(?:BAD_REQUEST|NOT_FOUND):|Input validation failed|unauthorized|forbidden|AUTH_/i, message)) {
    return true;
  }
  const statusMatch = matchWorkflowString(message, /MCP upstream returned\\s+(\\d{3})/i);
  if (!statusMatch) return false;
  const status = workflowNumber(statusMatch[1]);
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}

function normalizeBridgeError(error) {
  if (!permanentBridgeError(error)) return error;
  const message = error && error.message ? workflowString(error.message) : workflowString(error);
  return new NonRetryableError(message, error && error.name ? workflowString(error.name) : "McpPermanentError");
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
              const identity = await buildCallIdentity(
                runContext.runId,
                runContext.executionEpoch,
                namespace,
                method,
                workflow,
              );
              const path = "epochs/" + runContext.executionEpoch + "/steps/"
                + active.stepPathSegment + "/" + active.stepCount
                + "/attempts/" + active.attempt + "/calls/" + active.phase + "/" + ordinal + ".json";
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
                  : boundedEvidenceValue(args == null ? {} : args),
              };
              await persistArtifact(env, { path, value: started, outcome: "pending", attempt: active.attempt });
              const t0 = workflowNowMs();
              try {
                const result = await observeRpcCall(bridge.call({
                  namespace,
                  method,
                  args: args == null ? {} : args,
                  workflow,
                }), namespace + "." + method);
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
                    error: active.sensitiveEvidence
                      ? redactedErrorSnapshot()
                      : errorSnapshot(error),
                    retryable: !permanentBridgeError(error),
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

// Artifact persistence is best-effort — failures here must never fail the
// workflow itself. We still await it so Workers RPC can close call handles
// deterministically instead of relying on GC.
function persistArtifact(env, payload) {
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

function configSnapshot(config) {
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
    let lastSuccess = null;
    const callback = async (ctx) => {
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
        const activeContext = {
          stepName: ctx.step.name,
          stepCount: ctx.step.count,
          attempt: ctx.attempt,
          phase: "run",
          stepPathSegment: encodedStepName,
          sensitiveEvidence: sensitiveOutput,
          nextOrdinal: 1,
          pendingOperations: createWorkflowOperationSet(),
          enabled: true,
        };
        const value = await runWithWorkflowCallContext(activeContext, () => fn(ctx));
        const durationMs = workflowNowMs() - t0;
        const output = sensitiveOutput
          ? { redacted: true, reason: "workflow_step_sensitive_output" }
          : value;
        lastSuccess = {
          durationMs,
          attempt: ctx.attempt,
          count: ctx.step.count,
          sensitiveOutput,
          output,
        };
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
        ]);
        return value;
      } catch (error) {
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
      if (hasConfig) {
        value = wrappedRollback
          ? await step.do(name, config, callback, wrappedRollback)
          : await step.do(name, config, callback);
      } else {
        value = wrappedRollback
          ? await step.do(name, callback, wrappedRollback)
          : await step.do(name, callback);
      }
      const sensitiveOutput = lastSuccess
        ? lastSuccess.sensitiveOutput
        : workflowBoolean(config && config.sensitive === "output");
      await persistArtifact(env, {
        path: "outputs/" + encodedStepName + ".json",
        value: {
          value: sensitiveOutput
            ? { redacted: true, reason: "workflow_step_sensitive_output" }
            : value,
          durationMs: lastSuccess && lastSuccess.durationMs,
          stepCount: lastSuccess && lastSuccess.count,
          attempt: lastSuccess && lastSuccess.attempt,
          sensitiveOutput,
        },
        outcome: "success",
        ...(lastSuccess ? { attempt: lastSuccess.attempt } : {}),
      });
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
      result = await step.waitForEvent(name, opts);
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

export class TenantSkillWorkflow extends WorkflowEntrypoint {
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
	      // NOTE: env.artifacts.writeBlob was intentionally REMOVED. Calling it
	      // from inside step.do with a large (~1 MB) base64 payload stalls the
	      // step past its own timeout (verified: tiny blob completes, large blob
	      // hangs). The ArtifactBridge.writeBlob method remains for a future
	      // shim-driven raw-bytes path, but it is not exposed to tenant code —
	      // exposing it was a size-triggered stall trap. Media skills return
	      // base64 as the step value (shim auto-persists outside the step).
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
