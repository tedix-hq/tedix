import { DatabaseSync } from "node:sqlite";
import {
	afterEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { suspendBrowserAgentSeat } from "@tedix/db/queries/organization-members";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { organizations } from "@tedix/db/schema/organizations";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	hasActiveVoiceMembership,
	watchVoiceMembership,
	VOICE_MEMBERSHIP_CHECK_MS,
} from "./voice-membership";

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec(schemaDdl(organizations, organizationMembers));
	const env = { DB: createD1Facade(sqlite) } as Pick<CloudflareEnv, "DB">;
	const db = createDbClient(env.DB);
	await db
		.insert(organizations)
		.values({ id: "org", name: "Fictional team", slug: "fictional-team" });
	await db.insert(organizationMembers).values([
		{
			id: "seat",
			organizationId: "org",
			userId: "juniper",
			descopeUserId: "juniper-provider",
			email: "juniper@example.test",
			kind: "browser_agent",
			representedUserId: "river",
			role: "member",
			status: "active",
		},
		{
			id: "owner",
			organizationId: "org",
			userId: "river",
			descopeUserId: "river-provider",
			email: "river@example.test",
			kind: "human",
			role: "owner",
			status: "active",
		},
	]);
	const request = new Request("https://api.example.test/kernel/voice/input", {
		headers: {
			"X-Kernel-Organization-Id": "org",
			"X-Kernel-Descope-User-Id": "juniper-provider",
		},
	});
	return { sqlite, db, env, request };
}

afterEach(() => vi.useRealTimers());

describe("live voice membership", () => {
	it("checks the provider subject in the exact organization", async () => {
		const { env } = await fixture();
		expect(await hasActiveVoiceMembership(env, "org", "juniper-provider")).toBe(
			true,
		);
		expect(await hasActiveVoiceMembership(env, "org", "juniper")).toBe(false);
		expect(
			await hasActiveVoiceMembership(env, "other", "juniper-provider"),
		).toBe(false);
	});

	it.each([
		"UPDATE organization_members SET status = 'deactivated' WHERE id = 'seat'",
		"UPDATE organization_members SET status = 'invited' WHERE id = 'seat'",
		"UPDATE organization_members SET role = 'admin' WHERE id = 'seat'",
		"UPDATE organization_members SET status = 'deactivated' WHERE id = 'owner'",
		"UPDATE organization_members SET kind = 'external_agent' WHERE id = 'owner'",
		"UPDATE organization_members SET represented_user_id = 'juniper' WHERE id = 'seat'",
		"UPDATE organization_members SET represented_user_id = NULL WHERE id = 'seat'",
		"DELETE FROM organization_members WHERE id = 'seat'",
	])("denies invalid seat authority: %s", async (change) => {
		const { env, sqlite } = await fixture();
		sqlite.exec(change);
		expect(await hasActiveVoiceMembership(env, "org", "juniper-provider")).toBe(
			false,
		);
	});

	it("closes all idle voice sockets after suspension and stops their watches", async () => {
		const { env, db, request } = await fixture();
		vi.useFakeTimers();
		const connections = [{ close: vi.fn() }, { close: vi.fn() }];
		const stops = await Promise.all(
			connections.map((connection) =>
				watchVoiceMembership(connection, request, env),
			),
		);
		await suspendBrowserAgentSeat(db, {
			organizationId: "org",
			memberId: "seat",
			actorUserId: "river",
		});
		await vi.advanceTimersByTimeAsync(VOICE_MEMBERSHIP_CHECK_MS);
		for (const connection of connections)
			expect(connection.close).toHaveBeenCalledExactlyOnceWith(
				4003,
				"Organization access changed; reconnect.",
			);
		expect(vi.getTimerCount()).toBe(0);
		for (const stop of stops) stop?.();
	});

	it("cleans up on ordinary disconnect and refuses missing stamped identity", async () => {
		const { env, request } = await fixture();
		vi.useFakeTimers();
		const connection = { close: vi.fn() };
		const stop = await watchVoiceMembership(connection, request, env);
		expect(stop).toBeTypeOf("function");
		stop?.();
		await vi.advanceTimersByTimeAsync(VOICE_MEMBERSHIP_CHECK_MS);
		expect(connection.close).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(
			await watchVoiceMembership(connection, new Request(request.url), env),
		).toBeNull();
		expect(connection.close).toHaveBeenCalledWith(4003, expect.any(String));
	});

	it("closes an open socket when the membership store becomes unavailable", async () => {
		const { env, request, sqlite } = await fixture();
		vi.useFakeTimers();
		const connection = { close: vi.fn() };
		await watchVoiceMembership(connection, request, env);
		sqlite.exec("DROP TABLE organization_members");
		await vi.advanceTimersByTimeAsync(VOICE_MEMBERSHIP_CHECK_MS);
		expect(connection.close).toHaveBeenCalledWith(4003, expect.any(String));
		expect(vi.getTimerCount()).toBe(0);
	});
});
