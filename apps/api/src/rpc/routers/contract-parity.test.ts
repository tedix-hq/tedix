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

import { readdir } from "node:fs/promises";
import { Procedure, unlazyRouter } from "@orpc/server";
import { apiContract } from "@tedix/api-contract/contracts/api";
import {
	ROUTERS,
	resolveContractEndpoint,
} from "@tedix/api-contract/utils/contract-routers";
import {
	procedureInputSchema,
	procedureOutputSchema,
} from "@tedix/api-contract/utils/procedure-schemas";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
	planToolSchemaSyncProjection,
	resolveEffectiveToolSchemaSyncOptions,
} from "../../services/tool-schema-sync";
import { apiRouter } from "./index";

/** Keep full nested paths: matching namespaces can hide missing procedures. */
function procedures(
	node: unknown,
	path: string[] = [],
	out = new Map<string, object>(),
): Map<string, object> {
	if (!node || typeof node !== "object") return out;
	if ("~orpc" in node) {
		out.set(path.join("/"), node);
	} else if (Object.getPrototypeOf(node) === Object.prototype) {
		for (const [key, child] of Object.entries(node))
			procedures(child, [...path, key], out);
	}
	return out;
}

function expectSchemas(actual: object, contract: object, path: string) {
	// Contract-first routers inherit the schema objects themselves. Identity
	// also catches transforms/refinements that JSON Schema cannot represent.
	expect(procedureInputSchema(actual), `${path} input`).toBe(
		procedureInputSchema(contract),
	);
	expect(procedureOutputSchema(actual), `${path} output`).toBe(
		procedureOutputSchema(contract),
	);
}

const declared = procedures(apiContract);
const registered = procedures(ROUTERS);
let implemented: Map<string, object>;
beforeAll(async () => {
	implemented = procedures(await unlazyRouter(apiRouter));
}, 120_000);

describe("contract/router parity", () => {
	it("implements exactly every declared procedure with its input and output schemas", () => {
		expect([...implemented.keys()].sort()).toEqual([...declared.keys()].sort());
		expect([...registered.keys()].sort()).toEqual([...declared.keys()].sort());
		for (const [path, contract] of declared) {
			const router = implemented.get(path)!;
			expect(router, path).toBeInstanceOf(Procedure);
			expectSchemas(router, contract, path);
			expectSchemas(registered.get(path)!, contract, path);
		}
	});

	it("registers every procedure exported from the contracts directory", async () => {
		const directory = new URL(
			"../../../../../packages/api-contract/src/contracts/",
			import.meta.url,
		);
		const leaves = [...registered.entries()];
		const files = (await readdir(directory, { recursive: true })).filter(
			(file) =>
				file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "api.ts",
		);
		for (const file of files) {
			const exports = await import(new URL(file, directory).href);
			for (const [name, value] of Object.entries(exports)) {
				for (const [path, procedure] of procedures(value)) {
					const matches = leaves.filter(
						([endpoint, candidate]) =>
							endpoint.endsWith(`/${path}`) &&
							procedureInputSchema(candidate) ===
								procedureInputSchema(procedure) &&
							procedureOutputSchema(candidate) ===
								procedureOutputSchema(procedure),
					);
					expect(
						matches.length,
						`${file}:${name}/${path} is unregistered`,
					).toBeGreaterThan(0);
				}
			}
		}
	});

	it("maps every projected MCP RPC tool to an implemented contract procedure", () => {
		const plan = planToolSchemaSyncProjection(
			{},
			"5eed0020-0000-4000-8000-000000000020",
		);
		expect(plan.endpoints.length).toBeGreaterThan(0);
		expect(Object.keys(plan.toolIds).sort()).toEqual(
			[...plan.endpoints].sort(),
		);
		// Overrides are maintained by hand and a stale key can otherwise be
		// silently excluded by the projection candidate filter.
		const options = resolveEffectiveToolSchemaSyncOptions(
			{},
			plan.appId,
			plan.appId,
		);
		const endpoints = new Set([
			...plan.endpoints,
			...Object.keys(options.toolIdOverrides ?? {}),
			...Object.keys(options.kindOverrides ?? {}),
			...Object.keys(options.widgetOverrides ?? {}),
		]);
		expect(
			[...endpoints].filter((endpoint) => !resolveContractEndpoint(endpoint)),
		).toEqual([]);
		for (const endpoint of endpoints) {
			const router = implemented.get(endpoint);
			expect(router, endpoint).toBeInstanceOf(Procedure);
			expectSchemas(router!, registered.get(endpoint)!, endpoint);
		}
	});
});
