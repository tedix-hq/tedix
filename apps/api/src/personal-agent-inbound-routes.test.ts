import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { PersonalAgentReceiptSchema } from "@tedix/api-contract/schemas/personal-agent-inbound";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizationSecrets } from "@tedix/db/schema/organization-secrets";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { workEvents } from "@tedix/db/schema/work-items";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { listWorkActivity } from "@tedix/db/queries/work-items/activity";
import {
	capturePersonalAgentFinding,
	PERSONAL_AGENT_NAMESPACE,
	personalAgentConfigKey,
} from "@tedix/db/queries/personal-agent-inbound";
import { getUserConfig } from "@tedix/db/queries/user-configs";
import { PersonalAgentEnrollmentSchema } from "@tedix/api-contract/schemas/personal-agent-inbound";
import { describe, expect, it } from "vite-plus/test";
import { personalAgentInboundRoutes } from "./personal-agent-inbound-routes";
import { personalAgentInboundContractRouter } from "./rpc/routers/personal-agent-inbound";
import type { BaseContext } from "./rpc/orpc";

const org = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const foreignOrg = "33333333-3333-4333-8333-333333333333";
const user = "fictional-luz";
const finding = {
	externalFindingId: "cedar-001",
	title: "A useful library update",
	body: "Cedar found a release worth reviewing.",
	evidenceUrl: "https://cedar.example/findings/1",
	kind: "fyi" as const,
};

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() +
			schemaDdl(organizationSecrets, userConfigs, workEvents, workInteractions),
	);
	sqlite
		.prepare(
			"INSERT INTO projects(id,org_id,key,name,objective_id,created_at) VALUES(?,?,?,'Fictional research','fictional-objective',?)",
		)
		.run(project, org, "RESEARCH", new Date().toISOString());
	const env = {
		DB: createD1Facade(sqlite),
		SECRETS_MASTER_KEY: btoa("a".repeat(32)),
	} as unknown as CloudflareEnv;
	const db = createDbClient(env.DB);
	function client(
		userId = user,
		organizationId = org,
		authType = "user",
		permissions = ["os:author"],
	) {
		return createRouterClient(personalAgentInboundContractRouter, {
			context: {
				authType,
				userId,
				organizationId,
				db,
				env,
				headers: new Headers(),
				user: {
					sub: `descope-${userId}`,
					permissions,
					roles: [],
					dct: organizationId,
				},
			} as BaseContext,
		});
	}
	async function enroll() {
		return client().enroll({
			sourceAgentName: "Cedar Scout",
			projectId: project,
		});
	}
	function send(
		e: Awaited<ReturnType<typeof enroll>>,
		data = finding,
		form = false,
		override: { orgId?: string; userId?: string; token?: string } = {},
	) {
		const url = `https://intake.example/${override.orgId ?? org}/${override.userId ?? user}/${e.enrollment.id}`;
		return personalAgentInboundRoutes.request(
			url,
			{
				method: "POST",
				headers: form
					? { "Content-Type": "application/x-www-form-urlencoded" }
					: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${override.token ?? e.token}`,
						},
				body: form
					? new URLSearchParams({ ...data, token: override.token ?? e.token })
					: JSON.stringify(data),
			},
			env,
		);
	}
	return { sqlite, env, db, client, enroll, send };
}

describe("personal-agent intake", () => {
	it("enrolls once, captures 10 fictional form/webhook findings once, projects only to the owner, and returns receipts", async () => {
		const h = setup();
		try {
			const e = await h.enroll();
			const page = await personalAgentInboundRoutes.request(
				`https://intake.example/${org}/${user}/${e.enrollment.id}`,
				{},
				h.env,
			);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain('name="externalFindingId"');
			expect(page.headers.get("Content-Security-Policy")).toContain(
				"form-action 'self'",
			);
			const latency: number[] = [];
			for (let n = 0; n < 10; n++) {
				const data = {
					...finding,
					title: `Cedar finding ${n}`,
					externalFindingId: `cedar-${n}`,
				};
				const start = performance.now();
				const response = await h.send(e, data, n % 2 === 0);
				latency.push(performance.now() - start);
				expect(response.status).toBe(n % 2 === 0 ? 200 : 201);
				const retry = await h.send(e, data);
				expect(retry.status).toBe(200);
				expect(
					PersonalAgentReceiptSchema.parse(await retry.json()),
				).toMatchObject({
					externalFindingId: data.externalFindingId,
					duplicate: true,
					disposition: "proposed",
				});
			}
			const p95Ms = latency.sort((a, b) => a - b)[9]!;
			expect(p95Ms).toBeLessThan(60000);
			console.info({
				controlledFindings: 10,
				p95ReceiptMs: Math.round(p95Ms * 100) / 100,
				environment: "local D1 facade",
			});
			const feed = await listWorkActivity(h.db, {
				orgId: org,
				viewerUserId: user,
			});
			expect(feed.events).toHaveLength(10);
			expect(feed.events[0]).toMatchObject({
				authorType: "system",
				personalAgentContribution: {
					sourceAgentId: e.enrollment.id,
					sourceAgentName: "Cedar Scout",
					representedUserId: user,
				},
			});
			expect(
				(
					await listWorkActivity(h.db, {
						orgId: org,
						viewerUserId: "fictional-river",
					})
				).events,
			).toEqual([]);
			expect(
				(
					await listWorkActivity(h.db, {
						orgId: foreignOrg,
						viewerUserId: user,
					})
				).events,
			).toEqual([]);
			expect(
				h.sqlite
					.prepare(
						"SELECT count(*) AS n FROM work_items WHERE disposition='proposed'",
					)
					.get(),
			).toEqual({ n: 10 });
			expect(
				h.sqlite.prepare("SELECT count(*) AS n FROM work_attempts").get(),
			).toEqual({ n: 0 });
			expect(JSON.stringify(await h.client().list({}))).not.toContain(e.token);
			expect(
				h.sqlite
					.prepare("SELECT encrypted_value FROM organization_secrets")
					.get()?.encrypted_value,
			).not.toContain(e.token);
		} finally {
			h.sqlite.close();
		}
	});

	it("rejects wrong tokens, tenants, recipients, revocation and machine enrollment", async () => {
		const h = setup();
		try {
			const e = await h.enroll();
			for (const override of [
				{ token: "x".repeat(64) },
				{ orgId: foreignOrg },
				{ userId: "fictional-river" },
			])
				expect((await h.send(e, finding, false, override)).status).toBe(401);
			await expect(
				h.client("fictional-river").revoke({ id: e.enrollment.id }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				h
					.client(user, foreignOrg)
					.enroll({ sourceAgentName: "Cedar", projectId: project }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			await expect(
				h
					.client(user, org, "tedi")
					.enroll({ sourceAgentName: "Cedar", projectId: project }),
			).rejects.toBeDefined();
			await expect(
				h
					.client(user, org, "user", [])
					.enroll({ sourceAgentName: "Cedar", projectId: project }),
			).rejects.toBeDefined();
			await h.client().revoke({ id: e.enrollment.id });
			expect((await h.send(e)).status).toBe(401);
			expect(
				h.sqlite.prepare("SELECT count(*) AS n FROM work_items").get(),
			).toEqual({ n: 0 });
		} finally {
			h.sqlite.close();
		}
	});

	it("fences a revocation after credential verification and concurrent duplicate delivery", async () => {
		const h = setup();
		try {
			const e = await h.enroll();
			const responses = await Promise.all([h.send(e), h.send(e)]);
			expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
			const receipts = await Promise.all(responses.map((r) => r.json()));
			expect(receipts[0].workItemId).toBe(receipts[1].workItemId);
			const row = await getUserConfig(h.db, {
				userId: user,
				namespace: PERSONAL_AGENT_NAMESPACE,
				key: personalAgentConfigKey(org, e.enrollment.id),
			});
			await h.client().revoke({ id: e.enrollment.id });
			expect(
				await capturePersonalAgentFinding(h.db, {
					enrollment: PersonalAgentEnrollmentSchema.parse(row!.value),
					revision: row!.revision,
					finding,
					sourceIntentId: "new-after-revoke",
					contribution: {
						sourceAgentId: e.enrollment.id,
						sourceAgentName: "Cedar Scout",
						representedUserId: user,
						sourceChannel: "webhook",
						capturedAt: new Date().toISOString(),
						evidenceUrl: finding.evidenceUrl,
						externalFindingId: finding.externalFindingId,
						kind: "fyi",
					},
				}),
			).toBeNull();
			expect(
				h.sqlite.prepare("SELECT count(*) AS n FROM work_events").get(),
			).toEqual({ n: 1 });
		} finally {
			h.sqlite.close();
		}
	});

	it("bounds untrusted submissions and rejects identity or action fields without writing", async () => {
		const h = setup();
		try {
			const e = await h.enroll();
			const url = `https://intake.example/${org}/${user}/${e.enrollment.id}`;
			for (const extra of [
				{ representedUserId: "fictional-river" },
				{ sourceAgentName: "Forged agent" },
				{ action: "send_email" },
			]) {
				const response = await personalAgentInboundRoutes.request(
					url,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${e.token}`,
						},
						body: JSON.stringify({ ...finding, ...extra }),
					},
					h.env,
				);
				expect(response.status).toBe(400);
			}
			const oversized = await personalAgentInboundRoutes.request(
				url,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${e.token}`,
					},
					body: JSON.stringify({ ...finding, body: "x".repeat(17000) }),
				},
				h.env,
			);
			expect(oversized.status).toBe(413);
			const insecure = await personalAgentInboundRoutes.request(
				url.replace("https:", "http:"),
				{},
				h.env,
			);
			expect(insecure.status).toBe(400);
			expect(
				h.sqlite.prepare("SELECT count(*) AS n FROM work_items").get(),
			).toEqual({ n: 0 });
		} finally {
			h.sqlite.close();
		}
	});
});
