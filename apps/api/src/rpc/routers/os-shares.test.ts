/**
 * Share-links router: tenant binding, one-time token contract, revocation,
 * and creator accountability — end to end against the real D1 facade, with
 * the redemption handler proving the minted token actually redeems.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { osShareLinks, osShareSessions } from "@tedix/db/schema/os-shares";
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
import { beforeEach, describe, expect, it } from "vite-plus/test";
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

function harness() {
	const env = createEnv();
	return {
		env,
		org1: createRouterClient(osSharesContractRouter, {
			context: userContext(env, "org-1"),
		}),
		org2: createRouterClient(osSharesContractRouter, {
			context: userContext(env, "org-2"),
		}),
		machine: createRouterClient(osSharesContractRouter, {
			context: apiKeyContext(env, "org-1"),
		}),
		outputs: createRouterClient(osWorkspacesContractRouter, {
			context: userContext(env, "org-1"),
		}),
	};
}

async function seedOutput(h: ReturnType<typeof harness>): Promise<string> {
	const { output } = await h.outputs.outputs.create({
		kind: "document",
		title: "Launch brief",
		content: { kind: "document", blocks: [] },
	});
	return output.id;
}

function outputShareInput(outputId: string) {
	return { resourceType: "output" as const, resourceId: outputId };
}

describe("verb matrix", () => {
	it("os:author mints and revokes links, os:read lists them, and neither crosses over", async () => {
		const h = harness();
		const outputId = await seedOutput(h);
		const author = createRouterClient(osSharesContractRouter, {
			context: userContext(h.env, "org-1", ["os:author"]),
		});
		const reader = createRouterClient(osSharesContractRouter, {
			context: userContext(h.env, "org-1", ["os:read"]),
		});

		const { share } = await author.shares.create(outputShareInput(outputId));
		await expect(
			reader.shares.list(outputShareInput(outputId)),
		).resolves.toMatchObject({
			items: [{ id: share.id }],
		});

		await expect(
			reader.shares.create(outputShareInput(outputId)),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			reader.shares.revoke({ shareId: share.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			author.shares.list(outputShareInput(outputId)),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		await expect(
			author.shares.revoke({ shareId: share.id }),
		).resolves.toMatchObject({ share: { revokedAt: expect.any(String) } });
	});
});

describe("shares.create", () => {
	let h: ReturnType<typeof harness>;
	let outputId: string;
	beforeEach(async () => {
		h = harness();
		outputId = await seedOutput(h);
	});

	it("mints a viewer link, returns the plaintext once, persists only the hash", async () => {
		const { share, token } = await h.org1.shares.create(
			outputShareInput(outputId),
		);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(share).toMatchObject({
			organizationId: "org-1",
			resourceType: "output",
			resourceId: outputId,
			role: "viewer",
			createdByKind: "user",
			createdById: "user-1",
			expiresAt: null,
			revokedAt: null,
			revisionMode: "living",
			pinnedRevisionId: null,
		});
		// The wire share never carries token material.
		expect(JSON.stringify(share)).not.toContain(token);
		expect(JSON.stringify(share)).not.toContain(await hashOsShareToken(token));
		// And the minted token actually redeems through the public handler.
		const redeemed = await handleOsShareRedemption(
			createDbQueryClient(h.env.DB),
			token,
		);
		expect(redeemed.status).toBe(200);
		expect(await redeemed.json()).toMatchObject({
			share: { role: "viewer", effectiveRole: "viewer" },
			resource: {
				type: "output",
				output: { id: outputId, title: "Launch brief", kind: "document" },
				revision: { revision: 1 },
			},
			sessionToken: expect.any(String),
		});
	});

	it("refuses a foreign org's output and a past expiry", async () => {
		await expect(
			h.org2.shares.create(outputShareInput(outputId)),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			h.org1.shares.create({
				...outputShareInput(outputId),
				expiresAt: "2020-01-01T00:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("stores a future expiry and records machine principals as service", async () => {
		const future = "2099-01-01T00:00:00.000Z";
		const { share } = await h.machine.shares.create({
			...outputShareInput(outputId),
			expiresAt: future,
		});
		expect(share).toMatchObject({
			expiresAt: future,
			createdByKind: "service",
			createdById: "key-1",
		});
	});
});

describe("shares.list", () => {
	it("lists the output's links org-scoped, including revoked ones", async () => {
		const h = harness();
		const outputId = await seedOutput(h);
		const first = await h.org1.shares.create(outputShareInput(outputId));
		await h.org1.shares.create(outputShareInput(outputId));
		await h.org1.shares.revoke({ shareId: first.share.id });

		const { items } = await h.org1.shares.list(outputShareInput(outputId));
		expect(items).toHaveLength(2);
		expect(
			items.filter((item) => item.revokedAt !== null).map((item) => item.id),
		).toEqual([first.share.id]);
		await expect(
			h.org2.shares.list(outputShareInput(outputId)),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
});

describe("shares.revoke", () => {
	it("kills redemption, is idempotent, and stays tenant-bound", async () => {
		const h = harness();
		const outputId = await seedOutput(h);
		const { share, token } = await h.org1.shares.create(
			outputShareInput(outputId),
		);
		const db = createDbQueryClient(h.env.DB);
		const opened = (await (
			await handleOsShareRedemption(db, token)
		).json()) as { sessionToken: string };

		await expect(
			h.org2.shares.revoke({ shareId: share.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			(await handleOsShareSessionRead(db, opened.sessionToken)).status,
		).toBe(200);

		const revoked = await h.org1.shares.revoke({ shareId: share.id });
		expect(revoked.share.revokedAt).toBeTruthy();
		expect((await handleOsShareRedemption(db, token)).status).toBe(404);

		// Idempotent: a second revoke keeps the original timestamp.
		const again = await h.org1.shares.revoke({ shareId: share.id });
		expect(again.share.revokedAt).toBe(revoked.share.revokedAt);
	});

	it("requires revocation before permanent deletion and preserves the audit id", async () => {
		const h = harness();
		const outputId = await seedOutput(h);
		const { share } = await h.org1.shares.create(outputShareInput(outputId));

		await expect(
			h.org1.shares.delete({ shareId: share.id }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await h.outputs.outputs.archive({ outputId });
		await expect(h.outputs.outputs.delete({ outputId })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await h.org1.shares.revoke({ shareId: share.id });
		await expect(
			h.org2.shares.delete({ shareId: share.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(h.org1.shares.delete({ shareId: share.id })).resolves.toEqual({
			deleted: true,
		});
		await expect(
			h.org1.shares.previewRevoke({ shareId: share.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(h.outputs.outputs.delete({ outputId })).resolves.toEqual({
			deleted: true,
		});
	});
});

describe("governed resource roles and revision modes", () => {
	it("mints use/build Gadget links, validates pins, and rejects invalid role shapes", async () => {
		const h = harness();
		const { workspace } = await h.outputs.workspaces.create({
			name: "Launch workspace",
		});
		const { gadget } = await h.outputs.gadgets.create({
			workspaceId: workspace.id,
			name: "Launch dashboard",
		});
		const { revision } = await h.outputs.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest: {
				entry: "ui://widgets/mcp-app/tedix/r/launch.html",
				capabilities: ["metrics.read"],
			},
		});
		const use = await h.org1.shares.create({
			resourceType: "gadget",
			resourceId: gadget.id,
			role: "use",
			revisionMode: "living",
		});
		const build = await h.org1.shares.create({
			resourceType: "gadget",
			resourceId: gadget.id,
			role: "build",
			revisionMode: "pinned",
			pinnedRevisionId: revision.id,
			note: "Approved collaborator",
		});
		expect(use.share).toMatchObject({ role: "use", revisionMode: "living" });
		expect(build.share).toMatchObject({
			role: "build",
			revisionMode: "pinned",
			pinnedRevisionId: revision.id,
			note: "Approved collaborator",
		});
		const db = createDbQueryClient(h.env.DB);
		const opened = (await (
			await handleOsShareRedemption(db, build.token, async () => true)
		).json()) as { sessionToken: string };
		await expect(
			h.org1.shares.restrict({
				shareId: build.share.id,
				maxRole: "use",
				reason: "Sensitive observation",
			}),
		).resolves.toMatchObject({
			share: { policyMaxRole: "use" },
			revokedSessionCount: 1,
		});
		expect(
			(
				await handleOsShareSessionRead(
					db,
					opened.sessionToken,
					async () => true,
				)
			).status,
		).toBe(404);
		await expect(
			h.org1.shares.restrict({
				shareId: build.share.id,
				maxRole: "build",
				reason: "Attempted widening",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const callRestrictWithInvalidInput = h.org1.shares.restrict as (
			input: unknown,
		) => Promise<unknown>;
		await expect(
			callRestrictWithInvalidInput({
				shareId: build.share.id,
				maxRole: null,
				reason: "Attempted clear",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			h.org1.shares.create({
				resourceType: "gadget",
				resourceId: gadget.id,
				role: "viewer",
				revisionMode: "living",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			h.org1.shares.create({
				resourceType: "output",
				resourceId: crypto.randomUUID(),
				role: "build",
				revisionMode: "living",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("previews live sessions, narrows policy, and reports evicted sessions", async () => {
		const h = harness();
		const outputId = await seedOutput(h);
		const { share, token } = await h.org1.shares.create(
			outputShareInput(outputId),
		);
		const db = createDbQueryClient(h.env.DB);
		await handleOsShareRedemption(db, token);
		await handleOsShareRedemption(db, token);
		await expect(
			h.org1.shares.previewRevoke({ shareId: share.id }),
		).resolves.toMatchObject({ activeSessionCount: 2 });
		await expect(
			h.org1.shares.restrict({
				shareId: share.id,
				maxRole: "viewer",
				reason: "Sensitive observation",
			}),
		).resolves.toMatchObject({
			share: {
				policyMaxRole: "viewer",
				policyReason: "Sensitive observation",
			},
		});
		await expect(
			h.org1.shares.revoke({ shareId: share.id }),
		).resolves.toMatchObject({ revokedSessionCount: 2 });
	});

	it("freezes a pinned workspace snapshot while canonical state evolves", async () => {
		const h = harness();
		const { workspace } = await h.outputs.workspaces.create({
			name: "Pinned workspace",
		});
		const first = await h.outputs.gadgets.create({
			workspaceId: workspace.id,
			name: "First Gadget",
		});
		await h.outputs.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: first.gadget.id,
			manifest: {
				entry: "ui://widgets/mcp-app/tedix/r/first.html",
				capabilities: [],
			},
		});
		const { token } = await h.org1.shares.create({
			resourceType: "workspace",
			resourceId: workspace.id,
			role: "use",
			revisionMode: "pinned",
		});
		await h.outputs.gadgets.create({
			workspaceId: workspace.id,
			name: "Second Gadget",
		});
		const body = (await (
			await handleOsShareRedemption(
				createDbQueryClient(h.env.DB),
				token,
				async () => true,
			)
		).json()) as {
			resource: { gadgets: Array<{ name: string }> };
		};
		expect(body.resource.gadgets.map((gadget) => gadget.name)).toEqual([
			"First Gadget",
		]);
	});
});
