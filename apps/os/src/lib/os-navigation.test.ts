import routeSource from "../routeTree.gen.ts?raw";
import { describe, expect, test } from "vite-plus/test";
import {
	OS_NAVIGATION,
	OS_SURFACE_IDS,
	OS_PAGES,
	osPageParents,
	matchOsPage,
} from "./os-navigation";
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

const routePaths = [
	...new Set(
		[...routeSource.matchAll(/fullPath: '([^']+)'/g)].map(
			(match) => match[1]!.replace(/\/$/, "") || "/",
		),
	),
];

describe("OS page table integrity", () => {
	test("uses unique ids and paths with valid, acyclic parents", () => {
		expect(new Set(OS_PAGES.map((page) => page.id)).size).toBe(OS_PAGES.length);
		expect(new Set(OS_PAGES.map((page) => page.path)).size).toBe(
			OS_PAGES.length,
		);
		for (const page of OS_PAGES) {
			const seen = new Set([page.id]);
			let parentId = page.parentId;
			while (parentId) {
				expect(seen.has(parentId), page.id).toBe(false);
				seen.add(parentId);
				const parent = OS_PAGES.find((candidate) => candidate.id === parentId);
				expect(parent, page.id).toBeDefined();
				parentId = parent?.parentId;
			}
			expect(osPageParents(page).at(-1)).toBe(page);
		}
	});
	test("matches real file routes in both directions", () => {
		for (const page of OS_PAGES)
			expect(routePaths, page.id).toContain(page.path);
		for (const path of routePaths) {
			expect(
				OS_PAGES.some((page) => page.path === path),
				path,
			).toBe(true);
			const sample = path.replace(/\$[A-Za-z]+/g, "sample-id");
			expect(matchOsPage(sample)?.page.path, path).toBe(path);
		}
	});
});
