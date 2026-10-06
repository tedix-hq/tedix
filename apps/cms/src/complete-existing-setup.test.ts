import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
// @ts-expect-error Pinned native repository chunks have no declarations.
import { t as OptionsRepository } from "../templates/tedix/node_modules/emdash/dist/options-DhrI7eMv.mjs";
// @ts-expect-error Pinned native completion chunk has no declarations.
import { n as finalizeSetup } from "../templates/tedix/node_modules/emdash/dist/setup-complete-B2_dhZZz.mjs";
// @ts-expect-error Pinned native repository chunks have no declarations.
import { t as ContentRepository } from "../templates/tedix/node_modules/emdash/dist/content-Dji9vEiW.mjs";
// @ts-expect-error Pinned native repository chunks have no declarations.
import { n as SchemaRegistry } from "../templates/tedix/node_modules/emdash/dist/registry-DaXmUsD4.mjs";
import { createDialect } from "emdash/db/sqlite";
import { runMigrations } from "emdash/db";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
// Resolve the route's public package entry, regardless of nested/hoisted installs.
const route = new URL(
	"../templates/tedix/src/pages/_emdash/api/tedix/complete-existing-setup.ts",
	import.meta.url,
);
const { Kysely } = await import(createRequire(route).resolve("kysely"));
vi.doMock(createRequire(route).resolve("emdash"), () => ({
	ContentRepository,
	SchemaRegistry,
}));
vi.doMock(createRequire(route).resolve("emdash/api/route-utils"), () => ({
	OptionsRepository,
	finalizeSetup,
	apiError: (code: string, message: string, status: number) =>
		Response.json({ success: false, error: { code, message } }, { status }),
	apiSuccess: (data: unknown) => Response.json({ success: true, data }),
	handleError: (_error: unknown, message: string, code: string) =>
		Response.json(
			{ success: false, error: { code, message } },
			{ status: 500 },
		),
}));
const { POST } =
	await import("../templates/tedix/src/pages/_emdash/api/tedix/complete-existing-setup");
let directory: string;
let database: any;
function request(role?: 40 | 50, configured = true) {
	return POST({
		locals: {
			user: role ? { id: "existing-user", role } : undefined,
			emdash: configured ? { db: database } : undefined,
		},
	} as never);
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "tedix-native-onboarding-"));
	const url = `file:${join(directory, "site.db")}`;
	database = new Kysely({ dialect: createDialect({ url }) });
	await runMigrations(database);
});
afterEach(async () => {
	await database?.destroy();
	await rm(directory, { recursive: true, force: true });
});

async function collection() {
	const registry = new SchemaRegistry(database);
	await registry.createCollection({
		slug: "pages",
		label: "Pages",
	});
	await registry.createField("pages", {
		slug: "title",
		label: "Title",
		type: "string",
	});
}

describe("existing-site native onboarding completion", () => {
	it("requires native administrator permission", async () => {
		expect((await request()).status).toBe(401);
		expect((await request(40)).status).toBe(403);
		expect(
			await new OptionsRepository(database).get("emdash:setup_complete"),
		).toBeNull();
	});
	it("refuses missing database and any unfinished wizard state", async () => {
		expect((await request(50, false)).status).toBe(503);
		const options = new OptionsRepository(database);
		for (const state of [{ title: "Marketing" }, {}, false, ""]) {
			await options.set("emdash:setup_state", state);
			expect((await request(50)).status).toBe(409);
			expect(await options.get("emdash:setup_complete")).toBeNull();
		}
		await options.set("emdash:setup_complete", true);
		expect((await request(50)).status).toBe(409);
	});
	it("refuses native fresh sites without collections or entries", async () => {
		expect(await new SchemaRegistry(database).listCollections()).toEqual([]);
		expect((await request(50)).status).toBe(409);
		await collection();
		expect(await new ContentRepository(database).count("pages")).toBe(0);
		expect((await request(50)).status).toBe(409);
		expect(
			await new OptionsRepository(database).get("emdash:setup_complete"),
		).toBeNull();
	});
	it("uses native finalizeSetup and preserves existing content, settings and users", async () => {
		await collection();
		const content = new ContentRepository(database);
		const created = await content.create({
			type: "pages",
			data: { title: "Existing published content" },
			status: "published",
		});
		const options = new OptionsRepository(database);
		await options.set("emdash:site_title", "Tedix");
		await options.set("emdash:site_tagline", "Actual tagline");
		const before = await content.findById("pages", created.id);
		const usersBefore = await database
			.selectFrom("users")
			.selectAll()
			.execute();
		expect(await (await request(50)).json()).toEqual({
			success: true,
			data: { setupComplete: true, alreadyComplete: false },
		});
		expect(await options.get("emdash:setup_complete")).toBe(true);
		expect(await options.get("emdash:setup_state")).toBeNull();
		expect(await options.get("emdash:site_title")).toBe("Tedix");
		expect(await options.get("emdash:site_tagline")).toBe("Actual tagline");
		expect(await content.findById("pages", created.id)).toEqual(before);
		expect(await database.selectFrom("users").selectAll().execute()).toEqual(
			usersBefore,
		);
		expect(await (await request(50)).json()).toEqual({
			success: true,
			data: { setupComplete: true, alreadyComplete: true },
		});
	});
	it("fails closed when the native database is unavailable", async () => {
		await database.destroy();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect((await request(50)).status).toBe(500);
		} finally {
			errors.mockRestore();
		}
	});
});
