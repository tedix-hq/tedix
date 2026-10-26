import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { tokenExchangeGrants } from "../schema/token-exchange";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	consumeTokenExchangeGrant,
	insertTokenExchangeGrant,
	revokeTokenExchangeLineage,
} from "./token-exchange";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec(schemaDdl(tokenExchangeGrants));
	return createDbQueryClient(createD1Facade(sqlite));
}

const row = (
	jti: string,
	parentJti: string | null,
	organizationId = "org-a",
) => ({
	jti,
	parentJti,
	organizationId,
	subject: "user:member-1",
	actorChain: ["service:mcp", "tedi:tedi-1"],
	audience: "tedix:api",
	endpoint: "tedis/get",
	scopes: ["mcp:tedis.read", "tedis:read"],
	issuedAt: 1_000,
	expiresAt: 1_060,
});

describe("token exchange lineage", () => {
	it("consumes a token once, only in its organization and before expiry", async () => {
		const db = fixture();
		await insertTokenExchangeGrant(db, row("a", null));
		const at = "2026-10-26T10:00:00.000Z";
		expect(
			await consumeTokenExchangeGrant(db, {
				jti: "a",
				organizationId: "org-b",
				endpoint: "tedis/get",
				now: 1_010,
				at,
			}),
		).toBeNull();
		expect(
			await consumeTokenExchangeGrant(db, {
				jti: "a",
				organizationId: "org-a",
				endpoint: "tedis/get",
				now: 1_060,
				at,
			}),
		).toBeNull();
		expect(
			await consumeTokenExchangeGrant(db, {
				jti: "a",
				organizationId: "org-a",
				endpoint: "tedis/get",
				now: 1_010,
				at,
			}),
		).toMatchObject({ jti: "a", usedAt: at, endpoint: "tedis/get" });
		expect(
			await consumeTokenExchangeGrant(db, {
				jti: "a",
				organizationId: "org-a",
				endpoint: "tedis/get",
				now: 1_011,
				at,
			}),
		).toBeNull();
	});

	it("leaves a token unused when another procedure presents it", async () => {
		const db = fixture();
		await insertTokenExchangeGrant(db, row("a", null));
		const params = {
			jti: "a",
			organizationId: "org-a",
			now: 1_010,
			at: "2026-10-26T10:00:00.000Z",
		};
		expect(
			await consumeTokenExchangeGrant(db, {
				...params,
				endpoint: "tedis/update",
			}),
		).toBeNull();
		expect(
			await consumeTokenExchangeGrant(db, { ...params, endpoint: "tedis/get" }),
		).not.toBeNull();
	});

	it("revokes a token and its descendants, never another organization's", async () => {
		const db = fixture();
		await insertTokenExchangeGrant(db, row("root", null));
		await insertTokenExchangeGrant(db, row("child", "root"));
		await insertTokenExchangeGrant(db, row("grandchild", "child"));
		await insertTokenExchangeGrant(db, row("sibling", null));
		await insertTokenExchangeGrant(db, row("foreign", "root", "org-b"));
		const params = {
			organizationId: "org-a",
			revokedBy: "admin-1",
			at: "2026-10-26T10:00:00.000Z",
		};
		expect(
			(await revokeTokenExchangeLineage(db, { ...params, jti: "root" })).sort(),
		).toEqual(["child", "grandchild", "root"]);
		expect(
			await revokeTokenExchangeLineage(db, {
				...params,
				organizationId: "org-b",
				jti: "sibling",
			}),
		).toEqual([]);
		for (const jti of ["root", "grandchild"])
			expect(
				await consumeTokenExchangeGrant(db, {
					jti,
					organizationId: "org-a",
					endpoint: "tedis/get",
					now: 1_010,
					at: params.at,
				}),
			).toBeNull();
		expect(
			await consumeTokenExchangeGrant(db, {
				jti: "foreign",
				organizationId: "org-b",
				endpoint: "tedis/get",
				now: 1_010,
				at: params.at,
			}),
		).not.toBeNull();
	});
});
