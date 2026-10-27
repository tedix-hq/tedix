import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema/organizations";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	getConnectionConsumerGrants,
	setConnectionConsumerGrants,
} from "@tedix/db/queries/organizations";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { resolveCredentialChain } from "./connections/policy-resolution";
import type { BaseContext } from "../orpc";

vi.mock("@tedix/db/queries/skill-runs", () => ({ getSkillRun: vi.fn() }));
vi.mock("@tedix/db/queries/connection-providers", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/connection-providers")
	>()),
	getConnectionProviderByDescopeAppId: vi.fn(async () => ({ id: "example" })),
}));

const tediId = "00000000-0000-4000-8000-000000000001";
const skillId = "00000000-0000-4000-8000-000000000002";
const instanceId = "00000000-0000-4000-8000-000000000003";
const denied = { mode: "selected" as const, tediIds: [], skills: [] };
const args = {
	organizationId: "org-1",
	descopeTenantId: "tenant-1",
	providerId: "example",
	scope: "tenant" as const,
};
const databases: DatabaseSync[] = [];
async function setup() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(schemaDdl(organizations));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizations).values([
		{
			id: "org-1",
			name: "Example",
			slug: "example",
			metadata: { industryVertical: "test" },
		},
		{ id: "org-2", name: "Other", slug: "other" },
	]);
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async () =>
			Response.json({ token: { accessToken: "opaque" } }),
		);
	const context = {
		authType: "service-binding",
		db,
		env: {
			DESCOPE_PROJECT_ID: "P1",
			DESCOPE_MANAGEMENT_KEY: "K1",
			ENVIRONMENT: "test",
		},
		tediId,
		headers: new Headers(),
	} as unknown as BaseContext;
	return { context, db, fetch };
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(getSkillRun).mockReset();
	for (const db of databases.splice(0)) db.close();
});

describe("organization connection consumer grants", () => {
	it("defaults to all and keeps other metadata, organizations and accounts isolated", async () => {
		const { db } = await setup();
		expect(await getConnectionConsumerGrants(db, "org-1", "example")).toEqual({
			mode: "all",
		});
		await setConnectionConsumerGrants(
			db,
			"org-1",
			"example",
			denied,
			instanceId,
		);
		expect(
			await getConnectionConsumerGrants(db, "org-1", "example", instanceId),
		).toEqual(denied);
		expect(
			await getConnectionConsumerGrants(db, "org-2", "example", instanceId),
		).toEqual({ mode: "all" });
		expect(await getConnectionConsumerGrants(db, "org-1", "example")).toEqual({
			mode: "all",
		});
		const [row] = await db.select().from(organizations);
		expect(row.metadata?.industryVertical).toBe("test");
	});
	it("serves unrestricted credentials", async () => {
		const { context } = await setup();
		await expect(resolveCredentialChain(context, args)).resolves.toMatchObject({
			accessToken: "opaque",
		});
	});
	it.each([{}, { label: "project" }, { connectionInstanceId: instanceId }])(
		"denies before touching the vault, including label and account paths %j",
		async (selection) => {
			const { context, db, fetch } = await setup();
			await setConnectionConsumerGrants(db, "org-1", "example", denied);
			await expect(
				resolveCredentialChain(context, { ...args, ...selection }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining("Not granted for this connection"),
			});
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it("admits a named tedi and applies revocation on the next call", async () => {
		const { context, db, fetch } = await setup();
		await setConnectionConsumerGrants(db, "org-1", "example", {
			...denied,
			tediIds: [tediId],
		});
		await expect(resolveCredentialChain(context, args)).resolves.toMatchObject({
			accessToken: "opaque",
		});
		fetch.mockClear();
		await setConnectionConsumerGrants(db, "org-1", "example", denied);
		await expect(resolveCredentialChain(context, args)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each([
		{ revision: 2, runTedi: tediId, status: "running", allowed: true },
		{ revision: 3, runTedi: tediId, status: "running", allowed: false },
		{ revision: 2, runTedi: "other", status: "running", allowed: false },
		{ revision: 2, runTedi: tediId, status: "completed", allowed: false },
	])(
		"uses the exact persisted active skill revision %j",
		async ({ revision, runTedi, status, allowed }) => {
			const { context, db, fetch } = await setup();
			context.headers.set("X-Tedix-Skill-Run-Id", "run-1");
			vi.mocked(getSkillRun).mockResolvedValue({
				skillId,
				skillRevision: revision,
				tediId: runTedi,
				status,
			} as Awaited<ReturnType<typeof getSkillRun>>);
			await setConnectionConsumerGrants(db, "org-1", "example", {
				...denied,
				skills: [{ id: skillId, revision: 2 }],
			});
			if (allowed)
				await expect(
					resolveCredentialChain(context, args),
				).resolves.toMatchObject({ accessToken: "opaque" });
			else {
				await expect(
					resolveCredentialChain(context, args),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				expect(fetch).not.toHaveBeenCalled();
			}
		},
	);
	it("does not accept a skill header without an authenticated tedi", async () => {
		const { context, db } = await setup();
		context.tediId = undefined;
		context.headers.set("X-Tedix-Skill-Run-Id", "run-1");
		await setConnectionConsumerGrants(db, "org-1", "example", {
			...denied,
			skills: [{ id: skillId, revision: 2 }],
		});
		await expect(resolveCredentialChain(context, args)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(getSkillRun).not.toHaveBeenCalled();
	});
	it("does not trust skill-run headers on direct tedi requests", async () => {
		const { context, db } = await setup();
		context.authType = "tedi";
		context.headers.set("X-Tedix-Skill-Run-Id", "run-1");
		await setConnectionConsumerGrants(db, "org-1", "example", {
			...denied,
			skills: [{ id: skillId, revision: 2 }],
		});
		await expect(resolveCredentialChain(context, args)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(getSkillRun).not.toHaveBeenCalled();
	});
	it("enforces the actual labeled provider's policy as well as the requested provider", async () => {
		const { context, db, fetch } = await setup();
		await setConnectionConsumerGrants(db, "org-1", "example-project", denied);
		await expect(
			resolveCredentialChain(context, { ...args, label: "project" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fetch).not.toHaveBeenCalled();
	});
	it("fails closed when stored configuration is invalid", async () => {
		const { context, db, fetch } = await setup();
		await db.update(organizations).set({
			metadata: {
				connectionConsumerGrants: { "example:": { mode: "unknown" } },
			} as never,
		});
		await expect(resolveCredentialChain(context, args)).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("keeps provider keys containing JSON path syntax separate", async () => {
		const { db } = await setup();
		const providerId = 'example."other"';
		await setConnectionConsumerGrants(db, "org-1", providerId, denied);
		expect(await getConnectionConsumerGrants(db, "org-1", providerId)).toEqual(
			denied,
		);
		expect(await getConnectionConsumerGrants(db, "org-1", "example")).toEqual({
			mode: "all",
		});
	});

	it("does not let an unrestricted provider override a restricted named account", async () => {
		const { context, db, fetch } = await setup();
		await setConnectionConsumerGrants(
			db,
			"org-1",
			"example",
			denied,
			instanceId,
		);
		await expect(
			resolveCredentialChain(context, {
				...args,
				connectionInstanceId: instanceId,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fetch).not.toHaveBeenCalled();
	});
});
