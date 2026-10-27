/**
 * Share-links router: tenant binding, one-time token contract, revocation,
 * and creator accountability — end to end against the real D1 facade, with
 * the redemption handler proving the minted token actually redeems.
 */

import { organizations } from "@tedix/db/schema/organizations";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osShareLinkInvitees,
	osShareLinks,
	osShareSessions,
} from "@tedix/db/schema/os-shares";
import { kernelRuntimeRuns } from "@tedix/db/schema/cognitive-runtime";
import {
	osGadgetRevisions,
	osGadgets,
	osCollaborationProposals,
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { createDbQueryClient } from "@tedix/db/query-client";
import { eq } from "drizzle-orm";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
	handleOsShareOpen,
	handleOsShareRedemption,
	handleOsShareSessionRead,
	hashOsShareToken,
} from "../../lib/os-share-redemption";
import { bindTestContexts } from "../test-context";
import { osSharesContractRouter } from "./os-shares";
import { osWorkspacesContractRouter } from "./os-workspaces";

function createEnv(): CloudflareEnv {
	const sqlite = new DatabaseSync(":memory:");
	// Tenant predicates are exercised below; unrelated FK parents are omitted.
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			organizations,
			osOutputs,
			osOutputRevisions,
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osCollaborationProposals,
			osShareLinks,
			osShareSessions,
			osShareLinkInvitees,
			organizationMembers,
			auditEvents,
			kernelRuntimeRuns,
		),
	);
	// Share URLs name the organization's own OS host by slug.
	sqlite.exec(
		"INSERT INTO organizations (id, name, slug, descope_tenant_id) VALUES ('org-1', 'First Org', 'first', 'tenant-1'), ('org-2', 'Second Org', 'second', 'tenant-2');",
	);
	return {
		ENVIRONMENT: "test",
		API_URL: "https://api.tedix.test",
		OS_URL: "https://os.tedix.test",
		DB: createD1Facade(sqlite),
	} as CloudflareEnv;
}

const { userContext, apiKeyContext } = bindTestContexts({
	url: "https://api.tedix.test/rpc/os-shares",
	user: { permissions: ["settings:manage"] },
	apiKey: { scopes: ["apps:read", "apps:write"] },
});

function harness() {
	const env = createEnv();
	return {
		env,
		org1: createRouterClient(osSharesContractRouter, {
			context: userContext({ env, organizationId: "org-1" }),
		}),
		org2: createRouterClient(osSharesContractRouter, {
			context: userContext({ env, organizationId: "org-2" }),
		}),
		machine: createRouterClient(osSharesContractRouter, {
			context: apiKeyContext({ env, organizationId: "org-1" }),
		}),
		outputs: createRouterClient(osWorkspacesContractRouter, {
			context: userContext({ env, organizationId: "org-1" }),
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
			context: userContext({
				env: h.env,
				organizationId: "org-1",
				permissions: ["os:author"],
			}),
		});
		const reader = createRouterClient(osSharesContractRouter, {
			context: userContext({
				env: h.env,
				organizationId: "org-1",
				permissions: ["os:read"],
			}),
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

	it("waits for review when the Home run that saved the version read sensitive data", async () => {
		const db = createDbQueryClient(h.env.DB);
		const [output] = await db
			.select({ currentRevisionId: osOutputs.currentRevisionId })
			.from(osOutputs)
			.where(eq(osOutputs.id, outputId));
		await db.insert(kernelRuntimeRuns).values({
			id: "home-author",
			organizationId: "org-1",
			conversationId: "conv-1",
			status: "completed",
			createdAt: "2026-10-27",
			updatedAt: "2026-10-27",
			metadata: {
				kernelOutputReceipt: {
					outputId,
					revisionId: output!.currentRevisionId!,
				},
			},
			outputRevisionId: output!.currentRevisionId!,
			sensitiveDataLatch: {
				version: 1,
				latchedAt: "2026-10-27T10:00:00.000Z",
				source: {
					appSlug: "hr",
					toolId: "list_salaries",
					connectionProviderId: "hr-system",
					reason: "connection_restricted",
				},
			},
		});
		await expect(
			h.org1.shares.create(outputShareInput(outputId)),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("clear_run_sensitive_data_latch"),
		});
		await db
			.update(kernelRuntimeRuns)
			.set({ sensitiveDataLatch: null })
			.where(eq(kernelRuntimeRuns.id, "home-author"));
		await expect(
			h.org1.shares.create(outputShareInput(outputId)),
		).resolves.toMatchObject({ share: { resourceId: outputId } });
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

describe("shares.update", () => {
	it("edits note, expiry and role in place; only admins may, and narrowing ends sessions", async () => {
		const h = harness();
		const { workspace } = await h.outputs.workspaces.create({
			name: "Launch workspace",
		});
		const { gadget } = await h.outputs.gadgets.create({
			workspaceId: workspace.id,
			name: "Launch dashboard",
		});
		await h.outputs.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest: {
				entry: "ui://widgets/mcp-app/tedix/r/launch.html",
				capabilities: ["metrics.read"],
			},
		});
		const { share, token } = await h.org1.shares.create({
			resourceType: "gadget",
			resourceId: gadget.id,
			role: "build",
			revisionMode: "living",
			note: "For the launch team",
		});
		const author = createRouterClient(osSharesContractRouter, {
			context: userContext({
				env: h.env,
				organizationId: "org-1",
				permissions: ["os:author"],
			}),
		});
		await expect(
			author.shares.update({ shareId: share.id, note: "Mine now" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			h.org2.shares.update({ shareId: share.id, note: "Elsewhere" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const db = createDbQueryClient(h.env.DB);
		const opened = (await (
			await handleOsShareRedemption(db, token, async () => true)
		).json()) as { sessionToken: string };

		// A note-only edit keeps live sessions and the same link.
		const renamed = await h.org1.shares.update({
			shareId: share.id,
			note: "Launch reviewers",
		});
		expect(renamed).toMatchObject({
			share: { id: share.id, note: "Launch reviewers", role: "build" },
			revokedSessionCount: 0,
		});
		expect(renamed).not.toHaveProperty("token");
		expect(
			(
				await handleOsShareSessionRead(
					db,
					opened.sessionToken,
					async () => true,
				)
			).status,
		).toBe(200);

		const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
		const narrowed = await h.org1.shares.update({
			shareId: share.id,
			role: "use",
			expiresAt,
			note: null,
		});
		expect(narrowed).toMatchObject({
			share: { role: "use", note: null, expiresAt },
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
		// The same token still redeems, now at the narrowed role.
		expect(
			(await handleOsShareRedemption(db, token, async () => true)).status,
		).toBe(200);

		await expect(
			h.org1.shares.update({ shareId: share.id, role: "viewer" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			h.org1.shares.update({
				shareId: share.id,
				expiresAt: new Date(Date.now() - 1000).toISOString(),
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			h.org1.shares.update({ shareId: share.id, expiresAt: null }),
		).resolves.toMatchObject({ share: { expiresAt: null } });

		await h.org1.shares.revoke({ shareId: share.id });
		await expect(
			h.org1.shares.update({ shareId: share.id, note: "Back on" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("returns the permanent address, changes the audience in place, and tightening ends sessions", async () => {
		const h = harness();
		const outputId = await seedOutput(h);
		const { share, token } = await h.org1.shares.create(
			outputShareInput(outputId),
		);
		expect(share.publicId).toMatch(/^[A-Za-z0-9]{22}$/);
		expect(share).toMatchObject({
			access: "anyone_with_link",
			url: `https://first.os.tedix.test/s/${share.publicId}`,
		});
		const db = createDbQueryClient(h.env.DB);
		const opened = (await (
			await handleOsShareOpen(db, share.publicId, "tenant-1")
		).json()) as { sessionToken: string; share: { publicId: string } };
		expect(opened.share.publicId).toBe(share.publicId);
		// The old token still redeems and names the same permanent id.
		await expect(
			(await handleOsShareRedemption(db, token)).json(),
		).resolves.toMatchObject({ share: { publicId: share.publicId } });

		const tightened = await h.org1.shares.update({
			shareId: share.id,
			access: "organization",
		});
		expect(tightened).toMatchObject({
			share: {
				publicId: share.publicId,
				url: share.url,
				access: "organization",
			},
			revokedSessionCount: 2,
		});
		expect(
			(await handleOsShareSessionRead(db, opened.sessionToken)).status,
		).toBe(404);
		// The same address now asks visitors to sign in.
		await expect(
			(await handleOsShareOpen(db, share.publicId, "tenant-1")).json(),
		).resolves.toMatchObject({ needsSignIn: true, access: "organization" });
		// Widening back cuts nobody off.
		await expect(
			h.org1.shares.update({ shareId: share.id, access: "anyone_with_link" }),
		).resolves.toMatchObject({
			share: { access: "anyone_with_link" },
			revokedSessionCount: 0,
		});
	});

	it("keeps output links viewer-only", async () => {
		const h = harness();
		const outputId = await seedOutput(h);
		const { share } = await h.org1.shares.create(outputShareInput(outputId));
		await expect(
			h.org1.shares.update({ shareId: share.id, role: "use" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("shares.invitees", () => {
	it("admins keep an invite list that decides who an invited link admits", async () => {
		const h = harness();
		const outputId = await seedOutput(h);
		const db = createDbQueryClient(h.env.DB);
		await db.insert(organizationMembers).values({
			id: "m-kai",
			organizationId: "org-2",
			descopeUserId: "kai-user",
			email: "kai@example.test",
			name: "Kai",
			role: "member",
			status: "active",
			kind: "human",
		});
		const { share } = await h.org1.shares.create({
			...outputShareInput(outputId),
			access: "invited",
		});
		const author = createRouterClient(osSharesContractRouter, {
			context: userContext({
				env: h.env,
				organizationId: "org-1",
				permissions: ["os:author"],
			}),
		});
		await expect(
			author.shares.invitees.add({
				shareId: share.id,
				email: "kai@example.test",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			h.org2.shares.invitees.list({ shareId: share.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// A known Tedix person is bound by user id as well; emails are lowercased.
		const { invitee } = await h.org1.shares.invitees.add({
			shareId: share.id,
			email: "Kai@Example.test",
		});
		expect(invitee).toMatchObject({
			shareLinkId: share.id,
			email: "kai@example.test",
			userId: "kai-user",
			name: "Kai",
			addedByKind: "user",
			addedById: "user-1",
		});
		const { invitee: again } = await h.org1.shares.invitees.add({
			shareId: share.id,
			email: "kai@example.test",
		});
		expect(again.id).toBe(invitee.id);
		const { invitee: outsider } = await h.org1.shares.invitees.add({
			shareId: share.id,
			email: "someone@else.test",
		});
		expect(outsider).toMatchObject({ userId: null, name: null });
		await expect(
			h.org1.shares.invitees.list({ shareId: share.id }),
		).resolves.toMatchObject({
			items: [{ id: invitee.id }, { id: outsider.id }],
		});

		const asKai = async () => ({ userId: "kai-user", email: null });
		const asStranger = async () => ({
			userId: "stranger",
			email: "stranger@else.test",
		});
		expect(
			(
				await handleOsShareOpen(
					db,
					share.publicId,
					"tenant-1",
					undefined,
					asStranger,
				)
			).status,
		).toBe(404);
		const opened = await handleOsShareOpen(
			db,
			share.publicId,
			"tenant-1",
			undefined,
			asKai,
		);
		expect(opened.status).toBe(200);
		const { sessionToken } = (await opened.json()) as {
			sessionToken: string;
		};

		await expect(
			h.org1.shares.invitees.remove({
				shareId: share.id,
				inviteeId: invitee.id,
			}),
		).resolves.toEqual({ removed: true });
		await expect(
			h.org1.shares.invitees.remove({
				shareId: share.id,
				inviteeId: invitee.id,
			}),
		).resolves.toEqual({ removed: false });
		expect(
			(await handleOsShareSessionRead(db, sessionToken, undefined, asKai))
				.status,
		).toBe(404);
		await expect(
			h.org1.shares.invitees.list({ shareId: share.id }),
		).resolves.toMatchObject({ items: [{ id: outsider.id }] });
	});
});
