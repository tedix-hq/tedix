import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { supportConfiguration, supportTickets } from "@tedix/db/schema/support";
import { projects } from "@tedix/db/schema/projects";
import { organizations } from "@tedix/db/schema/organizations";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import {
	workItems,
	workEvents,
	workItemComments,
} from "@tedix/db/schema/work-items";
import {
	SupportConfigurationSchema,
	SupportReportSchema,
} from "@tedix/api-contract/schemas/support";
import {
	redactSupportReport,
	supportPayloadDigest,
} from "@tedix/api-contract/utils/support-report";
import { putSupportConfiguration } from "@tedix/db/queries/support";
import { supportContractRouter } from "./support";
import { syncSupportDraftFromCard } from "../../services/support-draft-decision";
import type { BaseContext } from "../orpc";
const tenant = "11111111-1111-4111-8111-111111111111",
	platform = "22222222-2222-4222-8222-222222222222",
	worker = "33333333-3333-4333-8333-333333333333";
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			organizations,
			supportConfiguration,
			supportTickets,
			projects,
			workItems,
			workEvents,
			workItemComments,
			workInteractions,
			organizationMembers,
			tedis,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(tedis).values({
		id: worker,
		organizationId: platform,
		name: "Support",
		slug: "support",
	});
	await db.insert(organizationMembers).values({
		id: "admin-membership",
		organizationId: platform,
		userId: "admin",
		descopeUserId: "admin",
		email: "admin@acme.test",
		role: "owner",
		status: "active",
	});
	await putSupportConfiguration(
		db,
		SupportConfigurationSchema.parse({
			platformOrgId: platform,
			supportTediId: worker,
			adminUserId: "admin",
		}),
		new Date().toISOString(),
	);
	const context = (overrides: Partial<BaseContext> = {}) =>
		({
			db,
			env: {},
			headers: new Headers(),
			authType: "user",
			organizationId: tenant,
			userId: "reporter",
			user: { sub: "reporter" },
			...overrides,
		}) as BaseContext;
	const client = (overrides: Partial<BaseContext> = {}) =>
		createRouterClient(supportContractRouter, { context: context(overrides) });
	return { sqlite, client, context };
}
async function request() {
	const report = redactSupportReport(
		SupportReportSchema.parse({
			title: "How do I connect?",
			expected: "Connect",
			actual: "A safe error",
			observedAt: "2026-10-17T10:00:00Z",
			origin: "agent",
		}),
	);
	return {
		idempotencyKey: "request-1",
		report,
		consent: {
			approved: true as const,
			reference: "explicit user instruction",
			payloadDigest: await supportPayloadDigest(report),
		},
	};
}
describe("Support intake authorization and human publication", () => {
	it("returns a safe client error when redaction expands a report past its limits", async () => {
		const { client, sqlite } = await fixture();
		const input = await request();
		await expect(
			client().file({
				...input,
				report: {
					...input.report,
					title: ["a", "b.test "].join("@").repeat(22),
				},
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"Redacted support report is invalid: title. Preview and approve a valid redacted report.",
		});
		expect(
			sqlite.prepare("SELECT count(*) n FROM support_tickets").get(),
		).toEqual({ n: 0 });
	});
	it("returns a conflict for an inactive Support project", async () => {
		const { client, sqlite } = await fixture();
		sqlite
			.prepare(
				"INSERT INTO projects (id,org_id,key,name,status,created_at) VALUES (?,?,?,?,?,?)",
			)
			.run(
				"paused-project",
				tenant,
				"SUPPORT",
				"Support",
				"paused",
				"2026-10-17T10:00:00Z",
			);
		await expect(client().file(await request())).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Support project is unavailable"),
		});
	});
	it("returns a conflict for malformed saved configuration", async () => {
		const { client, sqlite } = await fixture();
		sqlite
			.prepare("UPDATE support_configuration SET configuration = ?")
			.run(JSON.stringify({ enabled: true }));
		await expect(client().file(await request())).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Support configuration is invalid"),
		});
	});
	it("rejects changed/unapproved payloads and cross-tenant or other-reporter status reads", async () => {
		const { client } = await fixture(),
			input = await request();
		await expect(
			client().file({
				...input,
				report: { ...input.report, actual: "new data" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const receipt = await client().file(input);
		expect(receipt.mirrorDelivery).toBe("delivered");
		expect(await client().file(input)).toEqual(receipt);
		for (const override of [
			{ organizationId: platform },
			{ userId: "another-user", user: { sub: "another-user" } },
		])
			await expect(
				client(override).status({ ticketId: receipt.ticketId }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(client().queue({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client().file({
				...input,
				report: { ...input.report, title: "different" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it("lets only the designated Support tedi draft, keeps the draft private, and requires the designated human to publish", async () => {
		const { client, sqlite } = await fixture(),
			receipt = await client().file(await request());
		const asWorker = {
			authType: "tedi",
			user: undefined,
			userId: undefined,
			serviceAccount: { clientId: "support-test" },
			organizationId: platform,
			tediId: worker,
			tediScopes: ["mcp:work.read", "mcp:work.write"],
		} satisfies Partial<BaseContext>;
		const edit = {
			ticketId: receipt.ticketId,
			expectedVersion: 1,
			idempotencyKey: "answer-1",
			answer: {
				body: "Follow the connection guide",
				evidence: ["https://docs.example.invalid/connect"],
				nextStep: "Try the first read",
			},
		};
		await expect(
			client({
				...asWorker,
				tediId: "44444444-4444-4444-8444-444444444444",
			}).draft(edit),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const drafted = await client(asWorker).draft(edit);
		expect(drafted.draft?.body).toBe(edit.answer.body);
		const card = sqlite
			.prepare("select target_id,creator_type,metadata from work_interactions")
			.get();
		expect(card).toMatchObject({ target_id: "admin", creator_type: "tedi" });
		expect(JSON.parse(String(card?.metadata)).decisionDeck).toMatchObject({
			kind: "outbound",
			preview: { body: edit.answer.body },
			options: [
				{
					effect: {
						kind: "publish_support",
						ticketId: receipt.ticketId,
						expectedVersion: 2,
					},
				},
				{},
			],
		});
		await client(asWorker).draft(edit);
		expect(
			sqlite.prepare("select count(*) as n from work_interactions").get()?.n,
		).toBe(1);
		const privateStatus = await client().status({ ticketId: receipt.ticketId });
		expect(privateStatus.publicUpdates).toEqual([]);
		expect(privateStatus.status).toBe("in-progress");
		expect(privateStatus).not.toHaveProperty("draft");
		await expect(
			client(asWorker).publish({
				ticketId: receipt.ticketId,
				expectedVersion: 2,
				idempotencyKey: "publish",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client({
				organizationId: platform,
				userId: "admin",
				user: { sub: "admin" },
				externalAgentPrincipalId: "local-agent",
			}).publish({
				ticketId: receipt.ticketId,
				expectedVersion: 2,
				idempotencyKey: "publish",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const published = await client({
			organizationId: platform,
			userId: "admin",
			user: { sub: "admin" },
		}).publish({
			ticketId: receipt.ticketId,
			expectedVersion: 2,
			idempotencyKey: "publish",
		});
		expect(published.status).toBe("answered");
		expect(published.reporterVerification).toBe("unconfirmed");
		expect(
			(await client().status({ ticketId: receipt.ticketId })).publicUpdates[0]
				?.body,
		).toBe(edit.answer.body);
		await expect(
			client(asWorker).draft({ ...edit, idempotencyKey: "stale" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const follow = await request();
		const retest = await client().file({
			...follow,
			ticketId: receipt.ticketId,
			expectedVersion: 3,
			idempotencyKey: "retest",
			retest: "unblocked",
		});
		expect(retest.status).toBe("resolved");
		expect(retest.reporterVerification).toBe("unblocked");
	});

	it("carries a rewritten reply card into the ticket draft so Publish sends what the card shows", async () => {
		const { client, sqlite, context } = await fixture(),
			receipt = await client().file(await request());
		const worker_ = {
			authType: "tedi",
			user: undefined,
			userId: undefined,
			serviceAccount: { clientId: "support-test" },
			organizationId: platform,
			tediId: worker,
			tediScopes: ["mcp:work.read", "mcp:work.write"],
		} satisfies Partial<BaseContext>;
		await client(worker_).draft({
			ticketId: receipt.ticketId,
			expectedVersion: 1,
			idempotencyKey: "answer-1",
			answer: {
				body: "Stale answer",
				evidence: ["https://docs.example.invalid/connect"],
				nextStep: "Try the first read",
			},
		});
		const row = sqlite
			.prepare("select id, org_id, metadata from work_interactions")
			.get()!;
		const card = {
			id: String(row.id),
			orgId: String(row.org_id),
			metadata: JSON.parse(String(row.metadata)),
		};
		const admin = {
			organizationId: platform,
			userId: "admin",
			user: { sub: "admin" },
		};
		await syncSupportDraftFromCard(context(worker_), card, "Short new answer", {
			key: "card-revision:1",
			actorType: "tedi",
			actorId: worker,
		});
		const synced = JSON.parse(
			String(
				sqlite
					.prepare("select metadata from work_interactions where id=?")
					.get(card.id)?.metadata,
			),
		).decisionDeck;
		expect(synced.preview.body).toBe("Short new answer");
		expect(synced.options[0].effect.expectedVersion).toBe(3);
		// A card made for an older ticket version leaves the newer ticket alone.
		await syncSupportDraftFromCard(context(worker_), card, "Other text", {
			key: "card-revision:2",
			actorType: "tedi",
			actorId: worker,
		});
		// A card whose text the ticket already holds catches up to that version.
		const lagging = {
			...card,
			metadata: JSON.parse(
				String(
					sqlite
						.prepare("select metadata from work_interactions where id=?")
						.get(card.id)?.metadata,
				),
			),
		};
		lagging.metadata.decisionDeck.options[0].effect.expectedVersion = 2;
		sqlite
			.prepare("update work_interactions set metadata=? where id=?")
			.run(JSON.stringify(lagging.metadata), card.id);
		await syncSupportDraftFromCard(
			context(worker_),
			lagging,
			"Short new answer",
			{
				key: "card-revision:3",
				actorType: "tedi",
				actorId: worker,
			},
		);
		expect(
			JSON.parse(
				String(
					sqlite
						.prepare("select metadata from work_interactions where id=?")
						.get(card.id)?.metadata,
				),
			).decisionDeck.options[0].effect.expectedVersion,
		).toBe(3);
		await client(admin).publish({
			ticketId: receipt.ticketId,
			expectedVersion: 3,
			idempotencyKey: "publish",
		});
		expect(
			(await client().status({ ticketId: receipt.ticketId })).publicUpdates[0]
				?.body,
		).toBe("Short new answer");
	});
});
