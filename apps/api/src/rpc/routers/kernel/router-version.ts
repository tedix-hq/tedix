/**
 * Kernel — router version (harness evidence v1).
 *
 * The router itself is a harness component: it needs versioning, evals, trace
 * capture, and rollback (docs/engineering/cognition/runtime.md).
 * The Home route planner IS that router, but the kernel has NO tedi identity
 * and must never fake one (decisions/agentic-kernel-architecture.md) — and
 * kernel harness rows now use `harness_subject_versions`, keyed by
 * `subject_kind="kernel"` / `subject_id="kernel:{orgId}"`, so the kernel can
 * be versioned without fabricating a tedi identity.
 *
 * v1 therefore stamps a DETERMINISTIC CONTENT-HASH version onto every route
 * decision and is mirrored into the kernel subject version. `routerVersion` is the
 * first 12 hex chars of SHA-256 over:
 *
 *   1. `ROUTER_CONTRACT_REV` — manually bumped for semantic changes a content
 *      hash cannot see (e.g. the MEANING of an existing route changes),
 *   2. the route-planner SYSTEM_PROMPT text,
 *   3. a stable serialization of the route schema's shape (route kinds,
 *      effort classes, sorted top-level decision field names).
 *
 * Any prompt edit, enum change, or field add/remove produces a new
 * routerVersion, so persisted `kernelRoute` run-metadata records are groupable
 * by router version for evals.
 *
 * HASH CHOICE: Web Crypto SHA-256 (`crypto.subtle.digest`) — the established
 * hashing primitive in this Worker (rate-limit.ts, memory-graph.ts,
 * kernel-runtime.ts) — rather than a tiny sync FNV/djb2. Web Crypto is async,
 * but the only production caller (`planKernelRoute`) is already async, and the
 * digest is computed lazily ONCE per isolate and cached module-level as a
 * Promise, so the async plumbing costs nothing.
 *
 * The planner supplies its prompt to `getRouterVersion`; this leaf owns only
 * deterministic versioning and never imports the planner runtime.
 */

import {
	HOME_EFFORT_CLASSES,
	HOME_ROUTE_KINDS,
	KernelRouteDecisionSchema,
} from "./route-schema";

/**
 * Manually-bumped contract revision for semantic changes the content hash
 * cannot see (e.g. an existing routeKind's meaning changes without any prompt
 * or schema text changing). Bump on such changes; never decrement.
 *
 * rev 2: a deterministic post-verdict guard
 * (`delegation-intent.ts`) now downgrades low-risk single-read
 * `delegate_tedi` verdicts over Tedix-internal state to `answer_in_home` and
 * stamps `explicitDelegationIntent` — the meaning of a persisted
 * `delegate_tedi` decision changed without a schema-shape change.
 */
export const ROUTER_CONTRACT_REV = 2;

/**
 * Stable serialization of the model-facing route schema's shape: the route
 * kind enum, the effort class enum, and the SORTED top-level field names of
 * {@link KernelRouteDecisionSchema}. Sorting makes the hash insensitive to a
 * pure field reorder (not a contract change) while staying sensitive to
 * adds/removes/renames.
 */
export function serializeRouteSchemaShape(): string {
	return JSON.stringify({
		routeKinds: HOME_ROUTE_KINDS,
		effortClasses: HOME_EFFORT_CLASSES,
		fields: Object.keys(KernelRouteDecisionSchema.shape).sort(),
	});
}

/** Injectable inputs for {@link computeRouterVersion} — exported for tests. */
export interface RouterVersionInputs {
	contractRev: number;
	systemPrompt: string;
	schemaShape: string;
}

/**
 * Pure hash over injectable inputs: first 12 hex chars (6 bytes) of SHA-256
 * over a labeled, separator-delimited canonical string. The labels + the
 * `␞` (symbol-for-record-separator) delimiter prevent boundary
 * ambiguity — text moving across the prompt/schema boundary changes the hash.
 */
export async function computeRouterVersion(
	inputs: RouterVersionInputs,
): Promise<string> {
	const canonical = [
		`rev:${inputs.contractRev}`,
		`prompt:${inputs.systemPrompt}`,
		`schema:${inputs.schemaShape}`,
	].join("\n␞\n");
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical),
	);
	return Array.from(new Uint8Array(digest).slice(0, 6))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

let cachedVersion: Promise<string> | null = null;

/**
 * The router version for the CURRENT planner contract (prompt + schema shape
 * + contract rev). Lazily computed once per isolate and cached module-level.
 */
export function getRouterVersion(systemPrompt: string): Promise<string> {
	cachedVersion ??= computeRouterVersion({
		contractRev: ROUTER_CONTRACT_REV,
		systemPrompt,
		schemaShape: serializeRouteSchemaShape(),
	});
	return cachedVersion;
}
