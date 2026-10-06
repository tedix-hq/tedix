import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createD1Facade } from "../test/d1-facade";
import {
	getTediEmailIngressRouteBySlug,
	getTediRuntimePolicy,
	resolveCanonicalRuntimeParentIdentity,
	resolveTediRuntimeIdentity,
} from "./tedi-runtime-bootstrap";

describe("canonical runtime parent identity", () => {
	it("uses one snapshot for unique effective physical name while preserving the general resolver", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`CREATE TABLE tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT);
		INSERT INTO tedis VALUES ('rebound','org','cto','cto-rebound','agent','active'),('fallback','org','ceo',NULL,'agent','standby');`);
		const db = createD1Facade(sqlite);
		await expect(
			resolveCanonicalRuntimeParentIdentity(db, "cto-rebound"),
		).resolves.toEqual({
			id: "rebound",
			orgId: "org",
			slug: "cto",
			isolateAgentId: "cto-rebound",
			runtimeKind: "agent",
			status: "active",
		});
		await expect(
			resolveCanonicalRuntimeParentIdentity(db, "cto"),
		).resolves.toBeNull();
		await expect(
			resolveCanonicalRuntimeParentIdentity(db, "ceo"),
		).resolves.toMatchObject({ id: "fallback", isolateAgentId: null });
		await expect(resolveTediRuntimeIdentity(db, "cto")).resolves.toMatchObject({
			id: "rebound",
		});
		sqlite.exec(
			"INSERT INTO tedis VALUES('duplicate','other-org','other','cto-rebound','agent','active')",
		);
		const before = sqlite.prepare("SELECT * FROM tedis ORDER BY id").all();
		await expect(
			resolveCanonicalRuntimeParentIdentity(db, "cto-rebound"),
		).resolves.toBeNull();
		await expect(
			resolveCanonicalRuntimeParentIdentity(db, "missing"),
		).resolves.toBeNull();
		expect(sqlite.prepare("SELECT * FROM tedis ORDER BY id").all()).toEqual(
			before,
		);
	});
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedis (
			id TEXT PRIMARY KEY,
			policy_pack_id TEXT,
			runtime_overrides TEXT
		);
		CREATE TABLE policy_packs (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			scope TEXT NOT NULL,
			status TEXT NOT NULL,
			version INTEGER NOT NULL,
			definition TEXT NOT NULL
		);
	`);
	return { sqlite, db: createD1Facade(sqlite) };
}

describe("getTediRuntimePolicy", () => {
	it("resolves a null legacy pin to the latest active system default", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(`
			INSERT INTO policy_packs VALUES
				('v26', 'system-default', 'system', 'active', 26, '{"version":26}'),
				('v27', 'system-default', 'system', 'active', 27, '{"version":27}'),
				('v28', 'system-default', 'system', 'draft', 28, '{"version":28}');
			INSERT INTO tedis VALUES ('legacy', NULL, '{"cronPolicy":{"disableCognitiveDefaults":true}}');
		`);

		await expect(getTediRuntimePolicy(db, "legacy")).resolves.toEqual({
			definition: '{"version":27}',
			runtimeOverrides: '{"cronPolicy":{"disableCognitiveDefaults":true}}',
		});
	});

	it("preserves an explicit immutable policy revision pin", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(`
			INSERT INTO policy_packs VALUES
				('pinned', 'custom', 'system', 'active', 1, '{"policy":"pinned"}'),
				('v27', 'system-default', 'system', 'active', 27, '{"policy":"default"}');
			INSERT INTO tedis VALUES ('pinned-tedi', 'pinned', NULL);
		`);

		await expect(getTediRuntimePolicy(db, "pinned-tedi")).resolves.toEqual({
			definition: '{"policy":"pinned"}',
			runtimeOverrides: null,
		});
	});
});

describe("getTediEmailIngressRouteBySlug", () => {
	it("resolves only active, non-retired tedi bodies", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE tedis (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL,
				isolate_agent_id TEXT,
				status TEXT,
				retired_at TEXT
			);
			INSERT INTO tedis VALUES
				('active', 'cto', 'agent-cto', 'active', NULL),
				('fallback', 'ceo', NULL, 'active', NULL),
				('paused', 'paused', 'agent-paused', 'paused', NULL),
				('retired', 'former', 'agent-former', 'active', '2026-09-26');
		`);
		const db = createD1Facade(sqlite);

		await expect(getTediEmailIngressRouteBySlug(db, "cto")).resolves.toEqual({
			agentId: "agent-cto",
		});
		await expect(getTediEmailIngressRouteBySlug(db, "ceo")).resolves.toEqual({
			agentId: "ceo",
		});
		await expect(
			getTediEmailIngressRouteBySlug(db, "paused"),
		).resolves.toBeNull();
		await expect(
			getTediEmailIngressRouteBySlug(db, "former"),
		).resolves.toBeNull();
		await expect(
			getTediEmailIngressRouteBySlug(db, "missing"),
		).resolves.toBeNull();
	});
});

describe("getRetainedRuntimeRoot", () => {
	it("joins current same-organization owner and exact original ROOT only, without writes", async () => {
		const { getRetainedRuntimeRoot } = await import("./tedi-runtime-bootstrap");
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`CREATE TABLE tedis(id TEXT PRIMARY KEY,organization_id TEXT,isolate_agent_id TEXT);
 CREATE TABLE billing_historical_exposures(id TEXT,organization_id TEXT,tedi_id TEXT,object_id TEXT,object_name TEXT,generation INTEGER,snapshot_id TEXT,source_hash TEXT,operation_id TEXT,request_hash TEXT,exposure TEXT,payload TEXT,observed_by TEXT,observed_user_id TEXT,observed_at TEXT);
 INSERT INTO tedis VALUES('t','o','fresh');`);
		const payload = JSON.stringify({
			rootObjectId: "physical",
			objectId: "physical",
			rootObjectName: "old",
			className: "AgentTediDO",
			targetPath: [],
		});
		sqlite
			.prepare(
				"INSERT INTO billing_historical_exposures VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				"e",
				"o",
				"t",
				"physical",
				"old",
				1,
				"snapshot",
				"source",
				"operation",
				"hash",
				"UNKNOWN",
				payload,
				"owner",
				"user",
				"time",
			);
		const db = createD1Facade(sqlite),
			input = {
				tediId: "t",
				orgId: "o",
				objectId: "physical",
				objectName: "old",
				generation: 1,
			};
		expect(await getRetainedRuntimeRoot(db, input)).toMatchObject({
			objectName: "old",
			currentObjectName: "fresh",
			currentOrganizationId: "o",
			payload,
		});
		expect(
			await getRetainedRuntimeRoot(db, { ...input, generation: 2 }),
		).toBeNull();
		sqlite.exec("UPDATE tedis SET organization_id='moved'");
		expect(await getRetainedRuntimeRoot(db, input)).toBeNull();
		sqlite.exec("UPDATE tedis SET organization_id='o'");
		sqlite.prepare("UPDATE billing_historical_exposures SET payload=?").run(
			JSON.stringify({
				rootObjectId: "physical",
				objectId: "leaf",
				rootObjectName: "old",
				className: "LegacyChild",
				targetPath: [{}],
			}),
		);
		expect(await getRetainedRuntimeRoot(db, input)).toBeNull();
	});
});
