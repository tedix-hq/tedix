import { buildPushPayload } from "@block65/webcrypto-web-push";
import {
	WebPushPreferencesSchema,
	WebPushSubscriptionSchema,
	webPushTemplate,
	type WebPushKind,
} from "@tedix/api-contract/schemas/web-push";
import {
	deletePushConfig,
	hasVisiblePushConversation,
	listPushConfigs,
} from "@tedix/db/queries/web-push";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { getKernelConversation } from "@tedix/db/queries/kernel-conversations";
import { listOsWorkspaceProjects } from "@tedix/db/queries/os-workspaces/projects";
import {
	getMembersByOrganization,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import { resolveKernelConversationAccess } from "../kernel/conversation-access";
import type { KernelRuntimeEvent } from "@tedix/db/queries/kernel-runtime-events";
import {
	getOsWorkspace,
	isOsWorkspaceVisibleTo,
} from "@tedix/db/queries/os-workspaces/workspaces";
import type { BaseContext } from "../rpc/context";

// Optional installation secrets. Their absence never prevents API startup or a run.
interface WebPushEnv {
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
}
export function webPushKeys(env: WebPushEnv) {
	return env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
		? {
				publicKey: env.VAPID_PUBLIC_KEY,
				privateKey: env.VAPID_PRIVATE_KEY,
				subject: env.VAPID_SUBJECT,
			}
		: null;
}
export async function pushEndpointKey(endpoint: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(endpoint),
	);
	return `subscription:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export function pushKind(
	event: Pick<KernelRuntimeEvent, "kind" | "payload">,
): WebPushKind | null {
	if (event.kind === "approval.requested") return "approval";
	if (event.kind !== "run.completed") return null;
	if (
		event.payload?.status === "needs_delegation" &&
		(event.payload?.route as { routeKind?: string } | undefined)?.routeKind ===
			"ask_human"
	)
		return "needs_input";
	return event.payload?.status === "completed" ? "finished" : null;
}
export function shouldPush(input: {
	kind: WebPushKind;
	personStarted: boolean;
	visible: boolean;
	projectIds: string[];
	mutedProjectIds: string[];
}) {
	if (input.visible) return false;
	if (input.kind === "finished" && !input.personStarted) return false;
	return (
		input.kind === "approval" ||
		!input.projectIds.some((id) => input.mutedProjectIds.includes(id))
	);
}

export async function deliverWebPush(
	context: BaseContext,
	event: KernelRuntimeEvent,
) {
	const keys = webPushKeys(context.env);
	const kind = pushKind(event);
	if (!keys || !kind || !event.runId) return;
	const run = await getKernelRuntimeRun(context.db, {
		organizationId: event.organizationId,
		id: event.runId,
	});
	const stamp = run?.metadata?.pushRecipient;
	const recipient =
		stamp && typeof stamp === "object" && !Array.isArray(stamp) ? stamp : null;
	const subject = recipient?.descopeUserId;
	const member =
		typeof subject === "string"
			? await getMemberByUserId(context.db, event.organizationId, subject)
			: undefined;
	const recipients = member
		? [member]
		: kind === "approval" && !recipient
			? (
					await Promise.all(
						(["owner", "admin"] as const).map((role) =>
							getMembersByOrganization(context.db, event.organizationId, {
								status: "active",
								role,
							}),
						),
					)
				).flat()
			: [];
	for (const member of recipients) {
		if (member.status !== "active" || !member.userId) continue;
		await deliverToMember(
			context,
			event,
			kind,
			member.descopeUserId,
			member.userId,
			recipient?.personStarted === true,
			keys,
		);
	}
}

async function deliverToMember(
	context: BaseContext,
	event: KernelRuntimeEvent,
	kind: WebPushKind,
	subject: string,
	userId: string,
	personStarted: boolean,
	keys: NonNullable<ReturnType<typeof webPushKeys>>,
) {
	const access = await resolveKernelConversationAccess(context.db, {
		organizationId: event.organizationId,
		conversationId: event.conversationId,
		descopeUserId: subject,
		required: "read",
	});
	if (!access.allowed) return;
	const scope = { organizationId: event.organizationId, userId };
	const conversation = await getKernelConversation(context.db, {
		organizationId: event.organizationId,
		conversationId: event.conversationId,
	});
	if (!conversation || conversation.deletedAt) return;
	if (conversation.workspaceId) {
		const workspace = await getOsWorkspace(context.db, {
			organizationId: event.organizationId,
			workspaceId: conversation.workspaceId,
		});
		if (
			!workspace ||
			!isOsWorkspaceVisibleTo(workspace, { userIds: [subject, userId] })
		)
			return;
	}
	const projects = conversation?.workspaceId
		? await listOsWorkspaceProjects(context.db, {
				organizationId: event.organizationId,
				workspaceId: conversation.workspaceId,
				status: "active",
			})
		: [];
	const preferences = WebPushPreferencesSchema.safeParse(
		(await listPushConfigs(context.db, scope, "preferences"))[0]?.value,
	);
	if (
		!shouldPush({
			kind,
			personStarted,
			visible: await hasVisiblePushConversation(
				context.db,
				scope,
				event.conversationId,
				Date.now(),
			),
			projectIds: projects.map((project) => project.projectId),
			mutedProjectIds: preferences.success
				? preferences.data.mutedProjectIds
				: [],
		})
	)
		return;
	for (const row of await listPushConfigs(context.db, scope, "subscription:")) {
		const parsed = WebPushSubscriptionSchema.safeParse(row.value);
		if (!parsed.success) continue;
		if (
			parsed.data.expirationTime &&
			parsed.data.expirationTime <= Date.now()
		) {
			await deletePushConfig(context.db, scope, row.key);
			continue;
		}
		try {
			const payload = {
				...webPushTemplate(kind),
				conversationId: event.conversationId,
				tag: event.id,
			};
			const request = await buildPushPayload(
				{ data: JSON.stringify(payload), options: { ttl: 300 } },
				{ ...parsed.data, expirationTime: parsed.data.expirationTime ?? null },
				keys,
			);
			const response = await fetch(parsed.data.endpoint, {
				...request,
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			});
			if (response.status === 404 || response.status === 410)
				await deletePushConfig(context.db, scope, row.key);
			else if (!response.ok)
				console.warn("web_push_rejected", { status: response.status });
		} catch {
			console.warn("web_push_failed");
		}
	}
}
