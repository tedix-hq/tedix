/**
 * Contract/router parity guard.
 *
 * `apiContract` is never imported by `apps/api` — the handlers and the OpenAPI
 * generator are all built from `apiRouter` (see `worker-app.ts`). Nothing else
 * checks the two against each other, so a router could ship, serve traffic, and
 * still be invisible to every typed client and to `/openapi.json`.
 *
 * That is not hypothetical: `harness` (13 procedures), `tenantMembership` (2)
 * and `waitlist` (3) were all live and served while absent from `apiContract`,
 * and `ROUTERS` — which backs `resolveContractEndpoint()` and therefore the MCP
 * tool-schema projection — was separately missing `harness` and `voice`.
 * The defect class had been fixed before and regressed because there was no
 * test.
 *
 * Three registries have to agree:
 *   - `apiRouter`   — what the RPC handler can serve; the public REST/spec
 *                     filter selects a strict subset
 *   - `apiContract` — what typed clients can see
 *   - `ROUTERS`     — what contract-endpoint resolution / tool-schema sync sees
 */

import { apiContract } from "@tedix/api-contract/contracts/api";
import { ROUTERS } from "@tedix/api-contract/utils/contract-routers";
import { describe, expect, it } from "vite-plus/test";
import { apiRouter } from "./index";

/** `apiContract` is built with `oc.prefix("/v1").router({...})`, so its own keys are the namespaces. */
function namespaces(registry: object): string[] {
	return Object.keys(registry).sort();
}

describe("contract/router parity", () => {
	it("serves exactly the namespaces the contract declares", () => {
		expect(namespaces(apiContract)).toEqual(namespaces(apiRouter));
	});

	it("resolves every served namespace through ROUTERS", () => {
		expect(namespaces(ROUTERS)).toEqual(namespaces(apiRouter));
	});

	it("keeps all three registries at the same size", () => {
		const sizes = {
			apiRouter: Object.keys(apiRouter).length,
			apiContract: Object.keys(apiContract).length,
			ROUTERS: Object.keys(ROUTERS).length,
		};

		expect(new Set(Object.values(sizes)).size).toBe(1);
	});
});
