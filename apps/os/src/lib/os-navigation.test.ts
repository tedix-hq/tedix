import { describe, expect, test } from "vite-plus/test";
import { OS_NAVIGATION, OS_SURFACE_IDS } from "./os-navigation";
import { resolveOsTenant } from "@/shared/os-tenant";

describe("Tedix OS navigation", () => {
	test("keeps Activity as the default surface", () => {
		expect(OS_NAVIGATION[0]).toMatchObject({ id: "work", path: "/work" });
		expect(OS_NAVIGATION.map(({ id }) => id)).toEqual(OS_SURFACE_IDS);
	});

	test("uses unique ids and paths", () => {
		expect(new Set(OS_NAVIGATION.map(({ id }) => id)).size).toBe(
			OS_NAVIGATION.length,
		);
		expect(new Set(OS_NAVIGATION.map(({ path }) => path)).size).toBe(
			OS_NAVIGATION.length,
		);
	});
});

describe("Tedix OS tenant routing", () => {
	test("resolves exact managed tenant hosts", () => {
		expect(resolveOsTenant("acme.os.tedix.dev")).toEqual({
			kind: "tenant",
			slug: "acme",
		});
	});

	test("keeps the root launcher distinct from tenant state", () => {
		expect(resolveOsTenant("os.tedix.dev")).toEqual({ kind: "launcher" });
	});

	test("resolves the explicit shared-production development surface", () => {
		expect(resolveOsTenant("os.tedix.tech")).toEqual({ kind: "launcher" });
		expect(resolveOsTenant("acme.os.tedix.tech")).toEqual({
			kind: "tenant",
			slug: "acme",
		});
	});

	test("rejects unrelated and malformed hosts", () => {
		expect(resolveOsTenant("app.tedix.dev")).toEqual({ kind: "invalid" });
		expect(resolveOsTenant("-bad.os.tedix.dev")).toEqual({ kind: "invalid" });
		expect(resolveOsTenant("nested.tenant.os.tedix.tech")).toEqual({
			kind: "invalid",
		});
		expect(resolveOsTenant("os.attacker.tech")).toEqual({ kind: "invalid" });
	});
});
