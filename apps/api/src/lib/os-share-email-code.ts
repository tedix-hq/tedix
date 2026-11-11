import { OS_SHARE_PUBLIC_ID_PATTERN } from "@tedix/api-contract/contracts/os-shares";
import { base64UrlEncode } from "@tedix/auth/utils";
import { getOrganizationProfile } from "@tedix/db/queries/organizations";
import {
	consumeOsShareEmailCode,
	getOsShareCreatorName,
	getOsShareLinkByPublicId,
	isOsShareEmailInvited,
	reserveOsShareEmailCode,
} from "@tedix/db/queries/os-shares";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getOsGadget } from "@tedix/db/queries/os-workspaces/gadgets";
import type { DbQueryClient } from "@tedix/db/query-client";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";
import { z } from "zod";
import { sendTransactionalEmail } from "./email";
import {
	isActive,
	openOsShareSession,
	recipientMayOpen,
} from "./os-share-redemption";
import { getOsOutput } from "../services/workspace-output-storage";

type EmailEnv = Pick<
	CloudflareEnv,
	"SECRETS_MASTER_KEY" | "EMAIL" | "SHARE_EMAIL_FROM"
>;
const REPLY = "If this email is invited, we sent a code";
function json(body: unknown) {
	return Response.json(body, {
		headers: {
			"Cache-Control": "private, no-store",
			"Referrer-Policy": "no-referrer",
			"X-Robots-Tag": "noindex",
		},
	});
}

export async function hashOsShareEmailCode(
	secret: string,
	linkId: string,
	email: string,
	code: string,
) {
	const key = await deriveHkdfHmacKey(secret, "tedix-os-share-email-code:v1");
	return base64UrlEncode(
		await hmacSha256(key, JSON.stringify([linkId, email, code])),
	);
}

function generateCode(): string {
	const values = new Uint32Array(1);
	do {
		crypto.getRandomValues(values);
	} while (values[0]! >= 4294000000);
	return String(values[0]! % 1000000).padStart(6, "0");
}

async function invitedLink(
	db: DbQueryClient,
	publicId: string,
	hostTenantId: string | null,
) {
	if (!hostTenantId || !OS_SHARE_PUBLIC_ID_PATTERN.test(publicId)) return null;
	const link = await getOsShareLinkByPublicId(db, publicId);
	if (
		!link ||
		link.access !== "invited" ||
		!isActive(link, new Date().toISOString())
	)
		return null;
	const org = await getOrganizationProfile(db, link.organizationId);
	return org &&
		(hostTenantId === org.descopeTenantId || hostTenantId === org.id)
		? { ...link, organizationName: org.name }
		: null;
}

/** Uniform response for invited, uninvited, throttled and unknown recipients. */
export async function requestOsShareEmailCode(
	env: EmailEnv,
	db: DbQueryClient,
	input: { id: string; email: string; ip: string; hostTenantId: string | null },
	waitUntil?: (work: Promise<unknown>) => void,
) {
	const email = input.email.trim().toLowerCase();
	const link = await invitedLink(db, input.id, input.hostTenantId);
	if (!link || !z.email().max(254).safeParse(email).success)
		return json({ message: REPLY });
	const now = Date.now();
	const code = generateCode();
	const reserved = await reserveOsShareEmailCode(db, {
		id: crypto.randomUUID(),
		shareLinkId: link.id,
		email,
		codeHash: await hashOsShareEmailCode(
			env.SECRETS_MASTER_KEY,
			link.id,
			email,
			code,
		),
		ipHash: await hashOsShareEmailCode(
			env.SECRETS_MASTER_KEY,
			"ip",
			"",
			input.ip,
		),
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
		windowStart: new Date(now - 15 * 60 * 1000).toISOString(),
	});
	// Email transport latency must not reveal whether this email is invited.
	const deliver = async () => {
		const sender = z.email().safeParse(env.SHARE_EMAIL_FROM);
		if (!sender.success) {
			console.error("[os-share-email-code] SHARE_EMAIL_FROM is not configured");
			return;
		}
		if (reserved && (await isOsShareEmailInvited(db, link.id, email))) {
			const workspaceId =
				link.resourceType === "workspace"
					? link.resourceId
					: link.resourceType === "gadget"
						? (
								await getOsGadget(db, {
									organizationId: link.organizationId,
									gadgetId: link.resourceId,
								})
							)?.workspaceId
						: (
								await getOsOutput(db, {
									organizationId: link.organizationId,
									outputId: link.resourceId,
								})
							)?.workspaceId;
			const workspace = workspaceId
				? await getOsWorkspace(db, {
						organizationId: link.organizationId,
						workspaceId,
					})
				: null;
			const sharer =
				(await getOsShareCreatorName(db, link, { personOnly: true })) ??
				link.organizationName;
			await sendTransactionalEmail(env, {
				from: { email: sender.data, name: "Tedix" },
				to: [{ email }],
				subject: `Your code for ${workspace?.name ?? "a shared document"}`,
				text: `${sharer} shared ${workspace?.name ?? "a document"} with you.\n\nYour code is ${code}.\n\nIt expires in 10 minutes. You do not need a Tedix account. If you did not request this code, ignore this email.`,
			});
		}
	};
	if (waitUntil) waitUntil(deliver());
	else await deliver();
	return json({ message: REPLY });
}

export async function verifyOsShareEmailCode(
	env: EmailEnv,
	db: DbQueryClient,
	input: {
		id: string;
		email: string;
		code: string;
		hostTenantId: string | null;
	},
) {
	const email = input.email.trim().toLowerCase();
	const link = await invitedLink(db, input.id, input.hostTenantId);
	if (
		!link ||
		!z.email().max(254).safeParse(email).success ||
		input.code.length > 64
	)
		return json({ error: "Code invalid or expired" });
	const consumed = await consumeOsShareEmailCode(db, {
		linkId: link.id,
		email,
		codeHash: await hashOsShareEmailCode(
			env.SECRETS_MASTER_KEY,
			link.id,
			email,
			input.code,
		),
		now: new Date().toISOString(),
	});
	if (
		!consumed ||
		!(await recipientMayOpen(db, link, undefined, undefined, email))
	)
		return json({ error: "Code invalid or expired" });
	return openOsShareSession(
		db,
		link,
		new Date().toISOString(),
		undefined,
		undefined,
		undefined,
		email,
	);
}
