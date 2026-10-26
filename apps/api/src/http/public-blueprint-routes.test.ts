import { DatabaseSync } from "node:sqlite";
import {
	osBlueprintRevisions,
	osBlueprints,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { registerPublicBlueprintRoutes } from "./public-blueprint-routes";

function app(allow: boolean | undefined) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);",
	);
	sqlite.exec(schemaDdl(osBlueprints, osBlueprintRevisions));
	const keys: string[] = [];
	const env = {
		DB: createD1Facade(sqlite),
		API_RATE_LIMITER:
			allow === undefined
				? undefined
				: {
						limit: async ({ key }: { key: string }) => {
							keys.push(key);
							return { success: allow };
						},
					},
	} as unknown as CloudflareEnv;
	const hono = new Hono<{ Bindings: CloudflareEnv }>();
	registerPublicBlueprintRoutes(hono);
	return {
		keys,
		get: (path: string) =>
			hono.request(
				path,
				{ headers: { "CF-Connecting-IP": "203.0.113.7" } },
				env,
			),
	};
}

const MISSING = "/public/blueprints/0d000000-0000-4000-8000-0000000000ff";

describe("public blueprint route", () => {
	it("is rate-limited per client IP before any read", async () => {
		const limited = app(false);
		const response = await limited.get(MISSING);
		expect(response.status).toBe(429);
		expect(limited.keys).toEqual(["203.0.113.7"]);
	});

	it("fails closed when the limiter is not bound", async () => {
		expect((await app(undefined).get(MISSING)).status).toBe(503);
	});

	it("answers an unknown blueprint with a plain 404", async () => {
		const open = app(true);
		const response = await open.get(MISSING);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not found" });
	});
});
