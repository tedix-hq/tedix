import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { consumeExternalAgentWorkloadToken } from "./workload-tokens";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE external_agent_workload_token_uses (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			issuer TEXT NOT NULL,
			subject TEXT NOT NULL,
			audience TEXT NOT NULL,
			jti TEXT NOT NULL,
			external_session_key TEXT NOT NULL,
			token_issued_at TEXT NOT NULL,
			token_expires_at TEXT NOT NULL,
			consumed_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX uniq_external_agent_workload_issuer_jti
			ON external_agent_workload_token_uses (issuer, jti);
	`);
	return createDbQueryClient(createD1Facade(sqlite));
}

const base = {
	id: "use-1",
	organizationId: "org-1",
	principalId: "principal-1",
	issuer: "https://token.actions.githubusercontent.com",
	subject: "repo:tedix-hq/tedix:environment:production",
	audience: "https://api.tedix.dev/external-agent/session-exchange",
	jti: "run-1",
	externalSessionKey: "github-actions:123",
	tokenIssuedAt: "2026-08-24T00:00:00.000Z",
	tokenExpiresAt: "2026-08-24T00:05:00.000Z",
	consumedAt: "2026-08-24T00:00:01.000Z",
};

describe("consumeExternalAgentWorkloadToken", () => {
	it("atomically accepts an issuer+jti only once", async () => {
		const db = fixture();
		await expect(consumeExternalAgentWorkloadToken(db, base)).resolves.toBe(
			true,
		);
		await expect(
			consumeExternalAgentWorkloadToken(db, {
				...base,
				id: "use-2",
				externalSessionKey: "github-actions:replay",
			}),
		).resolves.toBe(false);
	});

	it("does not collide across distinct issuer token identifiers", async () => {
		const db = fixture();
		await expect(consumeExternalAgentWorkloadToken(db, base)).resolves.toBe(
			true,
		);
		await expect(
			consumeExternalAgentWorkloadToken(db, {
				...base,
				id: "use-2",
				jti: "run-2",
			}),
		).resolves.toBe(true);
	});
});
