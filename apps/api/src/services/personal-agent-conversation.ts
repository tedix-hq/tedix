import type * as z from "zod";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { DbClient } from "@tedix/db/client";
import { PersonalAgentDiscoveryConfigSchema } from "@tedix/api-contract/schemas/organization";
import {
	PersonalAgentConversationResultSchema,
	PoppyRuntimeRequestSchema,
	type PersonalAgentConversationRequestSchema,
} from "@tedix/api-contract/schemas/personal-agent-conversation";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { buildRuntimeUrl } from "@tedix/db/utils/tedi-routing";
import {
	createWorkInteraction,
	getWorkInteraction,
	listWorkInteractionResponses,
	cancelWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import { verifySignedOutPersonalAgentSession } from "./personal-agent-session";

function visitorTranscript(body: JsonValue) {
	if (!isRecord(body) || !Array.isArray(body.events)) return "";
	return body.events
		.flatMap((event) => {
			if (
				!isRecord(event) ||
				event.type !== "message" ||
				!isRecord(event.message)
			)
				return [];
			const message = event.message;
			return [
				`${message.role === "company" ? "Company" : "Visitor"}: ${typeof message.text === "string" ? message.text : ""}${message.data ? `\n${JSON.stringify(message.data)}` : ""}`,
			];
		})
		.join("\n\n");
}

export async function personalAgentConversation(
	db: DbClient,
	env: CloudflareEnv,
	input: z.infer<typeof PersonalAgentConversationRequestSchema>,
) {
	const error = (httpStatus: number, code: string) => ({
		httpStatus,
		body: { error: code },
	});
	const org = await getOrganizationById(db, input.organizationId);
	const config = PersonalAgentDiscoveryConfigSchema.safeParse(
		org?.metadata?.personalAgentProtocol,
	);
	if (!config.success || !config.data.companyAgent)
		return error(404, "not_configured");
	const company = config.data.companyAgent;
	const url = new URL(input.url);
	const base = `${config.data.mcpUrl.replace(/\/$/, "")}/poppy/conversations`;
	const endpoint = new URL(base);
	if (
		url.origin !== endpoint.origin ||
		!(
			url.pathname === endpoint.pathname ||
			url.pathname.startsWith(`${endpoint.pathname}/`)
		)
	)
		return error(404, "not_configured");
	const path = url.pathname.slice(endpoint.pathname.length).replace(/^\//, "");
	const valid =
		input.method === "GET"
			? /^[A-Za-z0-9_-]{1,256}\/events$/.test(path)
			: input.method === "POST" &&
				(path === "" ||
					/^[A-Za-z0-9_-]{1,256}\/(messages|handoff|handoff\/cancel|close)$/.test(
						path,
					));
	if (!valid) return error(400, "invalid_request");
	const wait = url.searchParams.get("wait");
	if (wait !== null && !/^\d+$/.test(wait))
		return error(400, "invalid_request");
	const cursor = url.searchParams.get("cursor");
	if (cursor !== null && !/^[A-Za-z0-9_-]{1,256}$/.test(cursor))
		return error(400, "invalid_cursor");
	const session = await verifySignedOutPersonalAgentSession(db, input);
	if (session.status !== "accepted")
		return error(
			session.status === "not_configured"
				? 404
				: session.status === "rate_limited"
					? 429
					: 400,
			session.status,
		);
	const tedi = await getTediByIdForOrganization(
		db,
		company.tediId,
		input.organizationId,
	);
	const runtime = tedi && buildRuntimeUrl(tedi);
	if (!runtime || !env.TEDI_SERVICE) return error(503, "unavailable");
	const payload = PoppyRuntimeRequestSchema.parse({
		organizationId: input.organizationId,
		identity: session.identity,
		publicInstructions: company.publicInstructions,
		method: input.method,
		path,
		cursor,
		wait: Math.min(Number(wait ?? 0), 30),
		includeEvents: input.method === "GET" || wait !== null,
		...(input.body !== undefined ? { body: input.body } : {}),
	});
	const call = async (p: typeof payload) => {
		const response = await env.TEDI_SERVICE.fetch(`${runtime}/hooks/poppy`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Service-Binding": "true",
				"X-Tedix-Host": new URL(runtime).hostname,
			},
			body: JSON.stringify(p),
		});
		if (!response.ok) throw new Error("Company Agent runtime unavailable");
		const result = (await response.json()) as {
			receipt: unknown;
			desks: Array<{
				conversationId: string;
				interactionId: string;
				pending: boolean;
				transcript: JsonValue;
			}>;
		};
		return {
			receipt: PersonalAgentConversationResultSchema.parse(result.receipt),
			desks: result.desks,
		};
	};
	try {
		let result = await call(payload);
		const conversationId = (result.receipt.body as { conversation_id: string })
			.conversation_id;
		if (result.receipt.httpStatus >= 400) return result.receipt;
		for (const desk of result.desks) {
			const current = await getWorkInteraction(db, {
				orgId: input.organizationId,
				interactionId: desk.interactionId,
			});
			if (!desk.pending) {
				if (current?.status === "open")
					await cancelWorkInteraction(db, {
						orgId: input.organizationId,
						interactionId: current.id,
						expectedVersion: current.version,
						actor: { type: "system", id: "tedix" },
						now: new Date().toISOString(),
					});
				continue;
			}
			if (!company.handoff) {
				result = await call({
					...payload,
					method: "GET",
					path: `${desk.conversationId}/events`,
					wait: 0,
					includeEvents: true,
					deskReply: {
						conversationId: desk.conversationId,
						interactionId: desk.interactionId,
						text: null,
					},
				});
				continue;
			}
			if (!current) {
				try {
					await createWorkInteraction(db, {
						id: desk.interactionId,
						orgId: input.organizationId,
						projectId: company.handoff.projectId,
						kind: "question",
						subject: "Reply to a visitor",
						prompt: `A visitor asked to speak with a person. Your reply will be shared with their personal agent. Share only public information.\n\n${visitorTranscript(desk.transcript)}`,
						creator: { type: "system", id: "tedix" },
						targetType: "user",
						targetId: company.handoff.userId,
						metadata: {
							source: "poppy-conversation",
							conversationId: desk.conversationId,
							tediId: company.tediId,
						},
						now: new Date().toISOString(),
					});
				} catch (error) {
					if (
						!(await getWorkInteraction(db, {
							orgId: input.organizationId,
							interactionId: desk.interactionId,
						}))
					)
						throw error;
				}
				const fresh = await call({
					...payload,
					method: "GET",
					path: `${desk.conversationId}/events`,
					cursor: null,
					wait: 0,
					includeEvents: false,
				});
				if (
					!fresh.desks.some(
						(row) => row.interactionId === desk.interactionId && row.pending,
					)
				) {
					const card = await getWorkInteraction(db, {
						orgId: input.organizationId,
						interactionId: desk.interactionId,
					});
					if (card?.status === "open")
						await cancelWorkInteraction(db, {
							orgId: input.organizationId,
							interactionId: card.id,
							expectedVersion: card.version,
							actor: { type: "system", id: "tedix" },
							now: new Date().toISOString(),
						});
				}
			} else if (current.status !== "open") {
				const responses = await listWorkInteractionResponses(db, {
					orgId: input.organizationId,
					interactionId: current.id,
					limit: 100,
				});
				const human = responses.find(
					(r) =>
						r.responderType === "user" &&
						r.responderId === company.handoff!.userId &&
						r.resolvesRequest,
				);
				result = await call({
					...payload,
					method: "GET",
					path: `${desk.conversationId}/events`,
					wait: 0,
					includeEvents: true,
					deskReply: {
						conversationId: desk.conversationId,
						interactionId: desk.interactionId,
						text: human?.body ?? null,
					},
				});
			}
		}
		// Internal desk metadata never reaches a signed-out client. POST status stays 201/202.
		if (input.method === "POST" && wait === null)
			return {
				httpStatus: path ? 202 : 201,
				body: {
					conversation_id: conversationId,
				},
			};
		result = await call({
			...payload,
			method: "GET",
			path: `${conversationId}/events`,
			wait: 0,
			includeEvents: true,
		});
		return {
			...result.receipt,
			httpStatus:
				input.method === "POST"
					? path
						? 202
						: 201
					: result.receipt.httpStatus,
		};
	} catch {
		return error(503, "unavailable");
	}
}
