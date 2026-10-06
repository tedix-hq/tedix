/**
 * Fleet-authority guard coverage: the tenant product must have no Tedix Cloud
 * dependency in `TEDIX_FLEET_AUTHORITY_MODE=disabled` mode.
 *
 * The seam itself is small — `withFleetAuthority` rejects before a handler can
 * touch commercial storage or provider secrets, and fleet-authority.test.ts
 * plus routers/fleet-authority.test.ts prove that behavior. What nothing
 * proved until this file is COVERAGE: that every procedure the authority
 * classification calls fleet-commercial actually carries the guard, and that
 * the guard never leaks into tenant-product namespaces. Both directions used
 * to rest on 17 routers each remembering a `.use(withFleetAuthority)` line.
 *
 * Three inputs must agree, exactly:
 *  - scripts/oss/authority-classification.json — which api-namespaces are
 *    fleet-commercial (the OSS separation authority);
 *  - fleet-authority-guards.json — per-procedure expectations, including the
 *    deliberate tenant-product exceptions inside mixed namespaces;
 *  - the live router — which procedures actually carry the middleware,
 *    detected by reference identity on the implementer's middleware chain.
 *
 * A new procedure in a `guard: "namespace"` namespace must be guarded or this
 * fails (fail-closed default). Removing a guard, adding a stale exception, or
 * guarding a procedure the classification calls tenant-product all fail too.
 */

import { Procedure, unlazyRouter } from "@orpc/server";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import classification from "../../../../scripts/oss/authority-classification.json";
import { withFleetAuthority } from "./orpc";
import baseline from "./fleet-authority-guards.json";
import { apiRouter } from "./routers/index";

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

let guardInventoryPromise: Promise<ProcedureGuardState[]> | undefined;

function guardInventory(): Promise<ProcedureGuardState[]> {
	// apiRouter and its middleware chains are immutable for this test module.
	// Share the expensive unlazy walk across assertions so full-suite CPU load
	// cannot turn four identical inventory builds into per-test timeouts.
	guardInventoryPromise ??= buildGuardInventory();
	return guardInventoryPromise;
}

async function buildGuardInventory(): Promise<ProcedureGuardState[]> {
	const flat = await unlazyRouter(apiRouter);
	const inventory: ProcedureGuardState[] = [];
	const walk = (node: object, path: string[]): void => {
		if (node instanceof Procedure) {
			const internal = (
				node as unknown as {
					"~orpc": { orderedMiddlewares?: Array<{ middleware: unknown }> };
				}
			)["~orpc"];
			inventory.push({
				namespace: path[0] ?? "",
				name: path.slice(1).join("."),
				guarded: (internal.orderedMiddlewares ?? []).some(
					(entry) => entry.middleware === withFleetAuthority,
				),
			});
			return;
		}
		for (const [key, value] of Object.entries(node)) {
			walk(value as object, [...path, key]);
		}
	};
	walk(flat, []);
	return inventory.sort((left, right) =>
		`${left.namespace}.${left.name}`.localeCompare(
			`${right.namespace}.${right.name}`,
		),
	);
}

function classifiedFleetCommercialNamespaces(): string[] {
	return classification.entries
		.filter(
			(entry) =>
				entry.kind === "api-namespace" && entry.category === "fleet-commercial",
		)
		.map((entry) => entry.identifier)
		.sort();
}

describe("fleet-authority guard coverage", () => {
	// Build the inventory ONCE, outside any assertion body. The memo above
	// shares the cost between tests, but whichever `it()` ran first still paid
	// the whole cold `unlazyRouter` walk inside vitest's 5s default, so under
	// CPU contention — a shared CI runner, or a busy laptop — that first test
	// timed out and reported as a failure of the assertion rather than of the
	// fixture. Constructing the fixture here, with a timeout sized for the walk
	// rather than for an assertion, leaves every expectation below untouched.
	beforeAll(async () => {
		await guardInventory();
	}, 120_000);

	it("shares one immutable router inventory across the suite", async () => {
		const inventory = await guardInventory();
		expect(await guardInventory()).toBe(inventory);
	});

	it("keeps fleet marketing authority structurally outside tenant Work Items", async () => {
		const inventory = await guardInventory();
		const namesFor = (namespace: string) =>
			inventory
				.filter((entry) => entry.namespace === namespace)
				.map((entry) => entry.name)
				.sort();
		expect(namesFor("fleetMarketing")).toEqual([]);
	});

	it("keeps tenant catalog utilities structurally outside fleet curation", async () => {
		const inventory = await guardInventory();
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

	it("keeps the baseline aligned with the authority classification", () => {
		const fleetCommercial = classifiedFleetCommercialNamespaces();

		// Every fleet-commercial namespace must carry a baseline guard policy.
		expect(
			fleetCommercial.filter((namespace) => !(namespace in policies)),
		).toEqual([]);

		// A baseline entry OUTSIDE the fleet-commercial classification is legal
		// in exactly one shape: procedure-scoped commercial exceptions inside an
		// explicitly tenant-product namespace, pending their namespace split
		// (the workItems shape — see the classification rationale). Anything
		// else is a stale baseline or an unclassified namespace: fail closed.
		const classifiedCategories = new Map(
			classification.entries
				.filter((entry) => entry.kind === "api-namespace")
				.map((entry) => [entry.identifier, entry.category]),
		);
		const extras = Object.keys(policies)
			.filter((namespace) => !fleetCommercial.includes(namespace))
			.sort();
		for (const namespace of extras) {
			expect(policies[namespace]?.guard, namespace).toBe("procedures");
			expect(classifiedCategories.get(namespace), namespace).toBe(
				"tenant-product",
			);
		}
	});

	it("matches the live router guard state exactly", async () => {
		const inventory = await guardInventory();
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

	it("never guards a procedure outside a fleet-commercial namespace", async () => {
		const inventory = await guardInventory();
		const strays = inventory
			.filter((entry) => entry.guarded && !(entry.namespace in policies))
			.map((entry) => `${entry.namespace}.${entry.name}`);
		expect(strays).toEqual([]);
	});
});
