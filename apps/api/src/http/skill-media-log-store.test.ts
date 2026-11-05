import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	skillRunArtifacts,
	skillRuns,
	skillWorkflowSources,
} from "@tedix/db/schema/cognitive";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl, tableDdl } from "@tedix/db/test/schema-ddl";
import { Hono } from "hono";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { signMediaUrl } from "../lib/skill-media-url";
import { registerSkillMediaRoutes } from "./skill-media-routes";

const { validateToken } = vi.hoisted(() => ({ validateToken: vi.fn() }));
vi.mock("@tedix/auth/jwt", () => ({ validateToken }));

const mediaJson = JSON.stringify({
	value: { imageBase64: "SGVsbG8=", mimeType: "image/png" },
});
const storageCases = [
	{
		name: "inline JSON",
		mimeType: "application/json",
		contentInline: mediaJson,
		contentR2Key: null,
	},
	{
		name: "R2 JSON",
		mimeType: "application/json",
		contentInline: null,
		contentR2Key: "run-1/bodies/original-json",
	},
	{
		name: "R2 bytes",
		mimeType: "image/png",
		contentInline: null,
		contentR2Key: "run-1/outputs/original-image.media",
	},
];

describe("skill media from LOGS_DB", () => {
	let main: DatabaseSync;
	let logs: DatabaseSync;
	let env: CloudflareEnv;
	let app: Hono<{ Bindings: CloudflareEnv }>;
	let logsQueries: string[];
	let getObject: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		validateToken
			.mockReset()
			.mockResolvedValue({ sub: "user-1", dct: "tenant-1" });
		main = new DatabaseSync(":memory:");
		logs = new DatabaseSync(":memory:");
		main.exec("PRAGMA foreign_keys = OFF");
		main.exec(
			schemaDdl(
				organizations,
				organizationMembers,
				skillRuns,
				skillWorkflowSources,
				skillRunArtifacts,
			),
		);
		logs.exec(tableDdl(skillRunArtifacts, { foreignKeys: false }).join("\n"));
		logsQueries = [];
		getObject = vi.fn(
			async (key: string) =>
				new Response(key.endsWith("original-json") ? mediaJson : "Hello"),
		);
		env = {
			DB: createD1Facade(main),
			LOGS_DB: createD1Facade(logs, {
				onPrepare: (query) => logsQueries.push(query),
			}),
			ENVIRONMENT: "production",
			SECRETS_MASTER_KEY: "test-media-signing-key",
			SKILL_ARTIFACTS: { get: getObject },
		} as unknown as CloudflareEnv;
		const db = createDbClient(env.DB);
		await db.insert(organizations).values([
			{
				id: "org-1",
				name: "Media",
				slug: "media",
				descopeTenantId: "tenant-1",
			},
			{
				id: "org-2",
				name: "Other",
				slug: "other",
				descopeTenantId: "tenant-2",
			},
		]);
		await db.insert(skillRuns).values({
			id: "run-1",
			organizationId: "org-1",
			skillId: "skill-1",
			tediId: "tedi-1",
			workflowInstanceId: "workflow-1",
			runtimeEnvironment: "production",
			status: "completed",
		});
		app = new Hono<{ Bindings: CloudflareEnv }>();
		registerSkillMediaRoutes(app);
	});

	afterEach(() => {
		main.close();
		logs.close();
	});

	async function seedMovedArtifact(storage = storageCases[0]!) {
		await createDbClient(env.LOGS_DB).insert(skillRunArtifacts).values({
			id: "artifact-1",
			runId: "run-1",
			path: "outputs/image.json",
			mimeType: storage.mimeType,
			contentInline: storage.contentInline,
			contentR2Key: storage.contentR2Key,
			sizeBytes: 5,
		});
		expect(
			main.prepare("SELECT count(*) AS count FROM skill_run_artifacts").get(),
		).toEqual({ count: 0 });
		logsQueries.length = 0;
	}

	async function request(route: string) {
		if (route === "signed") {
			const { url } = await signMediaUrl({
				baseUrl: "https://media.example.test",
				secret: env.SECRETS_MASTER_KEY,
				runId: "run-1",
				path: "outputs/image.json",
				nowMs: Date.now(),
			});
			return app.request(url, undefined, env);
		}
		return app.request(
			"https://api.example.test/skill-runs/run-1/media/outputs/image.json",
			{ headers: { Cookie: "DS=session-1" } },
			env,
		);
	}

	for (const route of ["signed", "session", "session redirect"]) {
		it.each(storageCases)(
			`${route} serves $name absent from main`,
			async (storage) => {
				await seedMovedArtifact(storage);
				if (route === "session redirect")
					env.UNTRUSTED_CONTENT_ORIGIN = "https://media.example.test";
				let response = await request(route);
				if (route === "session redirect") {
					expect(response.status).toBe(302);
					const location = response.headers.get("Location")!;
					expect(new URL(location).origin).toBe("https://media.example.test");
					response = await app.request(location, undefined, env);
				}
				expect(response.status).toBe(200);
				expect(response.headers.get("Content-Type")).toBe("image/png");
				expect(response.headers.get("Content-Length")).toBe("5");
				expect(await response.text()).toBe("Hello");
				expect(
					logsQueries.some((query) => query.includes('"skill_run_artifacts"')),
				).toBe(true);
				if (storage.contentR2Key)
					expect(getObject).toHaveBeenCalledExactlyOnceWith(
						storage.contentR2Key,
					);
				else expect(getObject).not.toHaveBeenCalled();
				expect(
					logs.prepare("SELECT content_r2_key FROM skill_run_artifacts").get(),
				).toEqual({ content_r2_key: storage.contentR2Key });
			},
		);
	}

	it("rejects invalid and expired signed tokens before reading logs", async () => {
		await seedMovedArtifact();
		const { url } = await signMediaUrl({
			baseUrl: "https://media.example.test",
			secret: env.SECRETS_MASTER_KEY,
			runId: "run-1",
			path: "outputs/image.json",
			nowMs: Date.now() - 60_000,
			ttlSeconds: 1,
		});
		expect((await app.request(url, undefined, env)).status).toBe(403);
		const invalid = new URL(url);
		invalid.searchParams.set(
			"exp",
			String(Math.floor(Date.now() / 1000) + 300),
		);
		expect((await app.request(invalid, undefined, env)).status).toBe(403);
		expect(logsQueries).toEqual([]);
	});

	it("requires a valid session before reading logs", async () => {
		await seedMovedArtifact();
		expect(
			(
				await app.request(
					"/skill-runs/run-1/media/outputs/image.json",
					undefined,
					env,
				)
			).status,
		).toBe(401);
		validateToken.mockRejectedValueOnce(new Error("invalid session"));
		expect((await request("session")).status).toBe(401);
		expect(logsQueries).toEqual([]);
	});

	it("enforces run ownership and environment before reading logs or redirecting", async () => {
		await seedMovedArtifact();
		env.UNTRUSTED_CONTENT_ORIGIN = "https://media.example.test";
		validateToken.mockResolvedValueOnce({ sub: "user-2", dct: "tenant-2" });
		expect((await request("session")).status).toBe(404);
		env.ENVIRONMENT = "staging";
		expect((await request("session")).status).toBe(404);
		expect(logsQueries).toEqual([]);
	});

	it("rejects a tenant override without membership before reading logs", async () => {
		await seedMovedArtifact();
		validateToken.mockResolvedValueOnce({ sub: "user-2", dct: "tenant-2" });
		const response = await app.request(
			"/skill-runs/run-1/media/outputs/image.json",
			{
				headers: {
					Authorization: "Bearer session-2",
					"X-Tedix-Tenant-Id": "tenant-1",
				},
			},
			env,
		);
		expect(response.status).toBe(403);
		expect(logsQueries).toEqual([]);
	});

	it("still serves main artifacts without a logs binding", async () => {
		await createDbClient(env.DB).insert(skillRunArtifacts).values({
			id: "artifact-main",
			runId: "run-1",
			path: "outputs/image.json",
			contentInline: mediaJson,
		});
		const { LOGS_DB: _logs, ...mainOnly } = env;
		env = mainOnly as CloudflareEnv;
		for (const route of ["signed", "session"]) {
			const response = await request(route);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("Hello");
		}
	});
});
