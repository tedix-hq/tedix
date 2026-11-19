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
import baseline from "../fleet-authority-guards.json";
import { withFleetAuthority } from "../orpc";
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
type GuardPolicy =
	| { guard: "namespace"; tenantExceptions: string[] }
	| { guard: "procedures"; commercialProcedures: string[] };

const policies = baseline.namespaces as Record<string, GuardPolicy>;

interface ProcedureGuardState {
	namespace: string;
	/** Procedure path inside the namespace, dot-joined for nested groups. */
	name: string;
	guarded: boolean;
}

let implemented: Map<string, object>;
let inventory: ProcedureGuardState[];
beforeAll(async () => {
	implemented = procedures(await unlazyRouter(apiRouter));
	inventory = [...implemented].map(([path, procedure]) => {
		const [namespace = "", ...parts] = path.split("/");
		const internal = (
			procedure as {
				"~orpc": { orderedMiddlewares?: Array<{ middleware: unknown }> };
			}
		)["~orpc"];
		return {
			namespace,
			name: parts.join("."),
			guarded: (internal.orderedMiddlewares ?? []).some(
				(entry) => entry.middleware === withFleetAuthority,
			),
		};
	});
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

describe("fleet-authority guard coverage", () => {
	it("keeps fleet marketing authority structurally outside tenant Work Items", () => {
		const namesFor = (namespace: string) =>
			inventory
				.filter((entry) => entry.namespace === namespace)
				.map((entry) => entry.name)
				.sort();
		expect(namesFor("fleetMarketing")).toEqual([]);
	});

	it("keeps tenant catalog utilities structurally outside fleet curation", () => {
		const namesFor = (namespace: string) =>
			inventory
				.filter((entry) => entry.namespace === namespace)
				.map((entry) => entry.name)
				.sort();
		const tenantProcedures = [
			"installTenantMcpApp",
			"installTenantMcpApps",
			"previewOpenApiImport",
			"uninstallTenantMcpApp",
		];

		expect(namesFor("tenantCatalog")).toEqual(tenantProcedures);
		expect(
			namesFor("catalog").filter((name) => tenantProcedures.includes(name)),
		).toEqual([]);
	});

	it("matches the live router guard state exactly", () => {
		const namespaces = new Set(inventory.map((entry) => entry.namespace));
		const violations: string[] = [];

		for (const [namespace, policy] of Object.entries(policies)) {
			if (!namespaces.has(namespace)) {
				violations.push(`${namespace}: classified namespace is not served`);
				continue;
			}
			const procedures = inventory.filter(
				(entry) => entry.namespace === namespace,
			);
			const names = new Set(procedures.map((entry) => entry.name));
			const listed =
				policy.guard === "namespace"
					? policy.tenantExceptions
					: policy.commercialProcedures;
			for (const name of listed) {
				if (!names.has(name)) {
					violations.push(`${namespace}.${name}: stale baseline entry`);
				}
			}
			for (const procedure of procedures) {
				const expectGuarded =
					policy.guard === "namespace"
						? !policy.tenantExceptions.includes(procedure.name)
						: policy.commercialProcedures.includes(procedure.name);
				if (procedure.guarded !== expectGuarded) {
					violations.push(
						`${namespace}.${procedure.name}: ${
							expectGuarded
								? "fleet-commercial procedure is missing withFleetAuthority"
								: "tenant-product procedure unexpectedly carries withFleetAuthority"
						}`,
					);
				}
			}
		}

		expect(violations).toEqual([]);
	});

	it("never guards a procedure outside a fleet-commercial namespace", () => {
		const strays = inventory
			.filter((entry) => entry.guarded && !(entry.namespace in policies))
			.map((entry) => `${entry.namespace}.${entry.name}`);
		expect(strays).toEqual([]);
	});
});
