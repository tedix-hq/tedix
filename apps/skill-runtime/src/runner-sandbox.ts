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
    active.directNetworkStarted = true;
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
