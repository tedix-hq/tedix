import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	listActiveExternalAgentMcpCredentialsByServer,
	listActiveExternalAgentMcpCredentialsForSession,
	listReapableExternalAgentMcpCredentials,
	markExternalAgentMcpCredentialsReaped,
} from "./mcp-credentials";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE external_agent_mcp_credentials (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			client_record_id TEXT NOT NULL,
			mcp_server_id TEXT NOT NULL,
			mcp_server_url TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			issued_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			revoked_at TEXT
		);
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

function insert(
	sqlite: DatabaseSync,
	row: {
		id: string;
		client: string;
		server: string;
		status: string;
		expiresAt: string;
		organizationId?: string;
		principalId?: string;
		sessionId?: string;
		issuedAt?: string;
		revokedAt?: string | null;
	},
) {
	sqlite
		.prepare(
			`INSERT INTO external_agent_mcp_credentials
			 (id, organization_id, principal_id, session_id, client_record_id,
			  mcp_server_id, mcp_server_url, status, issued_at, expires_at, revoked_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'https://x.mcp.tedix.dev/mcp', ?, ?, ?, ?)`,
		)
		.run(
			row.id,
			row.organizationId ?? "org",
			row.principalId ?? "prin",
			row.sessionId ?? "sess",
			row.client,
			row.server,
			row.status,
			row.issuedAt ?? "2026-01-01T00:00:00.000Z",
			row.expiresAt,
			row.revokedAt ?? null,
		);
}

describe("listActiveExternalAgentMcpCredentialsForSession", () => {
	it("isolates active credentials by tenant, principal, and session newest-first", async () => {
		const { sqlite, db } = fixture();
		insert(sqlite, {
			id: "1",
			client: "target-old",
			server: "srv-a",
			status: "active",
			expiresAt: "2026-08-20T00:00:00.000Z",
			issuedAt: "2026-08-10T00:00:00.000Z",
		});
		insert(sqlite, {
			id: "2",
			client: "target-new",
			server: "srv-b",
			status: "active",
			expiresAt: "2026-08-20T00:00:00.000Z",
			issuedAt: "2026-08-11T00:00:00.000Z",
		});
		insert(sqlite, {
			id: "3",
			client: "other-tenant",
			server: "srv-a",
			status: "active",
			expiresAt: "2026-08-20T00:00:00.000Z",
			organizationId: "other-org",
		});
		insert(sqlite, {
			id: "4",
			client: "other-session",
			server: "srv-a",
			status: "active",
			expiresAt: "2026-08-20T00:00:00.000Z",
			sessionId: "other-session",
		});
		insert(sqlite, {
			id: "5",
			client: "revoked-target",
			server: "srv-a",
			status: "revoked",
			expiresAt: "2026-08-20T00:00:00.000Z",
			revokedAt: NOW,
		});

		const rows = await listActiveExternalAgentMcpCredentialsForSession(db, {
			organizationId: "org",
			principalId: "prin",
			sessionId: "sess",
		});

		expect(rows.map((row) => row.clientRecordId)).toEqual([
			"target-new",
			"target-old",
		]);
	});
});

const NOW = "2026-08-13T00:00:00.000Z";

describe("listActiveExternalAgentMcpCredentialsByServer", () => {
	it("returns only active credentials bound to the requested server", async () => {
		const { sqlite, db } = fixture();
		insert(sqlite, {
			id: "1",
			client: "active-a",
			server: "MS-a",
			status: "active",
			expiresAt: "2026-08-20T00:00:00.000Z",
		});
		insert(sqlite, {
			id: "2",
			client: "revoked-a",
			server: "MS-a",
			status: "revoked",
			expiresAt: "2026-08-19T00:00:00.000Z",
			revokedAt: NOW,
		});
		insert(sqlite, {
			id: "3",
			client: "active-b",
			server: "MS-b",
			status: "active",
			expiresAt: "2026-08-18T00:00:00.000Z",
		});

		const rows = await listActiveExternalAgentMcpCredentialsByServer(
			db,
			"MS-a",
		);

		expect(rows.map((row) => row.clientRecordId)).toEqual(["active-a"]);
	});
});

describe("listReapableExternalAgentMcpCredentials", () => {
	it("returns only active rows whose token already expired, oldest-first and bounded", async () => {
		const { sqlite, db } = fixture();
		insert(sqlite, {
			id: "1",
			client: "expired-old",
			server: "srv-a",
			status: "active",
			expiresAt: "2026-08-10T00:00:00.000Z",
		});
		insert(sqlite, {
			id: "2",
			client: "expired-new",
			server: "srv-b",
			status: "active",
			expiresAt: "2026-08-12T00:00:00.000Z",
		});
		insert(sqlite, {
			id: "3",
			client: "still-valid",
			server: "srv-a",
			status: "active",
			expiresAt: "2026-08-20T00:00:00.000Z",
		});
		insert(sqlite, {
			id: "4",
			client: "already-revoked",
			server: "srv-a",
			status: "revoked",
			expiresAt: "2026-08-01T00:00:00.000Z",
			revokedAt: "2026-08-02T00:00:00.000Z",
		});

		const reapable = await listReapableExternalAgentMcpCredentials(db, {
			expiredBefore: NOW,
			limit: 10,
		});

		expect(reapable.map((r) => r.clientRecordId)).toEqual([
			"expired-old",
			"expired-new",
		]);
		expect(reapable[0]).toEqual({
			clientRecordId: "expired-old",
			mcpServerId: "srv-a",
		});
	});

	it("respects the limit", async () => {
		const { sqlite, db } = fixture();
		for (let i = 0; i < 5; i++) {
			insert(sqlite, {
				id: `e${i}`,
				client: `c${i}`,
				server: "srv-a",
				status: "active",
				expiresAt: `2026-08-0${i + 1}T00:00:00.000Z`,
			});
		}
		const reapable = await listReapableExternalAgentMcpCredentials(db, {
			expiredBefore: NOW,
			limit: 2,
		});
		expect(reapable).toHaveLength(2);
	});
});

describe("markExternalAgentMcpCredentialsReaped", () => {
	it("revokes exactly the named active rows and returns the count", async () => {
		const { sqlite, db } = fixture();
		insert(sqlite, {
			id: "1",
			client: "reap-a",
			server: "srv-a",
			status: "active",
			expiresAt: "2026-08-10T00:00:00.000Z",
		});
		insert(sqlite, {
			id: "2",
			client: "reap-b",
			server: "srv-a",
			status: "active",
			expiresAt: "2026-08-10T00:00:00.000Z",
		});
		insert(sqlite, {
			id: "3",
			client: "keep",
			server: "srv-a",
			status: "active",
			expiresAt: "2026-08-10T00:00:00.000Z",
		});

		const revoked = await markExternalAgentMcpCredentialsReaped(db, {
			clientRecordIds: ["reap-a", "reap-b"],
			revokedAt: NOW,
		});

		expect(revoked).toBe(2);
		const rows = sqlite
			.prepare(
				"SELECT client_record_id, status, revoked_at FROM external_agent_mcp_credentials ORDER BY client_record_id",
			)
			.all() as Array<{
			client_record_id: string;
			status: string;
			revoked_at: string | null;
		}>;
		expect(rows).toEqual([
			{ client_record_id: "keep", status: "active", revoked_at: null },
			{ client_record_id: "reap-a", status: "revoked", revoked_at: NOW },
			{ client_record_id: "reap-b", status: "revoked", revoked_at: NOW },
		]);
	});

	it("does not re-revoke a row that is already revoked", async () => {
		const { sqlite, db } = fixture();
		insert(sqlite, {
			id: "1",
			client: "already",
			server: "srv-a",
			status: "revoked",
			expiresAt: "2026-08-10T00:00:00.000Z",
			revokedAt: "2026-08-05T00:00:00.000Z",
		});
		const revoked = await markExternalAgentMcpCredentialsReaped(db, {
			clientRecordIds: ["already"],
			revokedAt: NOW,
		});
		expect(revoked).toBe(0);
	});
});
