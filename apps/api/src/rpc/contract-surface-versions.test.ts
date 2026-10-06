/**
 * Contract-surface version registry parity.
 *
 * `@tedix/api-contract/contract-versions` is the machine-readable list of
 * versioned public surfaces. This test welds it to the thing that actually
 * publishes a surface: the OpenAPI public filter (`isPublicProcedure`). A
 * namespace is "public" exactly when at least one of its procedures carries
 * the `REST` tag without `internal` — the same predicate that admits it to
 * `/v1/*` and `/openapi.json` (`worker-app.ts`, `openapi-document.ts`).
 *
 * Both directions fail closed:
 *  - a NEW public namespace (first `REST`-tagged procedure) fails until it is
 *    versioned in the registry — publication requires a version decision;
 *  - a namespace whose last public procedure is removed fails until its
 *    registry entry is deleted — removal is a recorded decision, and a stale
 *    entry cannot imply a surface that no longer exists.
 *
 * Sibling guards this composes with, not duplicates:
 *  - `openapi-spec.test.ts` — generated spec === per-operation inventory
 *  - `contract-parity.test.ts` — apiContract/apiRouter/ROUTERS agree
 *  - `packages/api-contract/src/schemas/wire-backward-compatibility.test.ts`
 *    — frozen prior-wire fixtures still parse
 */

import { apiContract } from "@tedix/api-contract/contracts/api";
import {
	PLATFORM_SURFACE_VERSIONS,
	PUBLIC_REST_NAMESPACE_VERSIONS,
} from "@tedix/api-contract/contract-versions";
import { describe, expect, it } from "vite-plus/test";
import { OPENAPI_SPEC_BASE } from "../openapi-document";
import { isPublicProcedure } from "./openapi-filter";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const SEMVER = /^\d+\.\d+\.\d+$/;

/** A node is a procedure iff it carries the private `~orpc` definition (same
 * marker `contract-routers.ts` uses); otherwise recurse into the sub-router. */
function hasPublicProcedure(node: unknown): boolean {
	if (!isRecord(node)) return false;
	if (isRecord(node["~orpc"])) {
		return isPublicProcedure(node as Parameters<typeof isPublicProcedure>[0]);
	}
	return Object.entries(node).some(
		([key, child]) => key !== "~orpc" && hasPublicProcedure(child),
	);
}

const exposedNamespaces = Object.entries(apiContract)
	.filter(([, node]) => hasPublicProcedure(node))
	.map(([namespace]) => namespace)
	.sort();

describe("contract-surface version registry", () => {
	it("covers exactly the namespaces the public OpenAPI filter exposes", () => {
		expect(Object.keys(PUBLIC_REST_NAMESPACE_VERSIONS).sort()).toEqual(
			exposedNamespaces,
		);
	});

	it("declares a coherent version entry for every public REST namespace", () => {
		for (const [namespace, entry] of Object.entries(
			PUBLIC_REST_NAMESPACE_VERSIONS,
		)) {
			expect(entry.surface).toBe(`rest:${namespace}`);
			expect(entry.version).toMatch(SEMVER);
			// A stable surface must carry a real deprecation window; an unstable
			// one must not pretend to offer one.
			if (entry.stability === "stable") {
				expect(entry.deprecationPolicy).toBe("stable-release-window");
			} else {
				expect(entry.deprecationPolicy).toBe("none");
			}
		}
	});

	it("keeps the openapi-document registry version equal to the served spec version", () => {
		expect(PLATFORM_SURFACE_VERSIONS["openapi-document"].version).toBe(
			OPENAPI_SPEC_BASE.info.version,
		);
	});

	it("keeps platform surface ids unique and disjoint from REST namespaces", () => {
		const restSurfaces = Object.values(PUBLIC_REST_NAMESPACE_VERSIONS).map(
			(entry) => entry.surface,
		);
		const platformSurfaces = Object.entries(PLATFORM_SURFACE_VERSIONS).map(
			([key, entry]) => {
				expect(entry.surface).toBe(key);
				return entry.surface;
			},
		);
		const all = [...restSurfaces, ...platformSurfaces];
		expect(new Set(all).size).toBe(all.length);
	});
});
