import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import {
	getConnectionConsumerGrants,
	setConnectionConsumerGrants,
} from "@tedix/db/queries/organizations";
import {
	getPersonalConnectionConsumerGrants,
	setPersonalConnectionConsumerGrants,
} from "@tedix/db/queries/personal-connection-grants";
import { respondToWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import type { ConnectionConsumerGrants } from "@tedix/api-contract/schemas/connections";
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
createMigratedSqlite().close();
function fixture(scope: "user" | "tenant" = "user") {
	const sqlite = createMigratedSqlite();
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('org-1','Example','example'),('org-2','Other','other');
 INSERT INTO users(id,email) VALUES('owner','owner@example.test'),('other','other@example.test');
 INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status,role) VALUES
 ('member-1','org-1','owner-sub','owner','owner@example.test','active','owner'),
 ('member-2','org-1','other-sub','other','other@example.test','active','member');`);
	sqlite
		.prepare(
			"INSERT INTO tedis(id,organization_id,name,slug,owner_user_id) VALUES(?,'org-1','Research','research','owner-sub')",
		)
		.run(tediId);
	sqlite
		.prepare(
			"INSERT INTO skill_entries(id,organization_id,title,content,revision) VALUES(?,'org-1','Research sources','Read sources',2)",
		)
		.run(skillId);
	const db = createDbClient(createD1Facade(sqlite));
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async () =>
			Response.json({ token: { accessToken: "opaque" } }),
		);
	const context = {
		authType: "service-binding",
		organizationId: "org-1",
		db,
		env: {
			DESCOPE_PROJECT_ID: "P1",
			DESCOPE_MANAGEMENT_KEY: "K1",
			ENVIRONMENT: "test",
		},
		tediId,
		headers: new Headers(),
	} as unknown as BaseContext;
	const args = {
		organizationId: "org-1",
		descopeTenantId: "tenant-1",
		providerId: "example",
		scope,
		ownerUserId: "owner-sub",
	};
	const set = (
		policy: ConnectionConsumerGrants = denied,
		account?: string,
		provider = "example",
	) =>
		scope === "user"
			? setPersonalConnectionConsumerGrants(
					db,
					"owner",
					"org-1",
					provider,
					policy,
					account,
				)
			: setConnectionConsumerGrants(db, "org-1", provider, policy, account);
	const read = (account?: string) =>
		scope === "user"
			? getPersonalConnectionConsumerGrants(
					db,
					"owner",
					"org-1",
					"example",
					account,
				)
			: getConnectionConsumerGrants(db, "org-1", "example", account);
	const cards = () =>
		sqlite
			.prepare("SELECT * FROM work_interactions WHERE org_id='org-1'")
			.all();
	const card = () => {
		const row = cards()[0]!;
		return { id: String(row.id), version: Number(row.version) };
	};
	const respond = (
		kind: "handoff_accepted" | "handoff_declined" = "handoff_accepted",
		user = "owner",
	) =>
		respondToWorkInteraction(db, {
			id: crypto.randomUUID(),
			orgId: "org-1",
			interactionId: card().id,
			expectedVersion: card().version,
			responder: { type: "user", id: user },
			responseKind: kind,
			body: kind === "handoff_accepted" ? "Approve" : "Decline",
			resolvesRequest: true,
			now: new Date().toISOString(),
		});
	return { sqlite, db, fetch, context, args, set, read, cards, card, respond };
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(getSkillRun).mockReset();
});

describe("credential selection identity", () => {
	it.each([
		{
			preference: "user-first" as const,
			expected: { scope: "user", userId: "owner-sub" },
		},
		{ preference: "tenant-first" as const, expected: { scope: "tenant" } },
	])(
		"records the actual hybrid winner for $preference",
		async ({ preference, expected }) => {
			const f = fixture();
			f.context.tediId = undefined;
			const result = await resolveCredentialChain(f.context, {
				...f.args,
				scope: "hybrid",
				preference,
				callerUserId: "owner-sub",
			});
			expect(result.selectedCredential).toEqual({
				organizationId: "org-1",
				providerId: "example",
				...expected,
			});
			expect(JSON.stringify(result.selectedCredential)).not.toContain("opaque");
			expect(result.selectedCredential).not.toHaveProperty(
				"connectionInstanceId",
			);
		},
	);

	it("records the fallback target after the first hybrid credential is absent", async () => {
		const f = fixture();
		f.context.tediId = undefined;
		f.fetch.mockResolvedValueOnce(
			Response.json({ errorCode: "missing" }, { status: 404 }),
		);
		const result = await resolveCredentialChain(f.context, {
			...f.args,
			scope: "hybrid",
			preference: "user-first",
			callerUserId: "owner-sub",
		});
		expect(result.selectedCredential).toEqual({
			organizationId: "org-1",
			providerId: "example",
			scope: "tenant",
		});
	});

	it("records the verified named account without exposing its vault ID or subject", async () => {
		const f = fixture("tenant");
		f.context.tediId = undefined;
		f.context.env.SECRETS_MASTER_KEY = "test-key-not-production";
		f.sqlite
			.prepare(
				"INSERT INTO connection_instances(id,owner_user_id,organization_id,provider_id,label,token_ids,token_sub,created_at,updated_at) VALUES(?,'owner-sub','org-1','example','Example',?,?,'2026-01-01','2026-01-01')",
			)
			.run(instanceId, JSON.stringify(["vault-grant"]), "provider-subject");
		let grant = "vault-grant";
		let subject = "provider-subject";
		f.fetch.mockImplementation(async () =>
			Response.json({
				token: {
					id: grant,
					accessToken: "opaque",
					appId: "example",
					tenantId: "tenant-1",
					externalIdentifier: `tedix_${instanceId}`,
					tokenSub: subject,
				},
			}),
		);
		const result = await resolveCredentialChain(f.context, {
			...f.args,
			connectionInstanceId: instanceId,
		});
		expect(result.selectedCredential).toEqual({
			organizationId: "org-1",
			providerId: "example",
			scope: "tenant",
			connectionInstanceId: instanceId,
			accountRevisionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(JSON.stringify(result.selectedCredential)).not.toMatch(
			/opaque|vault-grant|provider-subject/,
		);
		grant = "rotated-grant";
		const rotated = await resolveCredentialChain(f.context, {
			...f.args,
			connectionInstanceId: instanceId,
		});
		expect(rotated.selectedCredential.accountRevisionDigest).toBeUndefined();
		const repinned = await resolveCredentialChain(f.context, {
			...f.args,
			connectionInstanceId: instanceId,
		});
		expect(repinned.selectedCredential.accountRevisionDigest).toMatch(
			/^[0-9a-f]{64}$/,
		);
		expect(repinned.selectedCredential.accountRevisionDigest).not.toBe(
			result.selectedCredential.accountRevisionDigest,
		);
		f.context.env.SECRETS_MASTER_KEY = "";
		const noKey = await resolveCredentialChain(f.context, {
			...f.args,
			connectionInstanceId: instanceId,
		});
		expect(noKey.selectedCredential.accountRevisionDigest).toBeUndefined();
		subject = "different-account";
		await expect(
			resolveCredentialChain(f.context, {
				...f.args,
				connectionInstanceId: instanceId,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		f.context.env.SECRETS_MASTER_KEY = "test-key-not-production";
		subject = "";
		f.sqlite
			.prepare("UPDATE connection_instances SET token_sub = NULL WHERE id = ?")
			.run(instanceId);
		const noSubject = await resolveCredentialChain(f.context, {
			...f.args,
			connectionInstanceId: instanceId,
		});
		expect(noSubject.selectedCredential.accountRevisionDigest).toBeUndefined();
	});
});

describe.each(["user", "tenant"] as const)(
	"%s connection access requests",
	(scope) => {
		it("refuses before vault access, dedupes concurrent retries, and adds only the approved tedi", async () => {
			const f = fixture(scope);
			await f.set();
			const results = await Promise.allSettled([
				resolveCredentialChain(f.context, f.args),
				resolveCredentialChain(f.context, f.args),
			]);
			expect(
				results.every(
					(result) =>
						result.status === "rejected" && result.reason.code === "FORBIDDEN",
				),
			).toBe(true);
			expect(f.fetch).not.toHaveBeenCalled();
			expect(f.cards()).toHaveLength(1);
			expect(f.cards()[0]).toMatchObject({
				target_id: "owner",
				kind: "handoff",
			});
			await expect(f.respond("handoff_accepted", "other")).rejects.toThrow(
				"not the request target",
			);
			await f.respond();
			expect(await f.read()).toEqual({ ...denied, tediIds: [tediId] });
			await expect(
				resolveCredentialChain(f.context, f.args),
			).resolves.toMatchObject({ accessToken: "opaque" });
			await expect(f.respond()).rejects.toThrow();
			expect(await f.read()).toEqual({ ...denied, tediIds: [tediId] });
		});
		it("keeps a declined request blocked without creating another card", async () => {
			const f = fixture(scope);
			await f.set();
			await expect(
				resolveCredentialChain(f.context, f.args),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await f.respond("handoff_declined");
			await expect(
				resolveCredentialChain(f.context, f.args),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(await f.read()).toEqual(denied);
			expect(f.cards()).toHaveLength(1);
			expect(f.fetch).not.toHaveBeenCalled();
		});
		it("approves only the exact verified skill revision and preserves other grants", async () => {
			const f = fixture(scope);
			await f.set();
			f.context.headers.set("X-Tedix-Skill-Run-Id", "run-1");
			vi.mocked(getSkillRun).mockResolvedValue({
				tediId,
				skillId,
				skillRevision: 2,
				status: "running",
			} as Awaited<ReturnType<typeof getSkillRun>>);
			await expect(
				resolveCredentialChain(f.context, f.args),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			const other = "00000000-0000-4000-8000-000000000004";
			await f.set({ ...denied, tediIds: [other] });
			await f.respond();
			expect(await f.read()).toEqual({
				...denied,
				tediIds: [other],
				skills: [{ id: skillId, revision: 2 }],
			});
			await expect(
				resolveCredentialChain(f.context, f.args),
			).resolves.toMatchObject({ accessToken: "opaque" });
			vi.mocked(getSkillRun).mockResolvedValue({
				tediId,
				skillId,
				skillRevision: 3,
				status: "running",
			} as Awaited<ReturnType<typeof getSkillRun>>);
			f.fetch.mockClear();
			await expect(
				resolveCredentialChain(f.context, f.args),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(f.fetch).not.toHaveBeenCalled();
			expect(f.cards()).toHaveLength(2);
		});
		it("checks named accounts and both provider policies on labeled lookups", async () => {
			const f = fixture(scope);
			f.sqlite
				.prepare(
					"INSERT INTO connection_instances(id,owner_user_id,organization_id,provider_id,label,token_ids,created_at,updated_at) VALUES(?,'owner-sub',?,'example','Sources','[]','2026-01-01','2026-01-01')",
				)
				.run(instanceId, scope === "user" ? null : "org-1");
			await f.set(denied, instanceId);
			await expect(
				resolveCredentialChain(f.context, {
					...f.args,
					connectionInstanceId: instanceId,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(f.cards()).toHaveLength(1);
			await f.respond();
			expect(await f.read(instanceId)).toEqual({
				...denied,
				tediIds: [tediId],
			});
			expect(await f.read()).toEqual({ mode: "all" });
			await f.set(denied, undefined, "example-project");
			await expect(
				resolveCredentialChain(f.context, { ...f.args, label: "project" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(f.fetch).not.toHaveBeenCalled();
		});
	},
);

it("isolates personal policies by owner and organization, including JSON path characters", async () => {
	const f = fixture();
	await setPersonalConnectionConsumerGrants(
		f.db,
		"owner",
		"org-1",
		'example."quoted"',
		denied,
	);
	expect(
		await getPersonalConnectionConsumerGrants(
			f.db,
			"owner",
			"org-1",
			'example."quoted"',
		),
	).toEqual(denied);
	expect(
		await getPersonalConnectionConsumerGrants(
			f.db,
			"other",
			"org-1",
			'example."quoted"',
		),
	).toEqual({ mode: "all" });
	expect(
		await getPersonalConnectionConsumerGrants(
			f.db,
			"owner",
			"org-2",
			'example."quoted"',
		),
	).toEqual({ mode: "all" });
	expect(
		await getConnectionConsumerGrants(f.db, "org-1", 'example."quoted"'),
	).toEqual({ mode: "all" });
});

it.each(["user", "tenant"] as const)(
	"rejects a retired consumer when approving a %s request",
	async (scope) => {
		const f = fixture(scope);
		await f.set();
		await expect(
			resolveCredentialChain(f.context, f.args),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		f.sqlite
			.prepare(
				"UPDATE tedis SET retired_at='2026-10-27T00:00:00.000Z' WHERE id=?",
			)
			.run(tediId);
		await expect(f.respond()).rejects.toThrow();
		expect(await f.read()).toEqual(denied);
		expect(f.cards()[0]!.status).toBe("open");
	},
);

it("rolls back the approval if persisting the personal grant fails", async () => {
	const f = fixture();
	await f.set();
	await expect(resolveCredentialChain(f.context, f.args)).rejects.toMatchObject(
		{ code: "FORBIDDEN" },
	);
	f.sqlite.exec(
		"CREATE TEMP TRIGGER reject_grant BEFORE UPDATE OF metadata ON users BEGIN SELECT RAISE(ABORT,'storage failure'); END",
	);
	await expect(f.respond()).rejects.toThrow("storage failure");
	expect(await f.read()).toEqual(denied);
	expect(f.cards()[0]!.status).toBe("open");
	expect(
		f.sqlite
			.prepare("SELECT count(*) AS n FROM work_interaction_responses")
			.get()!.n,
	).toBe(0);
});

it("does not fall through to organization credentials when a personal consumer is denied", async () => {
	const f = fixture();
	await f.set();
	await expect(
		resolveCredentialChain(f.context, {
			...f.args,
			scope: "hybrid",
			preference: "user-first",
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(f.fetch).not.toHaveBeenCalled();
});

it("lets a member choose only their own personal grants and refuses machine edits", async () => {
	const { createRouterClient } = await import("@orpc/server");
	const { userContext, apiKeyContext } = await import("../test-context");
	const { getConsumerGrants, setConsumerGrants } =
		await import("./connections/consumer-grants");
	const f = fixture();
	const client = (userId: string) =>
		createRouterClient(
			{ getConsumerGrants, setConsumerGrants },
			{
				context: userContext({
					db: f.db,
					userId,
					sub: `${userId}-sub`,
					permissions: ["apps:read"],
				}),
			},
		);
	await client("owner").setConsumerGrants({
		providerId: "example",
		scope: "user",
		policy: denied,
	});
	expect(
		await client("owner").getConsumerGrants({
			providerId: "example",
			scope: "user",
		}),
	).toEqual(denied);
	expect(
		await client("other").getConsumerGrants({
			providerId: "example",
			scope: "user",
		}),
	).toEqual({ mode: "all" });
	await expect(
		client("other").setConsumerGrants({
			providerId: "example",
			policy: denied,
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const machine = createRouterClient(
		{ setConsumerGrants },
		{ context: apiKeyContext({ db: f.db, scopes: ["connections.admin"] }) },
	);
	await expect(
		machine.setConsumerGrants({
			providerId: "example",
			scope: "user",
			policy: { mode: "all" },
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it.each(["user", "tenant"] as const)(
	"rejects an approval after the %s account changes owner",
	async (scope) => {
		const f = fixture(scope);
		f.sqlite
			.prepare(
				"INSERT INTO connection_instances(id,owner_user_id,organization_id,provider_id,label,token_ids,created_at,updated_at) VALUES(?,'owner-sub',?,'example','Sources','[]','2026-01-01','2026-01-01')",
			)
			.run(instanceId, scope === "user" ? null : "org-1");
		await f.set(denied, instanceId);
		await expect(
			resolveCredentialChain(f.context, {
				...f.args,
				connectionInstanceId: instanceId,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		f.sqlite
			.prepare(
				"UPDATE connection_instances SET owner_user_id='other-sub' WHERE id=?",
			)
			.run(instanceId);
		await expect(f.respond()).rejects.toThrow("ownership changed");
		expect(await f.read(instanceId)).toEqual(denied);
	},
);

it("enforces grants at direct named personal credential fetches", async () => {
	const { fetchNamedConnection } =
		await import("./connections/policy-resolution");
	const f = fixture();
	f.sqlite
		.prepare(
			"INSERT INTO connection_instances(id,owner_user_id,provider_id,label,token_ids,created_at,updated_at) VALUES(?,'owner-sub','example','Sources','[]','2026-01-01','2026-01-01')",
		)
		.run(instanceId);
	await f.set(denied, instanceId);
	await expect(
		fetchNamedConnection(
			f.context,
			{ userId: "owner-sub" },
			"example",
			instanceId,
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(f.fetch).not.toHaveBeenCalled();
	expect(f.cards()).toHaveLength(1);
});

it("keeps a request open when the owner's selected-consumer list is full", async () => {
	const f = fixture();
	const tediIds = Array.from(
		{ length: 100 },
		(_, i) => `00000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`,
	);
	await f.set({ ...denied, tediIds });
	await expect(resolveCredentialChain(f.context, f.args)).rejects.toMatchObject(
		{ code: "FORBIDDEN" },
	);
	await expect(f.respond()).rejects.toThrow("resolution race");
	expect(await f.read()).toEqual({ ...denied, tediIds });
	expect(f.cards()[0]!.status).toBe("open");
});
