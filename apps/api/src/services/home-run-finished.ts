import { ORPCError } from "@orpc/server";
import { hasPermission } from "@tedix/auth/rbac";
import { listHomeRunFinishedEvents } from "@tedix/db/queries/kernel-runtime-events";
import { resolveOwnerHostSession } from "@tedix/db/queries/external-agent-identity/owner-host-sessions";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { resolveKernelConversationAccess } from "../kernel/conversation-access";
import type { BaseContext } from "../rpc/orpc";

type Position = { at: string; id: string };

async function cursorId(organizationId: string, id: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${organizationId}:${id}`),
	);
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function resolvePosition(
	context: BaseContext,
	organizationId: string,
	conversationId: string | undefined,
	position: Position,
): Promise<Position> {
	if (!position.id) return position;
	let after = { at: position.at, id: "" };
	// Only the timestamp's tie group is searched. Public cursors never expose
	// private ledger IDs, which can also exceed the transport's keyset bound.
	for (;;) {
		const rows = await listHomeRunFinishedEvents(context.db, {
			organizationId,
			conversationId,
			after,
			limit: 100,
		});
		for (const row of rows) {
			if (row.at !== position.at) break;
			if (
				row.id === position.id ||
				(await cursorId(organizationId, row.id)) === position.id
			)
				return { at: row.at, id: row.id };
		}
		const last = rows.at(-1);
		if (!last || rows.length < 100 || last.at !== position.at)
			throw new Error(
				"Home event cursor is no longer available; start from now",
			);
		after = { at: last.at, id: last.id };
	}
}

export async function pollHomeRunFinished(
	context: BaseContext,
	input: {
		after?: { at: string; id: string } | null;
		agentSessionKey?: string;
		conversationId?: string;
		limit: number;
	},
	organizationId: string,
) {
	let ownerHostSessionId: string | undefined;
	if (input.agentSessionKey) {
		const subject = context.descopeUserId ?? context.user?.sub ?? "";
		const member = await getMemberByUserId(context.db, organizationId, subject);
		if (
			member?.status !== "active" ||
			!member.userId ||
			!hasPermission(
				{ roles: [member.role], permissions: member.customPermissions ?? [] },
				"tedis:read",
			)
		)
			throw new ORPCError("FORBIDDEN", {
				message: "Current chat access is required",
			});
		const recipient = await resolveOwnerHostSession(context.db, {
			organizationId,
			userId: member.userId,
			externalSessionKey: input.agentSessionKey,
		});
		if (!recipient)
			throw new ORPCError("FORBIDDEN", {
				message: "Agent session is unavailable",
			});
		ownerHostSessionId = recipient.session.id;
	}
	const after = input.after
		? await resolvePosition(
				context,
				organizationId,
				input.conversationId,
				input.after,
			)
		: input.after;
	const rows = await listHomeRunFinishedEvents(context.db, {
		organizationId,
		...input,
		ownerHostSessionId,
		after,
		head: input.after == null,
		limit: input.after == null ? 1 : input.limit + 1,
	});
	if (input.after == null)
		return {
			events: [],
			after: rows[0]
				? { at: rows[0].at, id: await cursorId(organizationId, rows[0].id) }
				: { at: "", id: "" },
			hasMore: false,
		};
	const page = rows.slice(0, input.limit);
	const events = [];
	for (const row of page) {
		const access = await resolveKernelConversationAccess(context.db, {
			organizationId,
			conversationId: row.conversationId,
			descopeUserId: context.descopeUserId ?? context.user?.sub ?? null,
			required: "read",
		});
		if (!access.allowed) continue;
		events.push({
			eventId: `evt_home_${row.parentRunId ?? ""}_${row.runId}_${row.status}`,
			timestamp: row.at,
			data: {
				organization_id: organizationId,
				conversation_id: row.conversationId,
				run_id: row.runId,
				parent_run_id: row.parentRunId,
				status: row.status,
			},
		});
	}
	const last = page.at(-1);
	return {
		events,
		after: last
			? { at: last.at, id: await cursorId(organizationId, last.id) }
			: input.after,
		hasMore: rows.length > input.limit,
	};
}
