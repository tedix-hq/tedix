import {
	describeModelContextApi,
	type ModelContextLike,
	type ResolvedModelContext,
	resolveModelContextSource,
	type WebMcpHostApi,
	type WebMcpHostSource,
	type WebMcpToolDef,
	type WebMcpToolResult,
} from "./model-context";

/**
 * Scope registry for route-aware WebMCP tools.
 *
 * Routes register a named scope of tools on mount and dispose it on leave;
 * the registry composes every live scope into one tool set and projects it
 * onto whichever WebMCP surface the browser offers:
 *
 * - Current `registerTool(tool, { signal })` is preferred. Every projection
 *   owns an AbortController, so route and tenant changes unregister the old
 *   tool set before registering the new one.
 * - Legacy `provideContext` remains a compatibility fallback for experiments
 *   that only implement whole-set replacement.
 *
 * Module-level singleton by design (like the realtime connection manager):
 * the document has one agent surface, not one per React tree. No React here.
 */

interface ScopeEntry {
	tools: WebMcpToolDef[];
}

const scopes = new Map<string, ScopeEntry>();
let projectionController: AbortController | null = null;
let projectionGeneration = 0;
let lastRegistrationError: string | null = null;

/**
 * Injectable for tests; production always uses the real feature detection.
 * Resolution is source-aware so the diagnostic probe reports the host it
 * actually found rather than re-deriving detection of its own.
 */
let contextResolver: () => ResolvedModelContext | null =
	resolveModelContextSource;

/** One console hint per document when tools are dropped for want of a host. */
let missingHostHintEmitted = false;

/** Outcome class of one tool invocation; never carries args or results. */
export type WebMcpInvocationOutcome = "ok" | "error" | "context_unavailable";

/**
 * One bounded invocation record: name, scope, outcome class, wall time, and a
 * per-invocation correlation id. Deliberately NOTHING else — no arguments, no
 * results, no user content.
 */
export interface WebMcpInvocationEvent {
	tool: string;
	scope: string;
	outcome: WebMcpInvocationOutcome;
	durationMs: number;
	/** Fresh UUID minted per execute call; correlates telemetry with API writes. */
	invocationId: string;
}

/**
 * The invocation id of the execute currently in flight, or null outside one.
 *
 * KNOWN CAVEAT — this is a module-level ambient value, not async context.
 * Two overlapping executes in the same document interleave their awaits, so
 * the second execute's id overwrites the first's for the remainder of the
 * overlap: attribution is best-effort. That is correct in the
 * single-agent-per-page reality this registry serves (one browser agent
 * surface, tools invoked one at a time), and deliberately NOT worth an
 * async-context abstraction — a wrong-but-present id still marks the request
 * as agent-initiated, which is the load-bearing signal.
 */
let ambientInvocationId: string | null = null;

export function currentWebMcpInvocationId(): string | null {
	return ambientInvocationId;
}

let invocationObserver: ((event: WebMcpInvocationEvent) => void) | null = null;

/**
 * Optional invocation telemetry hook. The core stays dependency-free: hosts
 * that want telemetry install an observer; with none set the instrumented
 * execute is a single null check over the tool's own execute. Observer
 * failures are swallowed — telemetry must never affect a tool result.
 */
export function setWebMcpInvocationObserver(
	observer: ((event: WebMcpInvocationEvent) => void) | null,
): void {
	invocationObserver = observer;
}

function nowMs(): number {
	return typeof performance !== "undefined" &&
		typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

/** isError absent/false → ok; typed context_unavailable → its own class; else error. */
function classifyOutcome(result: WebMcpToolResult): WebMcpInvocationOutcome {
	if (result.isError !== true) return "ok";
	return result.structuredContent?.error === "context_unavailable"
		? "context_unavailable"
		: "error";
}

function emitInvocation(
	observer: (event: WebMcpInvocationEvent) => void,
	tool: string,
	scope: string,
	outcome: WebMcpInvocationOutcome,
	startedAt: number,
	invocationId: string,
): void {
	try {
		observer({
			tool,
			scope,
			outcome,
			durationMs: Math.max(0, Math.round(nowMs() - startedAt)),
			invocationId,
		});
	} catch {
		// Telemetry must never affect the tool result.
	}
}

/**
 * Wraps a tool's execute at registration time with outcome/duration telemetry
 * and per-invocation correlation: every call mints a fresh invocationId, holds
 * it in the ambient slot (`currentWebMcpInvocationId`) for the lifetime of the
 * execute so hosts can stamp outbound API requests, and clears it when the
 * execute settles — guarded so a concurrent execute's newer id is never
 * clobbered by an older one finishing (see the ambient-slot caveat above).
 */
function instrumented(scopeKey: string, tool: WebMcpToolDef): WebMcpToolDef {
	return {
		...tool,
		execute: (args, options) => {
			// Snapshot the observer per call; the correlation id is minted
			// regardless, because request attribution must not depend on
			// whether a telemetry observer happens to be installed.
			const observer = invocationObserver;
			const invocationId = crypto.randomUUID();
			const startedAt = nowMs();
			ambientInvocationId = invocationId;
			const clearAmbient = (): void => {
				if (ambientInvocationId === invocationId) ambientInvocationId = null;
			};
			let pending: Promise<WebMcpToolResult>;
			try {
				pending = tool.execute(args, options);
			} catch (error) {
				// Execute never throws synchronously by contract; a defect must
				// still release the ambient slot and be recorded.
				clearAmbient();
				if (observer) {
					emitInvocation(
						observer,
						tool.name,
						scopeKey,
						"error",
						startedAt,
						invocationId,
					);
				}
				throw error;
			}
			return pending.then(
				(result) => {
					clearAmbient();
					if (observer) {
						emitInvocation(
							observer,
							tool.name,
							scopeKey,
							classifyOutcome(result),
							startedAt,
							invocationId,
						);
					}
					return result;
				},
				(error: unknown) => {
					// An escaping exception is a tool defect (execute never
					// throws by contract); record it as an error and rethrow.
					clearAmbient();
					if (observer) {
						emitInvocation(
							observer,
							tool.name,
							scopeKey,
							"error",
							startedAt,
							invocationId,
						);
					}
					throw error;
				},
			);
		},
	};
}

/**
 * Test seam. Accepts either the sourced form (to exercise host reporting) or a
 * bare context; a bare context is reported as the `document` surface, which is
 * what production detection prefers.
 */
export function setModelContextResolverForTests(
	resolver: (() => ModelContextLike | ResolvedModelContext | null) | null,
): void {
	contextResolver = resolver
		? () => {
				const resolved = resolver();
				if (!resolved) return null;
				return "context" in resolved
					? resolved
					: { context: resolved, source: "document" };
			}
		: resolveModelContextSource;
	missingHostHintEmitted = false;
	projectionController?.abort();
	projectionController = null;
	projectionGeneration = 0;
	lastRegistrationError = null;
	ambientInvocationId = null;
	scopes.clear();
}

function composedTools(): WebMcpToolDef[] {
	const all: WebMcpToolDef[] = [];
	const seen = new Set<string>();
	for (const entry of scopes.values()) {
		for (const tool of entry.tools) {
			// First registration wins on a name collision; collisions are a
			// programming error surfaced by the registry test, not runtime UI.
			if (seen.has(tool.name)) continue;
			seen.add(tool.name);
			all.push(tool);
		}
	}
	return all;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function project(context: ModelContextLike): void {
	const tools = composedTools();
	const generation = ++projectionGeneration;
	lastRegistrationError = null;
	projectionController?.abort();
	projectionController = null;

	if (context.registerTool) {
		const controller = new AbortController();
		projectionController = controller;
		void Promise.all(
			tools.map((tool) => {
				try {
					return Promise.resolve(
						context.registerTool?.(tool, { signal: controller.signal }),
					);
				} catch (error) {
					return Promise.reject(error);
				}
			}),
		).catch((error: unknown) => {
			if (controller.signal.aborted || generation !== projectionGeneration)
				return;
			lastRegistrationError = errorMessage(error);
			console.error("WebMCP tool registration failed", error);
		});
		return;
	}

	if (!context.provideContext) return;
	try {
		context.provideContext({ tools });
	} catch (error) {
		// WebMCP is an optional enhancement. A legacy host can reject a
		// projection synchronously (for example while replacing a stale scope),
		// but that must never abort the mounting application's own controls.
		lastRegistrationError = errorMessage(error);
		console.error("WebMCP tool registration failed", error);
	}
}

/**
 * Register a scope of tools. Returns a dispose callback; calling it removes
 * the scope and re-projects. Registering an existing scope key replaces it.
 * With no WebMCP surface present this is a free no-op.
 */
export function registerWebMcpScope(
	scopeKey: string,
	tools: WebMcpToolDef[],
): () => void {
	const resolved = contextResolver();
	if (!resolved) {
		noteMissingHost();
		return () => {};
	}
	disposeScope(scopeKey);
	const entry: ScopeEntry = {
		tools: tools.map((tool) => instrumented(scopeKey, tool)),
	};
	scopes.set(scopeKey, entry);
	project(resolved.context);
	return () => {
		if (!disposeScope(scopeKey, entry)) return;
		const current = contextResolver();
		if (!current) return;
		project(current.context);
	};
}

/**
 * One bounded console hint per document, the first time a scope is dropped
 * because no host answered detection. This exists because an empty probe is
 * ambiguous — "no host" and "route registers nothing" look identical — and a
 * validation session once filed a false bug from that ambiguity. Names the
 * probe, carries no tool names, arguments, or results, never throws, and never
 * changes registration behavior.
 */
function noteMissingHost(): void {
	if (missingHostHintEmitted) return;
	missingHostHintEmitted = true;
	try {
		console.info(
			"WebMCP tools are not being registered: no WebMCP host detected on this page (checked document.modelContext, then navigator.modelContext). This is expected in a browser without WebMCP support — it does not mean the route has no tools. Run window.__tedixWebMcp.status() and read host.detected.",
		);
	} catch {
		// A hint must never affect behavior.
	}
}

function disposeScope(scopeKey: string, expected?: ScopeEntry): boolean {
	const entry = scopes.get(scopeKey);
	if (!entry || (expected && entry !== expected)) return false;
	scopes.delete(scopeKey);
	return true;
}

/** Live tool names, for tests and live verification from the console. */
export function webMcpRegisteredToolNames(): string[] {
	return composedTools().map((tool) => tool.name);
}

export interface WebMcpHostStatus {
	/** True only when a WebMCP host object answered detection. */
	detected: boolean;
	/** Which surface carried it, or null when nothing was found. */
	source: WebMcpHostSource | null;
	/** Which projection API it offers; `none` with no host, or an inert host. */
	api: WebMcpHostApi;
}

export interface WebMcpRegistrationStatus {
	host: WebMcpHostStatus;
	tools: string[];
	generation: number;
	error: string | null;
}

/**
 * Diagnostic probe. `tools: []` alone is ambiguous — it means either "this
 * browser has no WebMCP host" or "this route registers nothing" — so the
 * status reports the host honestly, from the SAME resolution path the registry
 * registers through. `host.detected === false` with an empty tool list means
 * the wrong browser, not a broken route.
 *
 * Zero authority, payload-free: names and detection facts only, never tool
 * arguments or results.
 */
export function webMcpRegistrationStatus(): WebMcpRegistrationStatus {
	const resolved = contextResolver();
	return {
		host: {
			detected: resolved !== null,
			source: resolved?.source ?? null,
			api: describeModelContextApi(resolved?.context ?? null),
		},
		tools: webMcpRegisteredToolNames(),
		generation: projectionGeneration,
		error: lastRegistrationError,
	};
}

declare global {
	interface Window {
		/** Live-verification probe; carries no authority and no data. */
		__tedixWebMcp?: {
			tools(): string[];
			status(): ReturnType<typeof webMcpRegistrationStatus>;
		};
	}
}

if (typeof window !== "undefined") {
	window.__tedixWebMcp = {
		tools: webMcpRegisteredToolNames,
		status: webMcpRegistrationStatus,
	};
}
