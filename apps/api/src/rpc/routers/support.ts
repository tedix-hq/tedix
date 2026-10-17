import { implement } from "@orpc/server";
import { ZodError } from "zod";
import { supportContract } from "@tedix/api-contract/contracts/support";
import {
	redactSupportReport,
	redactSupportText,
	supportObjectId,
	supportPayloadDigest,
} from "@tedix/api-contract/utils/support-report";
import * as tickets from "@tedix/db/queries/support";
import {
	createWorkItem,
	getWorkItemBySourceIntentId,
	getWorkItemById,
} from "@tedix/db/queries/work-items/crud";
import { addWorkItemCommentIfAbsent } from "@tedix/db/queries/work-items/comments";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { getProjectById } from "@tedix/db/queries/projects";
import {
	changeSupportTicket,
	deliverSupportTicket,
	repairSupportTicketPurpose,
	staffSupportTicket,
	supportConfig,
	supportReceipt,
	supportReporter,
	supportStaff,
} from "../../services/support";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";
import { requireOrgId } from "../org-scope";
import { auditActor, emitAuditEvent } from "../audit-helpers";

const authed = implement(supportContract)
	.$context<BaseContext>()
	.use(withAuth)
	.use(async ({ next }) => {
		try {
			return await next();
		} catch (error) {
			if (error instanceof tickets.SupportStateError)
				throw createError(ErrorCodes.CONFLICT, error.message);
			throw error;
		}
	});
const read = authed.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Support reports are requester-scoped; operations require the configured Support tedi or designated human admin",
		},
		"mcp:work.read",
	),
);
const write = authed.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Support reports are requester-scoped; operations require the configured Support tedi or designated human admin",
		},
		"mcp:work.write",
	),
);
const missing = () =>
	createError(ErrorCodes.NOT_FOUND, "Support ticket not found");
async function staffTicket(context: BaseContext, id: string) {
	const { config } = await supportStaff(context);
	const row = await tickets.getStaffSupportTicket(
		context.db,
		config.platformOrgId,
		id,
	);
	if (!row) throw missing();
	return row;
}
function expected(
	row: { version: number; updateKeys: string[] },
	version: number,
	key: string,
) {
	if (row.version !== version && !row.updateKeys.includes(key))
		throw createError(
			ErrorCodes.CONFLICT,
			"Ticket changed; read the current version",
		);
}
export const supportContractRouter = {
	review: write.review.handler(async ({ context, input }) => {
		const { config } = await supportStaff(context),
			now = new Date().toISOString();
		const day = new Intl.DateTimeFormat("en-CA", {
			timeZone: config.reviewTimezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(new Date());
		const sourceIntentId = "support-review",
			id = await supportObjectId(`${config.platformOrgId}:${sourceIntentId}`);
		const project = await tickets.ensureSupportProject(context.db, {
			id: await supportObjectId(`support-project:${config.platformOrgId}`),
			orgId: config.platformOrgId,
			key: config.projectKey,
			ownerTediId: config.supportTediId,
			now,
		});
		const configuredWork = config.reviewWorkItemId
			? await getWorkItemById(
					context.db,
					config.reviewWorkItemId,
					config.platformOrgId,
				)
			: null;
		if (config.reviewWorkItemId && !configuredWork)
			throw createError(
				ErrorCodes.CONFLICT,
				"The configured Support health Work item is unavailable",
			);
		const work =
			configuredWork ??
			(await getWorkItemBySourceIntentId(context.db, {
				orgId: config.platformOrgId,
				sourceIntentId,
			})) ??
			(await createWorkItem(context.db, {
				id,
				orgId: config.platformOrgId,
				title: "Support daily review",
				description: redactSupportText(input.summary),
				workKind: "operations",
				workClass: "maintenance",
				riskLevel: "low",
				projectId: project.id,
				accountableOwnerType: "tedi",
				accountableOwnerId: config.supportTediId,
				sourceIntentId,
				createdAt: now,
			}));
		await addWorkItemCommentIfAbsent(context.db, {
			id: await supportObjectId(`support-review-comment:${work.id}:${day}`),
			workItemId: work.id,
			orgId: config.platformOrgId,
			authorType: context.tediId ? "tedi" : "user",
			authorId: context.tediId ?? config.adminUserId,
			body: `${day}\n${redactSupportText(input.summary)}`,
			createdAt: now,
		});
		const interactionId = await supportObjectId(
			`support-digest:${work.id}:${day}`,
		);
		if (
			!(await getWorkInteraction(context.db, {
				orgId: config.platformOrgId,
				interactionId,
			}))
		)
			await createWorkInteraction(context.db, {
				id: interactionId,
				orgId: config.platformOrgId,
				workItemId: work.id,
				kind: "coordination",
				subject: work.title,
				prompt: redactSupportText(input.summary),
				creator: context.tediId
					? { type: "tedi", id: context.tediId }
					: { type: "user", id: config.adminUserId },
				targetType: "user",
				targetId: config.adminUserId,
				metadata: { reason: "Requested daily support digest" },
				now,
			});
		return { workItemId: work.id, interactionId };
	}),
	configure: authed.configure
		.use(AUTHZ.platformAdmin)
		.handler(async ({ context, input }) => {
			const worker = await getTediByIdForOrganization(
				context.db,
				input.supportTediId,
				input.platformOrgId,
			);
			if (!worker || worker.status !== "active")
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Support tedi must be active in the destination organization",
				);
			if (
				input.engineeringTediId &&
				!(await getTediByIdForOrganization(
					context.db,
					input.engineeringTediId,
					input.platformOrgId,
				))
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Engineering tedi must belong to the destination organization",
				);
			if (
				input.engineeringProjectId &&
				(await getProjectById(context.db, input.engineeringProjectId))
					?.orgId !== input.platformOrgId
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Engineering project must belong to the destination organization",
				);
			const prior = await tickets.getSupportConfiguration(context.db);
			if (
				prior &&
				(prior.platformOrgId !== input.platformOrgId ||
					prior.projectKey !== input.projectKey)
			)
				throw createError(
					ErrorCodes.CONFLICT,
					"Support destination cannot be rebound over existing tickets",
				);
			try {
				new Intl.DateTimeFormat("en", {
					timeZone: input.reviewTimezone,
				}).format();
			} catch (error) {
				if (!(error instanceof RangeError)) throw error;
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Support reviewTimezone must be a valid timezone",
				);
			}
			await tickets.putSupportConfiguration(
				context.db,
				input,
				new Date().toISOString(),
			);
			const actor = auditActor(context);
			await emitAuditEvent(context.db, {
				organizationId: input.platformOrgId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "support.configured",
				resourceType: "support",
				resourceId: input.supportTediId,
			});
			return input;
		}),
	file: write.file.handler(async ({ context, input }) => {
		const orgId = requireOrgId(context),
			reporterKey = supportReporter(context),
			config = await supportConfig(context);
		let report;
		try {
			report = redactSupportReport(input.report);
		} catch (error) {
			if (!(error instanceof ZodError)) throw error;
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Redacted support report is invalid: ${error.issues.map((issue) => issue.path.join(".")).join(", ")}. Preview and approve a valid redacted report.`,
			);
		}
		const digest = await supportPayloadDigest(report);
		if (digest !== input.consent.payloadDigest)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Preview the redacted payload and approve its exact digest before filing",
			);
		if (report.origin === "email")
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Email intake requires verified sender mapping; use the restricted email adapter",
			);
		const now = new Date().toISOString();
		if (input.ticketId) {
			const old = await tickets.getSupportTicket(
				context.db,
				orgId,
				input.ticketId,
				reporterKey,
			);
			if (!old) throw missing();
			if (!input.expectedVersion)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Follow-up requires expectedVersion",
				);
			expected(old, input.expectedVersion, input.idempotencyKey);
			if (old.updateKeys.includes(input.idempotencyKey))
				return supportReceipt(old);
			const actor = auditActor(context);
			const row = await changeSupportTicket(context, old, {
				key: input.idempotencyKey,
				actorId: actor.actorId,
				actorType: context.tediId
					? "tedi"
					: context.externalAgentPrincipalId
						? "external_agent"
						: "user",
				now,
				patch: {
					report,
					consentReference: input.consent.reference,
					payloadDigest: digest,
					reporterVerification: input.retest ?? old.reporterVerification,
					status: input.retest === "unblocked" ? "resolved" : "received",
					draft: null,
					nextUpdateDue: new Date(
						Date.now() + config.firstResponseMinutes * 60_000,
					).toISOString(),
				},
				commentBody: JSON.stringify({ report, retest: input.retest ?? null }),
				publicComment: true,
			});
			return supportReceipt(row);
		}
		if (input.retest || input.expectedVersion)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Retest/version requires an existing ticket",
			);
		const id = await supportObjectId(
			`support:${orgId}:${input.idempotencyKey}`,
		);
		let row = await tickets.getSupportTicket(context.db, orgId, id);
		if (
			row &&
			(row.reporterKey !== reporterKey || row.payloadDigest !== digest)
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"Idempotency key belongs to another report",
			);
		if (!row) {
			const project = await tickets.ensureSupportProject(context.db, {
				id: await supportObjectId(`support-project:${orgId}`),
				orgId,
				key: config.projectKey,
				now,
			});
			row = await tickets.createSupportTicket(context.db, {
				id,
				orgId,
				platformOrgId: config.platformOrgId,
				reporterKey,
				idempotencyKey: input.idempotencyKey,
				workItemId: await supportObjectId(`support-work:${id}`),
				mirrorWorkItemId: await supportObjectId(`support-mirror:${id}`),
				projectId: project.id,
				report,
				consentReference: input.consent.reference,
				payloadDigest: digest,
				nextUpdateDue: new Date(
					Date.now() + config.firstResponseMinutes * 60_000,
				).toISOString(),
				createdAt: now,
				updatedAt: now,
			});
		}
		if (!row || row.reporterKey !== reporterKey || row.payloadDigest !== digest)
			throw createError(ErrorCodes.CONFLICT, "Support intake conflict");
		await repairSupportTicketPurpose(context, row);
		if (row.mirrorDelivery === "pending") {
			try {
				await deliverSupportTicket(context, row);
				row = { ...row, mirrorDelivery: "delivered" };
			} catch (error) {
				console.error("support.mirror_pending", {
					ticketId: row.id,
					error: error instanceof Error ? error.name : "unknown",
				});
			}
		}
		return supportReceipt(row);
	}),
	status: read.status.handler(async ({ context, input }) => {
		const row = await tickets.getSupportTicket(
			context.db,
			requireOrgId(context),
			input.ticketId,
			supportReporter(context),
		);
		if (!row) throw missing();
		return supportReceipt(row, input.afterVersion);
	}),
	mine: read.mine.handler(async ({ context, input }) => {
		const config = await supportConfig(context);
		return {
			items: (
				await tickets.listSupportTickets(context.db, {
					orgId: requireOrgId(context),
					reporterKey: supportReporter(context),
					limit: input.limit,
				})
			).map((row) => supportReceipt(row)),
			canReview:
				requireOrgId(context) === config.platformOrgId &&
				context.authType === "user" &&
				!context.externalAgentPrincipalId &&
				!context.ownerHostSessionId &&
				(context.userId ?? context.gatewayEndUserId) === config.adminUserId,
		};
	}),
	queue: read.queue.handler(async ({ context, input }) => {
		const { config } = await supportStaff(context);
		return (
			await tickets.listSupportTickets(context.db, {
				orgId: config.platformOrgId,
				staff: true,
				limit: input.limit,
				includeClosed: input.includeClosed,
			})
		).map(staffSupportTicket);
	}),
	get: read.get.handler(async ({ context, input }) =>
		staffSupportTicket(await staffTicket(context, input.ticketId)),
	),
	draft: write.draft.handler(async ({ context, input }) => {
		const row = await staffTicket(context, input.ticketId);
		if (["resolved", "closed-without-confirmation"].includes(row.status))
			throw createError(
				ErrorCodes.CONFLICT,
				"The reporter must reopen a closed ticket before triage continues",
			);
		expected(row, input.expectedVersion, input.idempotencyKey);
		if (row.updateKeys.includes(input.idempotencyKey))
			return staffSupportTicket(row);
		if (row.mirrorDelivery !== "delivered")
			throw createError(ErrorCodes.CONFLICT, "Ticket mirror is pending");
		const answer = {
			body: redactSupportText(input.answer.body),
			evidence: input.answer.evidence.map(redactSupportText),
			nextStep: redactSupportText(input.answer.nextStep),
		};
		const { config } = await supportStaff(context);
		return staffSupportTicket(
			await changeSupportTicket(context, row, {
				key: input.idempotencyKey,
				actorId: context.tediId ?? config.adminUserId,
				actorType: context.tediId ? "tedi" : "user",
				now: new Date().toISOString(),
				patch: { draft: answer, status: "in-progress" },
				commentBody: `DRAFT — not sent\n${JSON.stringify(answer)}`,
			}),
		);
	}),
	publish: write.publish.handler(async ({ context, input }) => {
		const { config } = await supportStaff(context, true),
			row = await staffTicket(context, input.ticketId);
		expected(row, input.expectedVersion, input.idempotencyKey);
		if (row.updateKeys.includes(input.idempotencyKey))
			return supportReceipt(row);
		if (!row.draft)
			throw createError(ErrorCodes.BAD_REQUEST, "No reviewed draft exists");
		const now = new Date().toISOString();
		return supportReceipt(
			await changeSupportTicket(context, row, {
				key: input.idempotencyKey,
				actorId: config.adminUserId,
				actorType: "user",
				now,
				patch: {
					publicUpdates: [
						...row.publicUpdates,
						{ ...row.draft, version: row.version + 1, createdAt: now },
					],
					draft: null,
					status: "answered",
					nextUpdateDue: new Date(
						Date.now() + config.nextStepHours * 3_600_000,
					).toISOString(),
				},
				commentBody: JSON.stringify(row.draft),
				publicComment: true,
			}),
		);
	}),
	escalate: write.escalate.handler(async ({ context, input }) => {
		const { config } = await supportStaff(context),
			row = await staffTicket(context, input.ticketId);
		if (["resolved", "closed-without-confirmation"].includes(row.status))
			throw createError(
				ErrorCodes.CONFLICT,
				"The reporter must reopen a closed ticket before escalation",
			);
		expected(row, input.expectedVersion, input.idempotencyKey);
		if (row.updateKeys.includes(input.idempotencyKey))
			return staffSupportTicket(row);
		const now = new Date().toISOString(),
			reason = redactSupportText(input.reason);
		let escalationWorkItemId = row.escalationWorkItemId,
			interactionId = row.interactionId;
		if (input.target === "engineering") {
			if (!config.engineeringTediId || !config.engineeringProjectId)
				throw createError(
					ErrorCodes.CONFLICT,
					"Engineering escalation is not configured; escalate to the admin",
				);
			const intent = `support-diagnosis:${row.id}`;
			const prior = await getWorkItemBySourceIntentId(context.db, {
				orgId: config.platformOrgId,
				sourceIntentId: intent,
			});
			const work =
				prior ??
				(await createWorkItem(context.db, {
					id: await supportObjectId(intent),
					orgId: config.platformOrgId,
					title: `Diagnose: ${row.report.title}`,
					description: `Support ${row.id}: ${reason}. Read the consented ticket; return evidence and a proposed answer. No deployment authority.`,
					workKind: "coding",
					riskLevel: "medium",
					accountableOwnerType: "tedi",
					accountableOwnerId: config.engineeringTediId,
					projectId: config.engineeringProjectId,
					sourceIntentId: intent,
					createdAt: now,
				}));
			escalationWorkItemId = work.id;
		} else {
			const id = await supportObjectId(
				`support-question:${row.id}:${input.idempotencyKey}`,
			);
			const prior = await getWorkInteraction(context.db, {
				orgId: config.platformOrgId,
				interactionId: id,
			});
			if (!prior)
				await createWorkInteraction(context.db, {
					id,
					orgId: config.platformOrgId,
					workItemId: row.mirrorWorkItemId,
					kind: "question",
					subject: row.report.title,
					prompt: reason,
					creator: context.tediId
						? { type: "tedi", id: context.tediId }
						: { type: "user", id: config.adminUserId },
					targetType: "user",
					targetId: config.adminUserId,
					dueAt: row.nextUpdateDue,
					metadata: { reason, supportId: row.id },
					now,
				});
			interactionId = id;
		}
		return staffSupportTicket(
			await changeSupportTicket(context, row, {
				key: input.idempotencyKey,
				actorId: context.tediId ?? config.adminUserId,
				actorType: context.tediId ? "tedi" : "user",
				now,
				patch: { escalationWorkItemId, interactionId, status: "in-progress" },
				commentBody: `Escalated to ${input.target}: ${reason}`,
			}),
		);
	}),
};
