import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { organizationSecrets } from "@tedix/db/schema/organization-secrets";
import { userConfigs } from "@tedix/db/schema/user-configs";
import {
	workEvents,
	workEvidence,
	workEvidenceVerifications,
	workItemCorroborations,
} from "@tedix/db/schema/work-items";
import {
	workInteractions,
	workInteractionResponses,
} from "@tedix/db/schema/work-factory";
import { tediEmailAddresses } from "@tedix/db/schema/tedi-email";
import {
	listPersonalAgentOutcomes,
	getPersonalAgentValue,
	claimPersonalAgentEmail,
	recordPersonalAgentOutcome,
} from "@tedix/db/queries/personal-agent-outbound";
import { PersonalAgentOutcomeSchema } from "@tedix/api-contract/schemas/personal-agent-inbound";
import { addWorkItemCorroboration } from "@tedix/db/queries/work-items/comments";
import { personalAgentInboundContractRouter } from "../rpc/routers/personal-agent-inbound";
import { personalAgentInboundRoutes } from "../personal-agent-inbound-routes";
import type { BaseContext } from "../rpc/orpc";
import { receivePersonalAgentFinding } from "./personal-agent-inbound";
import { reconcilePersonalAgentOutcomes } from "./personal-agent-outbound";

const org = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const agentMember = "33333333-3333-4333-8333-333333333333";
const senderAddress = "44444444-4444-4444-8444-444444444444";
const user = "fictional-luz";

async function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() +
			schemaDdl(
				organizationMembers,
				organizationSecrets,
				userConfigs,
				workEvents,
				workInteractions,
				workInteractionResponses,
				workEvidence,
				workEvidenceVerifications,
				workItemCorroborations,
				tediEmailAddresses,
			),
	);
	// schemaDdl omits column-level .unique(); mirror the real event id fence.
	sqlite.exec("CREATE UNIQUE INDEX test_work_events_id ON work_events(id)");
	sqlite
		.prepare(
			"INSERT INTO projects(id,org_id,key,name,objective_id,created_at) VALUES(?,?,?,'Fictional research','fictional-objective',?)",
		)
		.run(project, org, "RESEARCH", new Date().toISOString());
	const send = vi.fn().mockResolvedValue({ messageId: "fictional-message" });
	const env = {
		DB: createD1Facade(sqlite),
		SECRETS_MASTER_KEY: btoa("a".repeat(32)),
		EMAIL: { send },
	} as unknown as CloudflareEnv;
	const db = createDbClient(env.DB);
	await db.insert(organizationMembers).values([
		{
			id: crypto.randomUUID(),
			organizationId: org,
			userId: user,
			descopeUserId: user,
			email: "luz@example.test",
			role: "owner",
			status: "active",
		},
		{
			id: agentMember,
			organizationId: org,
			userId: "fictional-cedar",
			descopeUserId: "cedar",
			email: "cedar@example.test",
			kind: "external_agent",
			representedUserId: user,
			role: "member",
			status: "active",
		},
	]);
	await db.insert(tediEmailAddresses).values({
		id: senderAddress,
		organizationId: org,
		tediId: "fictional-tedi",
		address: "scout@example.test",
		localPart: "scout",
		domain: "example.test",
		kind: "primary",
		status: "active",
		createdBy: "system",
	});
	const client = createRouterClient(personalAgentInboundContractRouter, {
		context: {
			authType: "user",
			userId: user,
			organizationId: org,
			db,
			env,
			headers: new Headers(),
			user: { sub: user, permissions: ["os:author"], roles: [], dct: org },
		} as BaseContext,
	});
	const e = await client.enroll({
		sourceAgentName: "Cedar Scout",
		projectId: project,
	});
	const url = `https://intake.example/${org}/${user}/${e.enrollment.id}/outcomes`;
	const headers = {
		Authorization: `Bearer ${e.token}`,
		"Content-Type": "application/json",
	};
	async function finding(n: number, kind: "proposal" | "fyi" = "proposal") {
		return receivePersonalAgentFinding(db, env.SECRETS_MASTER_KEY, {
			orgId: org,
			userId: user,
			enrollmentId: e.enrollment.id,
			token: e.token,
			channel: "webhook",
			finding: {
				externalFindingId: `cedar-${n}`,
				title: `Finding ${n}`,
				body: "Review this fictional finding.",
				evidenceUrl: "https://cedar.example/findings",
				kind,
			},
		});
	}
	async function decide(
		workItemId: string,
		metadata: Record<string, string> = {
			cardAction: "explore",
			decisionChoice: "approve",
		},
		responderId = user,
	) {
		const id = crypto.randomUUID();
		await db.insert(workInteractionResponses).values({
			id,
			orgId: org,
			interactionId: workItemId,
			resolvedRequestVersion: 2,
			resolutionFence: crypto.randomUUID(),
			responderType: "user",
			responderId,
			body: "Explore",
			responseKind: "answer",
			resolvesRequest: true,
			metadata,
			respondedAt: new Date().toISOString(),
		});
		return id;
	}
	return { sqlite, db, env, send, client, e, url, headers, finding, decide };
}

describe("personal-agent outbound", () => {
	it("does not treat automated acknowledgments in the person's name as their decision", async () => {
		const h = await setup();
		try {
			for (const [n, metadata] of [
				[
					1,
					{
						source: "triage-fyi",
						cardAction: "explore",
						decisionChoice: "approve",
					},
				],
				[
					2,
					{
						draftOutcome: "auto",
						cardAction: "explore",
						decisionChoice: "approve",
					},
				],
			] as const) {
				const receipt = await h.finding(n);
				await h.decide(receipt.workItemId, metadata);
			}
			await reconcilePersonalAgentOutcomes(h.db, h.env);
			expect(
				await listPersonalAgentOutcomes(h.db, {
					orgId: org,
					userId: user,
					enrollmentId: h.e.enrollment.id,
				}),
			).toEqual([]);
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect((await h.client.value({}))[0]).toMatchObject({
				findings: 2,
				decisionCards: 2,
				decidedFromCard: 0,
				outcomes: 0,
			});
			expect(h.send).not.toHaveBeenCalled();
		} finally {
			h.sqlite.close();
		}
	});
	it("returns current Work confirmations as corroborated and propagates changed stances without inventing system verification", async () => {
		const h = await setup();
		try {
			const receipt = await h.finding(1);
			await h.decide(receipt.workItemId);
			const observation = {
				id: crypto.randomUUID(),
				orgId: org,
				workItemId: receipt.workItemId,
				principalType: "tedi" as const,
				principalId: "fictional-observer",
				evidenceRef: "https://cedar.example/result",
				body: "Observed the cited result.",
				occurredAt: new Date().toISOString(),
			};
			await addWorkItemCorroboration(h.db, observation);
			await reconcilePersonalAgentOutcomes(h.db, {});
			let rows = await listPersonalAgentOutcomes(h.db, {
				orgId: org,
				userId: user,
				enrollmentId: h.e.enrollment.id,
			});
			expect(rows[0]!.payload.execution).toMatchObject({
				state: "corroborated",
				observationSource: "work_confirmation",
				observerId: "fictional-observer",
				evidenceUri: observation.evidenceRef,
			});
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect((await h.client.value({}))[0]).toMatchObject({
				corroboratedOutcomes: 1,
				verifiedOutcomes: 0,
			});
			await addWorkItemCorroboration(h.db, {
				...observation,
				stance: "contradicts",
				body: "Result no longer matches.",
				occurredAt: new Date(Date.now() + 1).toISOString(),
			});
			await reconcilePersonalAgentOutcomes(h.db, {});
			rows = await listPersonalAgentOutcomes(h.db, {
				orgId: org,
				userId: user,
				enrollmentId: h.e.enrollment.id,
			});
			expect(rows).toHaveLength(2);
			expect(rows[1]!.payload).toMatchObject({
				supersedes: rows[0]!.id,
				execution: { state: "contradicted" },
			});
		} finally {
			h.sqlite.close();
		}
	});
	it("fences concurrent reconciliation and revocation after source reads", async () => {
		const h = await setup();
		try {
			const enrollment = await h.client.configureDelivery({
				id: h.e.enrollment.id,
				email: { memberId: agentMember, senderAddressId: senderAddress },
			});
			const receipt = await h.finding(1);
			await h.decide(receipt.workItemId);
			await Promise.all([
				reconcilePersonalAgentOutcomes(h.db, h.env),
				reconcilePersonalAgentOutcomes(h.db, h.env),
			]);
			expect(h.send).toHaveBeenCalledTimes(1);
			const [row] = await listPersonalAgentOutcomes(h.db, {
				orgId: org,
				userId: user,
				enrollmentId: h.e.enrollment.id,
			});
			const outcome = PersonalAgentOutcomeSchema.parse(row!.payload);
			await h.client.revoke({ id: h.e.enrollment.id });
			const late = { ...outcome, id: `${outcome.id}:late` };
			await recordPersonalAgentOutcome(h.db, org, late);
			expect(await claimPersonalAgentEmail(h.db, enrollment, late)).toBe(false);
			expect(
				h.sqlite.prepare("SELECT count(*) AS n FROM work_item_comments").get(),
			).toEqual({ n: 1 });
		} finally {
			h.sqlite.close();
		}
	});
	it("correlates ten fictional findings, decisions, verification, one email/comment and token acknowledgments; excludes retries", async () => {
		const h = await setup();
		try {
			await h.client.configureDelivery({
				id: h.e.enrollment.id,
				email: { memberId: agentMember, senderAddressId: senderAddress },
			});
			for (let n = 0; n < 10; n++) {
				const receipt = await h.finding(n);
				expect((await h.finding(n)).duplicate).toBe(true);
				await h.decide(receipt.workItemId);
				await h.db.insert(workEvidence).values({
					id: `e-${n}`,
					orgId: org,
					workItemId: receipt.workItemId,
					claimKey: "result",
					kind: "artifact",
					uri: `https://cedar.example/evidence/${n}`,
					submittedByType: "system",
					submittedById: "fictional-runner",
					submittedAt: new Date().toISOString(),
				});
				await h.db.insert(workEvidenceVerifications).values({
					id: `v-${n}`,
					orgId: org,
					workItemId: receipt.workItemId,
					evidenceId: `e-${n}`,
					source: "fictional_readback",
					verifierType: "system",
					verifierId: "fictional-observer",
					matchesClaim: true,
					observedAt: new Date().toISOString(),
				});
			}
			await reconcilePersonalAgentOutcomes(h.db, h.env);
			await reconcilePersonalAgentOutcomes(h.db, h.env);
			expect(h.send).toHaveBeenCalledTimes(10);
			for (const [mail] of h.send.mock.calls) {
				expect(mail.to).toEqual(["cedar@example.test"]);
				expect(mail.cc).toBeUndefined();
				expect(JSON.parse(mail.text)).toMatchObject({
					decidedBy: user,
					execution: { state: "verified" },
				});
			}
			const response = await personalAgentInboundRoutes.request(
				h.url,
				{ headers: h.headers },
				h.env,
			);
			expect(response.status).toBe(200);
			const page = await response.json();
			expect(page.outcomes).toHaveLength(10);
			for (const { outcome } of page.outcomes) {
				for (let retry = 0; retry < 2; retry++) {
					const ack = await personalAgentInboundRoutes.request(
						`${h.url}/ack`,
						{
							method: "POST",
							headers: h.headers,
							body: JSON.stringify({
								outcomeId: outcome.id,
								reminderId: `reminder:${outcome.externalFindingId}`,
							}),
						},
						h.env,
					);
					expect(ack.status).toBe(200);
				}
			}
			// Move past the last event's millisecond before reading a half-open window.
			await new Promise((resolve) => setTimeout(resolve, 1));
			const summary = (await h.client.value({}))[0];
			expect(summary).toMatchObject({
				findings: 10,
				decisionFindings: 10,
				decisionCards: 10,
				fyiFindings: 0,
				decidedFromCard: 10,
				decidedFromCardPercent: 100,
				outcomes: 10,
				verifiedOutcomes: 10,
				emailsSent: 10,
				acknowledgedOutcomes: 10,
				agentReportedReminderRetirements: 10,
				remindersAvoided: null,
				historicalChatBaseline: null,
			});
			expect(
				h.sqlite.prepare("SELECT count(*) AS n FROM work_item_comments").get(),
			).toEqual({ n: 10 });
			expect(
				(
					await personalAgentInboundRoutes.request(
						`${h.url}?after=${page.nextCursor}`,
						{ headers: h.headers },
						h.env,
					)
				).status,
			).toBe(200);
		} finally {
			h.sqlite.close();
		}
	});

	it("keeps unverified decisions separate, returns superseding evidence contradictions, and never relays another actor's decision", async () => {
		const h = await setup();
		try {
			const r = await h.finding(1);
			await h.decide(r.workItemId);
			const foreign = await h.finding(2);
			await h.decide(foreign.workItemId, undefined, "fictional-other");
			await h.finding(3, "fyi");
			await reconcilePersonalAgentOutcomes(h.db, {});
			const first = await listPersonalAgentOutcomes(h.db, {
				orgId: org,
				userId: user,
				enrollmentId: h.e.enrollment.id,
			});
			expect(first).toHaveLength(1);
			expect(first[0]!.payload.execution).toMatchObject({
				state: "unverified",
			});
			await h.db.insert(workEvidence).values({
				id: "e",
				orgId: org,
				workItemId: r.workItemId,
				claimKey: "result",
				kind: "artifact",
				uri: "https://cedar.example/evidence",
				submittedByType: "system",
				submittedById: "runner",
				submittedAt: new Date().toISOString(),
			});
			await h.db.insert(workEvidenceVerifications).values({
				id: "v",
				orgId: org,
				workItemId: r.workItemId,
				evidenceId: "e",
				source: "readback",
				verifierType: "system",
				verifierId: "observer",
				matchesClaim: false,
				observedAt: new Date().toISOString(),
			});
			await reconcilePersonalAgentOutcomes(h.db, {});
			const revised = await listPersonalAgentOutcomes(h.db, {
				orgId: org,
				userId: user,
				enrollmentId: h.e.enrollment.id,
			});
			expect(revised).toHaveLength(2);
			expect(revised[1]!.payload).toMatchObject({
				supersedes: first[0]!.id,
				execution: { state: "contradicted" },
			});
			const missingCard = await h.finding(4);
			h.sqlite
				.prepare("DELETE FROM work_interactions WHERE id=?")
				.run(missingCard.workItemId);
			await new Promise((resolve) => setTimeout(resolve, 1));
			const counts = (await h.client.value({}))[0];
			expect(counts).toMatchObject({
				findings: 4,
				decisionFindings: 3,
				decisionCards: 2,
				fyiFindings: 1,
				decidedFromCard: 1,
				decidedFromCardPercent: 50,
				emailsSent: 0,
			});
			expect(h.send).not.toHaveBeenCalled();
		} finally {
			h.sqlite.close();
		}
	});

	it("denies cross-enrollment/tenant polling, acknowledgment and revocation, and refuses arbitrary email destinations", async () => {
		const h = await setup();
		try {
			const r = await h.finding(1);
			await h.decide(r.workItemId);
			await reconcilePersonalAgentOutcomes(h.db, {});
			for (const url of [
				h.url.replace(org, crypto.randomUUID()),
				h.url.replace(user, "fictional-other"),
				h.url.replace(h.e.enrollment.id, crypto.randomUUID()),
			])
				expect(
					(
						await personalAgentInboundRoutes.request(
							url,
							{ headers: h.headers },
							h.env,
						)
					).status,
				).toBe(401);
			await expect(
				h.client.configureDelivery({
					id: h.e.enrollment.id,
					email: {
						memberId: crypto.randomUUID(),
						senderAddressId: senderAddress,
					},
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			const missing = await personalAgentInboundRoutes.request(
				`${h.url}/ack`,
				{
					method: "POST",
					headers: h.headers,
					body: JSON.stringify({ outcomeId: "foreign" }),
				},
				h.env,
			);
			expect(missing.status).toBe(404);
			await h.client.revoke({ id: h.e.enrollment.id });
			expect(
				(
					await personalAgentInboundRoutes.request(
						h.url,
						{ headers: h.headers },
						h.env,
					)
				).status,
			).toBe(401);
			expect(
				await getPersonalAgentValue(
					h.db,
					{ ...h.e.enrollment, orgId: crypto.randomUUID() },
					"2000-01-01T00:00:00.000Z",
					"2100-01-01T00:00:00.000Z",
				),
			).toMatchObject({ findings: 0 });
		} finally {
			h.sqlite.close();
		}
	});

	it("does not retry an ambiguous email error, and leaves the durable comment and poll record available", async () => {
		const h = await setup();
		try {
			await h.client.configureDelivery({
				id: h.e.enrollment.id,
				email: { memberId: agentMember, senderAddressId: senderAddress },
			});
			h.send.mockRejectedValue(
				new Error("fictional network failure after acceptance"),
			);
			const r = await h.finding(1);
			await h.decide(r.workItemId);
			await reconcilePersonalAgentOutcomes(h.db, h.env);
			await reconcilePersonalAgentOutcomes(h.db, h.env);
			expect(h.send).toHaveBeenCalledTimes(1);
			expect(
				h.sqlite
					.prepare(
						"SELECT json_extract(payload,'$.status') AS status FROM work_events WHERE event_type='personal_agent.outcome_email'",
					)
					.get(),
			).toEqual({ status: "sending_or_unknown" });
			expect((await h.client.value({}))[0]).toMatchObject({
				outcomes: 1,
				emailsSent: 0,
				acknowledgedOutcomes: 0,
				remindersAvoided: null,
			});
		} finally {
			h.sqlite.close();
		}
	});
});
