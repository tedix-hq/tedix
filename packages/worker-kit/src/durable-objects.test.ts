import { describe, expect, it } from "vite-plus/test";
import {
	durableObjectIdFromName,
	durableObjectIdFromString,
	durableObjectNamespace,
	durableObjectNewUniqueId,
	durableObjectStubByName,
	readDurableObjectJurisdiction,
} from "./durable-objects";

type FakeId = { id: string; jurisdiction?: string };

function fakeNamespace(jurisdiction?: string) {
	const calls: string[] = [];
	const ns = {
		calls,
		jurisdiction(value: string) {
			calls.push(`jurisdiction:${value}`);
			return fakeNamespace(value);
		},
		idFromName(name: string): FakeId {
			calls.push(`idFromName:${name}`);
			return { id: `id:${name}`, jurisdiction };
		},
		idFromString(id: string): FakeId {
			calls.push(`idFromString:${id}`);
			return { id, jurisdiction };
		},
		newUniqueId(): FakeId {
			calls.push("newUniqueId");
			return { id: "unique", jurisdiction };
		},
		get(id: FakeId) {
			calls.push(`get:${id.id}`);
			return { stub: `stub:${id.id.slice(3)}`, jurisdiction: id.jurisdiction };
		},
	};
	return ns;
}

describe("readDurableObjectJurisdiction", () => {
	it("returns undefined for missing, null and empty values", () => {
		expect(readDurableObjectJurisdiction({})).toBeUndefined();
		expect(readDurableObjectJurisdiction(undefined)).toBeUndefined();
		expect(readDurableObjectJurisdiction(null)).toBeUndefined();
		expect(
			readDurableObjectJurisdiction({ DO_JURISDICTION: "" }),
		).toBeUndefined();
	});
	it("returns configured jurisdictions and rejects invalid values", () => {
		expect(readDurableObjectJurisdiction({ DO_JURISDICTION: "eu" })).toBe("eu");
		expect(readDurableObjectJurisdiction({ DO_JURISDICTION: "us" })).toBe("us");
		expect(() =>
			readDurableObjectJurisdiction({ DO_JURISDICTION: "moon" }),
		).toThrow(/Invalid DO_JURISDICTION/);
	});
});

describe("durableObjectNamespace", () => {
	it("returns the binding unchanged when jurisdiction is unset", () => {
		const ns = fakeNamespace();
		expect(durableObjectNamespace(ns, {})).toBe(ns);
		expect(ns.calls).toEqual([]);
	});
	it("selects the configured jurisdiction exactly once", () => {
		const ns = fakeNamespace();
		const scoped = durableObjectNamespace(ns, { DO_JURISDICTION: "eu" });
		expect(scoped).not.toBe(ns);
		expect(ns.calls).toEqual(["jurisdiction:eu"]);
	});
	it("throws when the binding cannot apply the configured jurisdiction", () => {
		expect(() =>
			durableObjectNamespace({} as never, { DO_JURISDICTION: "eu" }),
		).toThrow(/does not support jurisdiction/);
	});
});

describe("addressing helpers", () => {
	it("idFromName uses the jurisdiction-selected namespace", () => {
		const ns = fakeNamespace();
		const id = durableObjectIdFromName(ns, { DO_JURISDICTION: "eu" }, "tenant");
		expect(id).toEqual({ id: "id:tenant", jurisdiction: "eu" });
		expect(ns.calls).toEqual(["jurisdiction:eu"]);
	});
	it("getByName uses the jurisdiction-selected namespace", () => {
		const ns = fakeNamespace();
		const stub = durableObjectStubByName(
			ns,
			{ DO_JURISDICTION: "eu" },
			"tenant",
		);
		expect(stub).toEqual({ stub: "stub:tenant", jurisdiction: "eu" });
	});
	it("newUniqueId and idFromString use the jurisdiction-selected namespace", () => {
		const ns = fakeNamespace();
		expect(durableObjectNewUniqueId(ns, { DO_JURISDICTION: "eu" })).toEqual({
			id: "unique",
			jurisdiction: "eu",
		});
		expect(
			durableObjectIdFromString(ns, { DO_JURISDICTION: "eu" }, "abc"),
		).toEqual({ id: "abc", jurisdiction: "eu" });
	});
	it("keeps global ids stable when jurisdiction is unset", () => {
		const ns = fakeNamespace();
		expect(durableObjectIdFromName(ns, {}, "tenant")).toEqual({
			id: "id:tenant",
			jurisdiction: undefined,
		});
		expect(durableObjectStubByName(ns, {}, "tenant")).toEqual({
			stub: "stub:tenant",
			jurisdiction: undefined,
		});
	});
});
