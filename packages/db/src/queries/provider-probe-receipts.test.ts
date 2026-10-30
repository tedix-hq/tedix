import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	consumeProviderProbeReceipt,
	createProviderProbeReceipt,
	consumeProviderProbeResult,
	createProviderProbeResult,
	createMachineProviderProbeResult,
	consumeMachineProviderProbeResult,
	listMachineProviderProbeResults,
	createMachineProviderProbeAuthorization,
	consumeMachineProviderProbeAuthorization,
} from "./provider-probe-receipts";

describe("provider probe receipts", () => {
	it("redeems machine probe authority only once for the exact org and arguments before expiry", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			"CREATE TABLE machine_provider_probe_authorizations (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL, session_id TEXT NOT NULL, client_record_id TEXT NOT NULL, client_id TEXT NOT NULL, mcp_server_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_digest TEXT NOT NULL, args_digest TEXT NOT NULL, expires_at TEXT NOT NULL)",
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		await createMachineProviderProbeAuthorization(db, {
			id: "id",
			organizationId: "org",
			principalId: "principal",
			sessionId: "session",
			clientRecordId: "record",
			clientId: "client",
			mcpServerId: "server",
			profileId: "profile",
			profileDigest: "revision",
			argsDigest: "args",
			expiresAt: "2026-10-30T12:00:30.000Z",
		});
		const input = {
			id: "id",
			organizationId: "org",
			argsDigest: "args",
			now: "2026-10-30T12:00:00.000Z",
		};
		for (const change of [
			{ organizationId: "other" },
			{ argsDigest: "other" },
			{ now: "2026-10-30T12:00:30.000Z" },
		])
			expect(
				await consumeMachineProviderProbeAuthorization(db, {
					...input,
					...change,
				}),
			).toBeUndefined();
		const results = await Promise.all([
			consumeMachineProviderProbeAuthorization(db, input),
			consumeMachineProviderProbeAuthorization(db, input),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
	});
	it("lists and consumes only an unexpired exact machine proof once", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			"CREATE TABLE machine_provider_probe_results (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL, session_id TEXT NOT NULL, client_record_id TEXT NOT NULL, client_id TEXT NOT NULL, mcp_server_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_digest TEXT NOT NULL, args_digest TEXT NOT NULL, account_revision_digest TEXT NOT NULL, expires_at TEXT NOT NULL)",
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		await createMachineProviderProbeResult(db, {
			id: "proof",
			organizationId: "org",
			principalId: "machine",
			sessionId: "session",
			clientRecordId: "record",
			clientId: "client",
			mcpServerId: "server",
			profileId: "profile",
			profileDigest: "revision",
			argsDigest: "args",
			accountRevisionDigest: "account",
			expiresAt: "2026-10-30T12:05:00.000Z",
		});
		const base = {
			id: "proof",
			organizationId: "org",
			profileId: "profile",
			profileDigest: "revision",
			argsDigest: "args",
			now: "2026-10-30T12:00:00.000Z",
		};
		expect(
			await listMachineProviderProbeResults(db, {
				organizationId: "other",
				now: base.now,
			}),
		).toHaveLength(0);
		expect(
			await listMachineProviderProbeResults(db, {
				organizationId: "org",
				now: base.now,
			}),
		).toHaveLength(1);
		for (const change of [
			{ organizationId: "other" },
			{ profileId: "other" },
			{ profileDigest: "other" },
			{ argsDigest: "other" },
			{ now: "2026-10-30T12:05:00.000Z" },
		])
			expect(
				await consumeMachineProviderProbeResult(db, { ...base, ...change }),
			).toBeUndefined();
		const consumed = await Promise.all([
			consumeMachineProviderProbeResult(db, base),
			consumeMachineProviderProbeResult(db, base),
		]);
		expect(consumed.filter(Boolean)).toHaveLength(1);
		expect(consumed.find(Boolean)).toMatchObject({
			principalId: "machine",
			sessionId: "session",
			accountRevisionDigest: "account",
		});
	});
	it("is scoped to organization and exact arguments, expires, and is single use", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			"CREATE TABLE provider_probe_receipts (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_digest TEXT NOT NULL, args_digest TEXT NOT NULL, expires_at TEXT NOT NULL)",
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		await createProviderProbeReceipt(db, {
			id: "receipt",
			organizationId: "org-a",
			actorUserId: "owner",
			profileId: "profile",
			profileDigest: "profile-digest",
			argsDigest: "args-digest",
			expiresAt: "2026-10-30T12:00:30.000Z",
		});
		const base = {
			id: "receipt",
			organizationId: "org-a",
			argsDigest: "args-digest",
			now: "2026-10-30T12:00:00.000Z",
		};
		expect(
			await consumeProviderProbeReceipt(db, {
				...base,
				organizationId: "org-b",
			}),
		).toBeUndefined();
		expect(
			await consumeProviderProbeReceipt(db, { ...base, argsDigest: "other" }),
		).toBeUndefined();
		expect(
			await consumeProviderProbeReceipt(db, {
				...base,
				now: "2026-10-30T12:00:30.000Z",
			}),
		).toBeUndefined();
		const results = await Promise.all([
			consumeProviderProbeReceipt(db, base),
			consumeProviderProbeReceipt(db, base),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(results.find(Boolean)).toMatchObject({
			actorUserId: "owner",
			profileId: "profile",
		});
	});

	it("binds a successful result to owner, organization, profile, revision and exact arguments", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			"CREATE TABLE provider_probe_results (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_digest TEXT NOT NULL, args_digest TEXT NOT NULL, account_revision_digest TEXT NOT NULL, expires_at TEXT NOT NULL)",
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		await createProviderProbeResult(db, {
			id: "result",
			organizationId: "org-a",
			actorUserId: "owner",
			profileId: "profile",
			profileDigest: "revision",
			argsDigest: "args",
			accountRevisionDigest: "identity",
			expiresAt: "2026-10-30T12:05:00.000Z",
		});
		const base = {
			id: "result",
			organizationId: "org-a",
			actorUserId: "owner",
			profileId: "profile",
			profileDigest: "revision",
			argsDigest: "args",
			now: "2026-10-30T12:00:00.000Z",
		};
		for (const change of [
			{ organizationId: "org-b" },
			{ actorUserId: "other" },
			{ profileId: "other" },
			{ profileDigest: "other" },
			{ argsDigest: "other" },
			{ now: "2026-10-30T12:05:00.000Z" },
		])
			expect(
				await consumeProviderProbeResult(db, { ...base, ...change }),
			).toBeUndefined();
		const results = await Promise.all([
			consumeProviderProbeResult(db, base),
			consumeProviderProbeResult(db, base),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(results.find(Boolean)).toMatchObject({
			accountRevisionDigest: "identity",
		});
	});
});
