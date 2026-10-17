import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { tediConsoleGrants } from "@tedix/db/schema/tedi-console";
import { tedis } from "@tedix/db/schema/tedis";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { osOutputs, osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { withAuth, type BaseContext } from "../orpc";
import { implement } from "@orpc/server";
import { tediConsoleContract } from "@tedix/api-contract/contracts/tedi-console";
import { tediConsoleRouter } from "./tedi-console";
vi.mock("@tedix/auth/jwt", async (original) => ({
	...(await original<typeof import("@tedix/auth/jwt")>()),
	validateToken: vi.fn(async () => ({
		exp: Math.floor(Date.now() / 1000) + 600,
	})),
}));
const tediId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "33333333-3333-4333-8333-333333333333";
const secret = "fictional-test-master-key-not-a-credential";
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			tediConsoleGrants,
			tedis,
			organizations,
			organizationMembers,
			auditEvents,
			osWorkspaces,
			osOutputs,
		),
	);
	const env = {
		DB: createD1Facade(sqlite),
		SECRETS_MASTER_KEY: secret,
	} as CloudflareEnv;
	const db = createDbClient(env.DB);
	await db.insert(organizations).values({
		id: "org-acme",
		name: "Acme",
		slug: "acme",
		descopeTenantId: "tenant-acme",
	});
	await db.insert(tedis).values({
		id: tediId,
		organizationId: "org-acme",
		name: "Atlas",
		slug: "atlas",
		status: "active",
		descopeUserId: "identity-atlas",
	});
	await db.insert(organizationMembers).values({
		id: "member-acme",
		organizationId: "org-acme",
		descopeUserId: "human-acme",
		email: "admin@acme.example",
		role: "admin",
		status: "active",
	});
	await db.insert(osWorkspaces).values(
		[workspaceId, otherWorkspaceId].map((id, index) => ({
			id,
			organizationId: "org-acme",
			name: index ? "Unselected" : "Research",
			createdByKind: "user" as const,
			createdById: "human-acme",
		})),
	);
	await db.insert(osOutputs).values({
		id: "output-acme",
		organizationId: "org-acme",
		workspaceId,
		title: "Research notes",
		kind: "document",
		createdByKind: "user",
		createdById: "human-acme",
	});
	const base = (): BaseContext =>
		({
			env,
			db,
			headers: new Headers(),
			organizationId: "org-acme",
			url: new URL("https://api.example/rpc"),
		}) as BaseContext;
	const human = (overrides: Partial<BaseContext> = {}) =>
		createRouterClient(
			{ tediConsole: tediConsoleRouter },
			{
				context: {
					...base(),
					authType: "user",
					userRole: "admin",
					user: {
						sub: "human-acme",
						permissions: ["settings:manage"],
						roles: ["admin"],
					},
					...overrides,
				} as BaseContext,
			},
		).tediConsole;
	const machine = (overrides: Partial<BaseContext> = {}) =>
		createRouterClient(
			{ tediConsole: tediConsoleRouter },
			{
				context: {
					...base(),
					authType: "tedi",
					tediId,
					descopeUserId: "identity-atlas",
					tediScopes: ["tedis:read", "mcp:tedis.admin"],
					serviceAccount: { id: "preauthenticated-test" },
					headers: new Headers({ Authorization: "Bearer fictional-tedi-jwt" }),
					...overrides,
				} as BaseContext,
			},
		).tediConsole;
	const consoleClient = (token: string, headers: Record<string, string> = {}) =>
		createRouterClient(
			{ tediConsole: tediConsoleRouter },
			{
				context: {
					...base(),
					headers: new Headers({
						Authorization: `Bearer ${token}`,
						...headers,
					}),
				},
			},
		).tediConsole;
	const grant = () =>
		human().setGrant({ tediId, enabled: true, workspaceIds: [workspaceId] });
	return { sqlite, db, base, human, machine, consoleClient, grant };
}
describe("tedi-owned console authority", () => {
	it("defaults disabled and denies minting without a grant", async () => {
		const f = await fixture();
		expect(await f.human().getGrant({ tediId })).toEqual({
			enabled: false,
			workspaceIds: [],
		});
		await expect(f.machine().createSession({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("allows a human admin to grant only chosen Workspaces and attributes session and reads to the tedi", async () => {
		const f = await fixture();
		await f.grant();
		const result = await f.machine().createSession({});
		expect(result.expiresAt).toBeLessThanOrEqual(
			Math.floor(Date.now() / 1000) + 300,
		);
		const view = await f
			.consoleClient(result.sessionToken)
			.read({ workspaceId });
		expect(view).toMatchObject({
			tediId,
			readOnly: true,
			workspaces: [{ id: workspaceId }],
			outputs: [{ title: "Research notes" }],
		});
		const audit = await f.db.select().from(auditEvents);
		expect(
			audit
				.filter((e) => e.action !== "tedi.console.grant.updated")
				.map((e) => [e.actorType, e.actorId]),
		).toEqual([
			["tedi", tediId],
			["tedi", tediId],
		]);
	});
	it("never permits self-grant even with administrator machine scopes", async () => {
		const f = await fixture();
		await expect(
			f
				.machine()
				.setGrant({ tediId, enabled: true, workspaceIds: [workspaceId] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it.each(["member", "viewer", "deactivated"])(
		"checks fresh membership rather than stale admin claims: %s",
		async (role) => {
			const f = await fixture();
			f.sqlite.exec(
				role === "deactivated"
					? "UPDATE organization_members SET status = 'deactivated'"
					: `UPDATE organization_members SET role = '${role}'`,
			);
			await expect(
				f
					.human()
					.setGrant({ tediId, enabled: true, workspaceIds: [workspaceId] }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);
	it("denies an unselected Workspace and a different tenant host", async () => {
		const f = await fixture();
		await f.grant();
		const { sessionToken } = await f.machine().createSession({});
		await expect(
			f.consoleClient(sessionToken).read({ workspaceId: otherWorkspaceId }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			f
				.consoleClient(sessionToken, { "X-Tedix-Tenant-Id": "tenant-other" })
				.read({}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("revokes outstanding sessions on disable, regrant, or tedi pause", async () => {
		const f = await fixture();
		await f.grant();
		const { sessionToken } = await f.machine().createSession({});
		await f.human().setGrant({ tediId, enabled: false, workspaceIds: [] });
		await expect(f.consoleClient(sessionToken).read({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await f.grant();
		await expect(f.consoleClient(sessionToken).read({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const next = await f.machine().createSession({});
		f.sqlite.exec("UPDATE tedis SET status = 'paused'");
		await expect(
			f.consoleClient(next.sessionToken).read({}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("can revoke access after a tedi is paused or a Workspace becomes inaccessible", async () => {
		const f = await fixture();
		await f.grant();
		f.sqlite.exec("UPDATE tedis SET status = 'paused'");
		expect(
			await f.human().setGrant({
				tediId,
				enabled: false,
				workspaceIds: ["44444444-4444-4444-8444-444444444444"],
			}),
		).toEqual({ enabled: false, workspaceIds: [] });
	});
	it("rejects human login, wrong tedi identity, and grants on foreign Workspaces", async () => {
		const f = await fixture();
		await f.grant();
		await expect(f.human().createSession({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			f.machine({ descopeUserId: "identity-other" }).createSession({}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			f.human().setGrant({
				tediId,
				enabled: true,
				workspaceIds: ["44444444-4444-4444-8444-444444444444"],
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("denies write/approval/admin procedures even on trusted binding transport", async () => {
		const f = await fixture();
		await f.grant();
		const { sessionToken } = await f.machine().createSession({});
		await expect(
			f
				.consoleClient(sessionToken)
				.setGrant({ tediId, enabled: true, workspaceIds: [otherWorkspaceId] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		let executed = false;
		const i = implement(tediConsoleContract).$context<BaseContext>();
		const client = createRouterClient(
			i.router({
				write: i.setGrant.use(withAuth).handler(() => {
					executed = true;
					return { enabled: true, workspaceIds: [] };
				}),
			}),
			{
				context: {
					...f.base(),
					headers: new Headers({
						Authorization: `Bearer ${sessionToken}`,
						"X-Service-Binding": "true",
						"X-Tedix-Tedi-Scopes": "*",
					}),
				},
			},
		);
		await expect(
			client.write({ tediId, enabled: true, workspaceIds: [] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(executed).toBe(false);
	});
	it("rejects expired and tampered sessions", async () => {
		const f = await fixture();
		await f.grant();
		const { sessionToken } = await f.machine().createSession({});
		await expect(
			f.consoleClient(sessionToken + "tampered").read({}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.now() + 301000);
			await expect(
				f.consoleClient(sessionToken).read({}),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		} finally {
			vi.useRealTimers();
		}
	});
});
