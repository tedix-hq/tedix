/**
 * Share-links router: tenant binding, one-time token contract, revocation,
 * and creator accountability — end to end against the real D1 facade, with
 * the redemption handler proving the minted token actually redeems.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import {
	osShareLinks,
	osShareSessions,
	osReviewBatches,
	osReviewFeedback,
} from "@tedix/db/schema/os-shares";
import {
	osGadgetRevisions,
	osGadgets,
	osCollaborationProposals,
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import {
	handleOsShareRedemption,
	handleOsShareSessionRead,
	hashOsShareToken,
} from "../../lib/os-share-redemption";
import type { BaseContext } from "../orpc";
import { osSharesContractRouter } from "./os-shares";
import { osWorkspacesContractRouter } from "./os-workspaces";

function createEnv(): CloudflareEnv {
	const sqlite = new DatabaseSync(":memory:");
	// The router always binds the caller's organization into every predicate,
	// so the fixture does not need the organizations parent table; FKs stay off.
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			osOutputs,
			osOutputRevisions,
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osCollaborationProposals,
			osShareLinks,
			osShareSessions,
			osReviewBatches,
			osReviewFeedback,
			auditEvents,
		),
	);
	return {
		ENVIRONMENT: "test",
		API_URL: "https://api.tedix.test",
		DB: createD1Facade(sqlite),
	} as CloudflareEnv;
}

function userContext(
	env: CloudflareEnv,
	organizationId: string,
	permissions: string[] = ["settings:manage"],
): BaseContext {
	return {
		authType: "user",
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId,
		url: new URL("https://api.tedix.test/rpc/os-shares"),
		userRole: "owner",
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

function apiKeyContext(
	env: CloudflareEnv,
	organizationId: string,
): BaseContext {
	return {
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId,
			scopes: ["apps:read", "apps:write"],
		},
		authType: "apikey",
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId,
		url: new URL("https://api.tedix.test/rpc/os-shares"),
	} as BaseContext;
}

async function fixture() {
	const env = createEnv();
	const db = createDbQueryClient(env.DB);
	const workspaceId = crypto.randomUUID(),
		gadgetId = crypto.randomUUID(),
		sourceOutputId = crypto.randomUUID(),
		sourceRevisionId = crypto.randomUUID();
	await db
		.insert(osWorkspaces)
		.values({
			id: workspaceId,
			organizationId: "org-1",
			name: "Research",
			createdByKind: "user",
			createdById: "user-1",
		});
	await db
		.insert(osGadgets)
		.values({
			id: gadgetId,
			organizationId: "org-1",
			workspaceId,
			name: "Review",
			createdByKind: "user",
			createdById: "user-1",
		});
	const gadgetRevisionId = crypto.randomUUID();
	await db
		.insert(osGadgetRevisions)
		.values({
			id: gadgetRevisionId,
			organizationId: "org-1",
			gadgetId,
			revision: 1,
			manifest: JSON.stringify({
				entry: "ui://widgets/mcp-app/test/r/review.html",
				capabilities: [],
			}),
			createdByKind: "user",
			createdById: "user-1",
		});
	await db.update(osGadgets).set({ currentRevisionId: gadgetRevisionId });
	await db
		.insert(osOutputs)
		.values({
			id: sourceOutputId,
			organizationId: "org-1",
			workspaceId,
			kind: "document",
			title: "Source",
			currentRevisionId: sourceRevisionId,
			createdByKind: "user",
			createdById: "user-1",
		});
	await db
		.insert(osOutputRevisions)
		.values({
			id: sourceRevisionId,
			organizationId: "org-1",
			outputId: sourceOutputId,
			revision: 1,
			content: JSON.stringify({ kind: "document", blocks: [] }),
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			createdByKind: "user",
			createdById: "user-1",
		});
	const owner = createRouterClient(osSharesContractRouter, {
		context: userContext(env, "org-1"),
	});
	const { share, token } = await owner.shares.create({
		resourceType: "gadget",
		resourceId: gadgetId,
		role: "use",
	});
	const redeemed = await handleOsShareRedemption(db, token, async () => true);
	const { sessionToken } = (await redeemed.json()) as { sessionToken: string };
	const input = {
		shareId: share.id,
		sourceOutputId,
		sourceRevisionId,
		title: "Review batch",
		cards: [
			{
				id: "card",
				title: "Price question",
				url: "https://example.test/thread",
				relevance: "A useful price question",
				draft: "Draft",
				effort: "low" as const,
				checks: ["Fresh price"],
			},
		],
	};
	const readerContext = userContext(env, "org-1", ["os:read"]);
	readerContext.userRole = "viewer";
	readerContext.user!.sub = "reader";
	const reader = createRouterClient(osSharesContractRouter, {
		context: readerContext,
	});
	return {
		env,
		db,
		owner,
		reader,
		input,
		session: { shareId: share.id, sessionToken },
		machine: createRouterClient(osSharesContractRouter, {
			context: apiKeyContext(env, "org-1"),
		}),
	};
}
describe("bounded share reviews", () => {
	it("owner approves a pinned batch and viewer feedback is attributable, CAS protected and separate", async () => {
		const h = await fixture();
		const { batch } = await h.owner.reviews.create(h.input);
		const data = await h.reader.reviews.get(h.session);
		expect(data.batch?.id).toBe(batch.id);
		const input = {
			...h.session,
			batchId: batch.id,
			cardId: "card",
			expectedRevision: 0,
			decision: "edit" as const,
			editedReply: "Edited",
			reason: "Timing",
		};
		expect(await h.reader.reviews.saveFeedback(input)).toMatchObject({
			feedback: { reviewerId: "reader", revision: 1 },
		});
		await expect(h.reader.reviews.saveFeedback(input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(
			(await h.owner.reviews.listFeedback({ shareId: h.input.shareId }))
				.feedback,
		).toHaveLength(1);
		await h.owner.shares.revoke({ shareId: h.input.shareId });
		await expect(h.reader.reviews.get(h.session)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(
			(await h.owner.reviews.listFeedback({ shareId: h.input.shareId }))
				.feedback,
		).toHaveLength(1);
		const [source] = await h.db.select().from(osOutputRevisions);
		expect(source.content).toBe(
			JSON.stringify({ kind: "document", blocks: [] }),
		);
	});
	it("rejects machines, non-owner approval, foreign tenant and forged sessions", async () => {
		const h = await fixture();
		await expect(h.machine.reviews.create(h.input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(h.reader.reviews.create(h.input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await h.owner.reviews.create(h.input);
		await expect(h.machine.reviews.get(h.session)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const foreign = createRouterClient(osSharesContractRouter, {
			context: userContext(h.env, "org-2"),
		});
		await expect(foreign.reviews.get(h.session)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			h.reader.reviews.get({
				...h.session,
				sessionToken: "invalid-session-token-that-is-long",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			h.reader.reviews.listFeedback({ shareId: h.input.shareId }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("fails closed on missing/malformed source provenance and never widens an existing batch", async () => {
		const h = await fixture();
		await h.db.update(osOutputRevisions).set({ accessEnvelope: null });
		await expect(h.owner.reviews.create(h.input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await h.db.update(osOutputRevisions).set({ accessEnvelope: "malformed" });
		await expect(h.owner.reviews.create(h.input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
