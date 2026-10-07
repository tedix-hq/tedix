import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { endExternalAgentSession } from "./knowledge-lifecycle";
import {
	getOwnerUserExternalAgentPrincipal,
	resolveOwnerHostSession,
} from "./owner-host-sessions";
import {
	createExternalAgentPrincipal,
	getExternalAgentPrincipalByCredential,
	setExternalAgentPrincipalStatus,
} from "./principals";
import { openExternalAgentSession } from "./sessions";

const DDL = `
CREATE TABLE external_agent_principals (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, key TEXT NOT NULL,
 display_name TEXT NOT NULL, status TEXT NOT NULL,
 credential_binding_type TEXT NOT NULL, credential_binding_id TEXT NOT NULL,
 created_by_type TEXT NOT NULL, created_by_id TEXT NOT NULL, metadata TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_external_agent_principal_key
 ON external_agent_principals (organization_id, key);
CREATE UNIQUE INDEX uniq_external_agent_credential_binding
 ON external_agent_principals
 (organization_id, credential_binding_type, credential_binding_id);
CREATE TABLE external_agent_sessions (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 external_session_key TEXT NOT NULL, harness TEXT NOT NULL,
 harness_version TEXT NOT NULL, model_provider TEXT NOT NULL,
 model_id TEXT NOT NULL, model_version TEXT NOT NULL,
 identity_source TEXT NOT NULL, status TEXT NOT NULL,
 credit_eligible INTEGER NOT NULL, started_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL, ended_at TEXT, metadata TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_external_agent_session_key
 ON external_agent_sessions (organization_id, harness, external_session_key);
CREATE TABLE work_attempts (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, executor_type TEXT NOT NULL, executor_id TEXT NOT NULL, executor_session_id TEXT);
`;

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const OWNER = "user-owner-example";
const OTHER_USER = "user-other-example";
const NOW = "2026-10-07T00:00:00.000Z";

function fixture(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	return createDbClient(createD1Facade(sqlite));
}

async function ownerPrincipal(
	db: DbClient,
	options: { organizationId?: string; userId?: string; id?: string } = {},
) {
	return createExternalAgentPrincipal(db, {
		id: options.id ?? "00000000-0000-4000-8000-000000000010",
		organizationId: options.organizationId ?? ORG,
		key: `owner-host-${options.userId ?? OWNER}`,
		displayName: "Plugin hosts of owner",
		credentialBindingType: "owner_user",
		credentialBindingId: options.userId ?? OWNER,
		createdByType: "user",
		createdById: options.userId ?? OWNER,
		createdAt: NOW,
	});
}

async function session(
	db: DbClient,
	principalId: string,
	options: { id?: string; organizationId?: string; key?: string } = {},
) {
	return openExternalAgentSession(db, {
		id: options.id ?? "00000000-0000-4000-8000-000000000020",
		organizationId: options.organizationId ?? ORG,
		principalId,
		externalSessionKey: options.key ?? "claude-desktop:thread-1",
		harness: "claude-desktop",
		harnessVersion: "1.0.0",
		modelProvider: "anthropic",
		modelId: "claude-example",
		modelVersion: "2026-10-01",
		identitySource: "explicit",
		creditEligible: false,
		metadata: { ownerBound: true, source: "mcp-plugin" },
		startedAt: NOW,
	});
}

describe("owner-host session resolution", () => {
	it("resolves an active owner-host session for its owning user", async () => {
		const db = fixture();
		const principal = await ownerPrincipal(db);
		const opened = await session(db, principal.id);
		expect(opened.creditEligible).toBe(false);

		const resolved = await resolveOwnerHostSession(db, {
			organizationId: ORG,
			userId: OWNER,
			sessionId: opened.id,
		});
		expect(resolved?.principal).toMatchObject({
			id: principal.id,
			credentialBindingType: "owner_user",
			credentialBindingId: OWNER,
			status: "active",
		});
		expect(resolved?.session).toMatchObject({
			id: opened.id,
			principalId: principal.id,
			externalSessionKey: "claude-desktop:thread-1",
			creditEligible: false,
			metadata: { ownerBound: true, source: "mcp-plugin" },
		});
		expect(
			await getOwnerUserExternalAgentPrincipal(db, {
				organizationId: ORG,
				userId: OWNER,
			}),
		).toMatchObject({ id: principal.id });
	});

	it("rejects another user's session", async () => {
		const db = fixture();
		const principal = await ownerPrincipal(db);
		const opened = await session(db, principal.id);
		expect(
			await resolveOwnerHostSession(db, {
				organizationId: ORG,
				userId: OTHER_USER,
				sessionId: opened.id,
			}),
		).toBeNull();
	});

	it("rejects the session from another organization", async () => {
		const db = fixture();
		const principal = await ownerPrincipal(db);
		const opened = await session(db, principal.id);
		await ownerPrincipal(db, {
			organizationId: OTHER_ORG,
			id: "00000000-0000-4000-8000-000000000011",
		});
		expect(
			await resolveOwnerHostSession(db, {
				organizationId: OTHER_ORG,
				userId: OWNER,
				sessionId: opened.id,
			}),
		).toBeNull();
	});

	it("rejects an ended session and a suspended principal", async () => {
		const db = fixture();
		const principal = await ownerPrincipal(db);
		const ended = await session(db, principal.id);
		await endExternalAgentSession(db, {
			organizationId: ORG,
			principalId: principal.id,
			sessionId: ended.id,
			endedAt: NOW,
			zeroWorkDisposition: { idempotencyKey: "end-1", reason: "done" },
		});
		expect(
			await resolveOwnerHostSession(db, {
				organizationId: ORG,
				userId: OWNER,
				sessionId: ended.id,
			}),
		).toBeNull();

		const live = await session(db, principal.id, {
			id: "00000000-0000-4000-8000-000000000021",
			key: "claude-desktop:thread-2",
		});
		await setExternalAgentPrincipalStatus(db, {
			organizationId: ORG,
			principalId: principal.id,
			status: "suspended",
			updatedAt: NOW,
		});
		expect(
			await resolveOwnerHostSession(db, {
				organizationId: ORG,
				userId: OWNER,
				sessionId: live.id,
			}),
		).toBeNull();
	});

	it("never resolves an api_key principal even when its binding id matches", async () => {
		const db = fixture();
		const machine = await createExternalAgentPrincipal(db, {
			id: "00000000-0000-4000-8000-000000000012",
			organizationId: ORG,
			key: "codex-primary",
			displayName: "Codex primary",
			credentialBindingType: "api_key",
			credentialBindingId: OWNER,
			createdByType: "user",
			createdById: OWNER,
			createdAt: NOW,
		});
		const opened = await session(db, machine.id);
		expect(
			await resolveOwnerHostSession(db, {
				organizationId: ORG,
				userId: OWNER,
				sessionId: opened.id,
			}),
		).toBeNull();
	});

	it("keeps owner_user bindings out of machine-credential lookup", async () => {
		const db = fixture();
		await ownerPrincipal(db);
		expect(
			await getExternalAgentPrincipalByCredential(db, {
				organizationId: ORG,
				credentialBindingId: OWNER,
			}),
		).toBeNull();
	});
});
