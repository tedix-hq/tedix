import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { deployValues } from "./index";

// Fictional values only; real ones live outside this repository.
const values = {
	schemaVersion: 1,
	account: { id: "account-example" },
	workers: { api: "api-example" },
	d1: { core: { id: "d1-id-example", name: "core-example" } },
	kv: { cache: { id: "kv-id-example" } },
	r2: { jurisdiction: "eu", buckets: { media: "media-example" } },
	hostnames: { api: "api.example.test" },
	routes: { api: [{ pattern: "api.example.test/*", zone: "example.test" }] },
	domains: { os: ["app.example.test"] },
	vars: {
		shared: { LOG_LEVEL: "info", REGION: "eu" },
		api: { LOG_LEVEL: "debug" },
	},
	someFutureKey: { ignored: true },
};
const inline = JSON.stringify(values);

describe("deployValues", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
	});

	it("returns fallbacks when the variable is not set", () => {
		const live = deployValues({ mode: "production", env: {} });
		expect(live.active).toBe(false);
		expect(live.account("placeholder")).toBe("placeholder");
		expect(live.d1("core", { id: "p", name: "n" })).toEqual({
			id: "p",
			name: "n",
		});
		expect(live.vars("api", "LOG_LEVEL", "warn")).toBe("warn");
	});

	it("returns fallbacks outside production even when values are set", () => {
		const live = deployValues({
			mode: "development",
			env: { TEDIX_DEPLOY_VALUES: inline },
		});
		expect(live.active).toBe(false);
		expect(live.worker("api", "api")).toBe("api");
		expect(live.worker("missing", "fallback")).toBe("fallback");
	});

	it("reads inline JSON in production", () => {
		const live = deployValues({
			mode: "production",
			env: { TEDIX_DEPLOY_VALUES: inline },
		});
		expect(live.active).toBe(true);
		expect(live.account("p")).toBe("account-example");
		expect(live.worker("api", "p")).toBe("api-example");
		expect(live.d1("core", { id: "p", name: "p" })).toEqual(values.d1.core);
		expect(live.kv("cache", "p")).toBe("kv-id-example");
		expect(live.r2("media", { name: "p" })).toEqual({
			name: "media-example",
			jurisdiction: "eu",
		});
		expect(live.host("api", "p")).toBe("api.example.test");
		expect(live.routes("api", [])).toEqual(values.routes.api);
		expect(live.domains("os", [])).toEqual(["app.example.test"]);
	});

	it("reads a values file by absolute path", () => {
		const dir = mkdtempSync(join(tmpdir(), "deploy-values-"));
		tempDirs.push(dir);
		const file = join(dir, "values.json");
		writeFileSync(file, inline);
		const live = deployValues({
			mode: "production",
			env: { TEDIX_DEPLOY_VALUES: file },
		});
		expect(live.account("p")).toBe("account-example");
	});

	it("throws for a missing key instead of falling back", () => {
		const live = deployValues({
			mode: "production",
			env: { TEDIX_DEPLOY_VALUES: inline },
		});
		expect(() => live.worker("os", "os")).toThrow(/missing key "workers\.os"/);
		expect(() => live.d1("logs", { id: "p", name: "p" })).toThrow(
			/missing key "d1\.logs\.id"/,
		);
		expect(() => live.vars("api", "NOPE", "x")).toThrow(
			/vars\.api\.NOPE.*vars\.shared\.NOPE/,
		);
	});

	it("prefers surface vars over shared vars", () => {
		const live = deployValues({
			mode: "production",
			env: { TEDIX_DEPLOY_VALUES: inline },
		});
		expect(live.vars("api", "LOG_LEVEL", "x")).toBe("debug");
		expect(live.vars("api", "REGION", "x")).toBe("eu");
		expect(live.vars("os", "LOG_LEVEL", "x")).toBe("info");
	});

	it("rejects an unknown schemaVersion", () => {
		expect(() =>
			deployValues({
				mode: "production",
				env: {
					TEDIX_DEPLOY_VALUES: JSON.stringify({ ...values, schemaVersion: 2 }),
				},
			}),
		).toThrow(/schemaVersion must be 1, got 2/);
	});

	it("rejects a relative path", () => {
		expect(() =>
			deployValues({
				mode: "production",
				env: { TEDIX_DEPLOY_VALUES: "values.json" },
			}),
		).toThrow(/absolute file path/);
	});
});
