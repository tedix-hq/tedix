import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { supportConfiguration, supportTickets } from "@tedix/db/schema/support";
import { projects } from "@tedix/db/schema/projects";
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
import type { BaseContext } from "../orpc";
const tenant = "11111111-1111-4111-8111-111111111111",
	platform = "22222222-2222-4222-8222-222222222222",
	worker = "33333333-3333-4333-8333-333333333333";
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			supportConfiguration,
			supportTickets,
			projects,
			workItems,
			workEvents,
			workItemComments,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
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
	return { sqlite, client };
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
		const { client } = await fixture(),
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
});
