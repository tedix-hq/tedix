import { describe, expect, it } from "vite-plus/test";
import { SYSTEM_PROMPT } from "./route-planner";
import { HOME_EFFORT_CLASSES, HOME_ROUTE_KINDS } from "./route-schema";
import {
	computeRouterVersion,
	getRouterVersion,
	ROUTER_CONTRACT_REV,
	serializeRouteSchemaShape,
} from "./router-version";

const HEX_12 = /^[0-9a-f]{12}$/;

const BASE_INPUTS = {
	contractRev: ROUTER_CONTRACT_REV,
	systemPrompt: SYSTEM_PROMPT,
	schemaShape: serializeRouteSchemaShape(),
};

describe("serializeRouteSchemaShape", () => {
	it("is stable across calls and covers enums + decision field names", () => {
		const shape = serializeRouteSchemaShape();
		expect(serializeRouteSchemaShape()).toBe(shape);

		const parsed = JSON.parse(shape) as {
			routeKinds: string[];
			effortClasses: string[];
			fields: string[];
		};
		expect(parsed.routeKinds).toEqual([...HOME_ROUTE_KINDS]);
		expect(parsed.effortClasses).toEqual([...HOME_EFFORT_CLASSES]);
		// Sorted top-level field names — reorder-insensitive, rename-sensitive.
		expect(parsed.fields).toEqual([...parsed.fields].sort());
		expect(parsed.fields).toContain("routeKind");
		expect(parsed.fields).toContain("effortClass");
		expect(parsed.fields).toContain("rationale");
		// The stamp itself must never be part of the model-facing schema shape.
		expect(parsed.fields).not.toContain("routerVersion");
	});
});

describe("computeRouterVersion", () => {
	it("returns a deterministic 12-hex hash for identical inputs", async () => {
		const a = await computeRouterVersion(BASE_INPUTS);
		const b = await computeRouterVersion({ ...BASE_INPUTS });
		expect(a).toMatch(HEX_12);
		expect(b).toBe(a);
	});

	it("changes when the system prompt text changes", async () => {
		const base = await computeRouterVersion(BASE_INPUTS);
		const edited = await computeRouterVersion({
			...BASE_INPUTS,
			systemPrompt: `${SYSTEM_PROMPT}\n- New routing rule.`,
		});
		expect(edited).toMatch(HEX_12);
		expect(edited).not.toBe(base);
	});

	it("changes when the schema shape changes (e.g. a new route kind)", async () => {
		const base = await computeRouterVersion(BASE_INPUTS);
		const grown = await computeRouterVersion({
			...BASE_INPUTS,
			schemaShape: JSON.stringify({
				routeKinds: [...HOME_ROUTE_KINDS, "escalate_to_board"],
				effortClasses: [...HOME_EFFORT_CLASSES],
				fields: ["routeKind"],
			}),
		});
		expect(grown).not.toBe(base);
	});

	it("changes when ROUTER_CONTRACT_REV is bumped", async () => {
		const base = await computeRouterVersion(BASE_INPUTS);
		const bumped = await computeRouterVersion({
			...BASE_INPUTS,
			contractRev: ROUTER_CONTRACT_REV + 1,
		});
		expect(bumped).not.toBe(base);
	});

	it("is boundary-unambiguous — moving text across the prompt/schema separator changes the hash", async () => {
		const a = await computeRouterVersion({
			contractRev: 1,
			systemPrompt: "alpha",
			schemaShape: "betagamma",
		});
		const b = await computeRouterVersion({
			contractRev: 1,
			systemPrompt: "alphabeta",
			schemaShape: "gamma",
		});
		expect(a).not.toBe(b);
	});
});

describe("getRouterVersion", () => {
	it("returns the cached current-contract hash, stable across calls", async () => {
		const first = await getRouterVersion(SYSTEM_PROMPT);
		const second = await getRouterVersion(SYSTEM_PROMPT);
		expect(first).toMatch(HEX_12);
		expect(second).toBe(first);
		// Wired over the REAL inputs (prompt + schema shape + contract rev).
		expect(first).toBe(await computeRouterVersion(BASE_INPUTS));
	});
});
