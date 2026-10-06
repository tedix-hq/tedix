import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
	inspectCloudflareConfigImagesBinding,
	inspectImagesBinding,
} from "./wrangler-images-binding";

function fixture(path: string): string {
	return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

describe("inspectImagesBinding", () => {
	test("sees a binding declared with the repo's trailing-comma JSONC style", () => {
		// The regex this replaced (/"binding"\s*:\s*"IMAGES"\s*\}/) required the
		// closing brace to follow with only whitespace between, so the comma made
		// it report a declared binding as absent.
		const report = inspectImagesBinding(`{
	"name": "tedix-cms-runtime",
	"images": {
		"binding": "IMAGES",
	},
}`);
		expect(report.parseErrors).toEqual([]);
		expect(report.declaredAnywhere).toBe(true);
		expect(report.declaredEverywhere).toBe(true);
		expect(report.missingScopes).toEqual([]);
	});

	test("reads comments and the no-trailing-comma form the same way", () => {
		const report = inspectImagesBinding(`{
	// Parent-only native binding.
	"images": { "binding": "IMAGES" },
}`);
		expect(report.declaredEverywhere).toBe(true);
	});

	test("named environments are separate scopes and do not inherit", () => {
		// Wrangler named envs do not inherit top-level bindings, so a config that
		// declares IMAGES only at the top level ships --env production without it.
		// A flat text match over the whole file cannot see this at all.
		const report = inspectImagesBinding(`{
	"images": { "binding": "IMAGES" },
	"env": {
		"development": { "images": { "binding": "IMAGES" } },
		"production": { "vars": { "ENVIRONMENT": "production" } },
	},
}`);
		expect(report.declaredAnywhere).toBe(true);
		expect(report.declaredEverywhere).toBe(false);
		expect(report.missingScopes).toEqual(["env.production"]);
	});

	test("a renamed binding is reported, not silently counted", () => {
		const report = inspectImagesBinding(`{ "images": { "binding": "IMG" } }`);
		expect(report.declaredEverywhere).toBe(false);
		expect(report.scopes[0]?.declaredBindings).toEqual(["IMG"]);
	});

	test("absence in every scope is reported as absence", () => {
		const report = inspectImagesBinding(`{
	"name": "tenant-starter",
	"env": { "production": { "vars": {} } },
}`);
		expect(report.declaredAnywhere).toBe(false);
		expect(report.missingScopes).toEqual(["top-level", "env.production"]);
	});

	test("a malformed config reports parse errors instead of a bare false", () => {
		const report = inspectImagesBinding(`{ "images": { "binding": "IMAGES" `);
		expect(report.parseErrors.length).toBeGreaterThan(0);
	});

	test("cms-runtime declares IMAGES in every deployable mode", async () => {
		// The live contract behind the validator's cloudflare-binding check.
		const report = await inspectCloudflareConfigImagesBinding(
			fileURLToPath(
				new URL("../../cms-runtime/cloudflare.config.ts", import.meta.url),
			),
		);
		expect(report.parseErrors).toEqual([]);
		expect(report.missingScopes).toEqual([]);
		expect(report.declaredEverywhere).toBe(true);
		expect(report.scopes.map((scope) => scope.scope)).toEqual([
			"mode.development",
			"mode.production",
		]);
	});

	test("the tenant starter declares no images binding in any scope", () => {
		const report = inspectImagesBinding(
			fixture("../templates/tedix/wrangler.jsonc"),
		);
		expect(report.parseErrors).toEqual([]);
		expect(report.declaredAnywhere).toBe(false);
	});
});
