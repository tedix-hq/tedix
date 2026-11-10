import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import {
	AppRuntimeGuestNameSchema,
	AppRuntimeRoleSchema,
} from "@tedix/api-contract/schemas/os-app-runtime";

export const APP_SESSION_TTL_SECONDS = 300;
const issuer = "tedix:workspace-app";
const audience = "tedix:workspace-app-host";

export const WorkspaceAppSessionSchema = z
	.object({
		organizationId: z.string().min(1),
		workspaceId: z.uuid(),
		gadgetId: z.uuid(),
		revisionId: z.uuid(),
		revision: z.number().int().positive(),
		actorUserId: z.string().optional(),
		actorPermissions: z.array(z.string()).optional(),
		config: z.record(z.string(), z.json()).optional(),
		compatibilityDate: z.string().optional(),
		principal: z
			.object({ kind: z.string().min(1), id: z.string().min(1) })
			.strict(),
		role: AppRuntimeRoleSchema,
		grants: z.array(
			z
				.object({ slot: z.string().min(1), operations: z.array(z.string()) })
				.strict(),
		),
		previewId: z.uuid().optional(),
		proposalId: z.uuid().optional(),
		proposalSequence: z.number().int().nonnegative().optional(),
		codeDigest: z.string().optional(),
		/** Set for a guest who opened the app through a share link; revoking the link cuts the session. */
		shareLinkId: z.uuid().optional(),
		/** Guest name or verified share email, bound to this signed session for call receipts. */
		guestName: z
			.union([AppRuntimeGuestNameSchema, z.email().max(254)])
			.optional(),
	})
	.strict();
export type WorkspaceAppSession = z.infer<typeof WorkspaceAppSessionSchema>;

async function signingKey(secret: string) {
	if (!secret) throw new Error("App session signing unavailable");
	const source = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		"HKDF",
		false,
		["deriveBits"],
	);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt: new TextEncoder().encode(issuer),
				info: new TextEncoder().encode(audience),
			},
			source,
			256,
		),
	);
}

export async function mintWorkspaceAppSession(
	secret: string,
	session: WorkspaceAppSession,
) {
	const now = Math.floor(Date.now() / 1000);
	const expiresAt = now + APP_SESSION_TTL_SECONDS;
	const token = await new SignJWT({
		app: WorkspaceAppSessionSchema.parse(session),
	})
		.setProtectedHeader({ alg: "HS256", typ: "tedix.workspace-app" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setIssuedAt(now)
		.setExpirationTime(expiresAt)
		.setJti(crypto.randomUUID())
		.sign(await signingKey(secret));
	return { token, expiresAt };
}

export async function verifyWorkspaceAppSession(secret: string, token: string) {
	const { payload, protectedHeader } = await jwtVerify(
		token,
		await signingKey(secret),
		{
			issuer,
			audience,
			algorithms: ["HS256"],
			maxTokenAge: APP_SESSION_TTL_SECONDS,
		},
	);
	if (
		protectedHeader.typ !== "tedix.workspace-app" ||
		!payload.jti ||
		typeof payload.iat !== "number" ||
		typeof payload.exp !== "number" ||
		payload.exp - payload.iat > APP_SESSION_TTL_SECONDS ||
		payload.iat > Math.floor(Date.now() / 1000)
	)
		throw new Error("Invalid app session");
	return {
		...WorkspaceAppSessionSchema.parse(payload.app),
		expiresAt: payload.exp,
		sessionId: payload.jti,
	};
}

/** How long an app call's access check vouches for the capability reads it makes. */
export const APP_CALL_GRANT_TTL_SECONDS = 60;
const callGrantAudience = "tedix:workspace-app-capability";

/**
 * Minted by the API after it re-checked the caller's workspace access for one
 * app call, bound to that call's session. The capability reads the call makes
 * within a minute reuse the check instead of repeating it.
 */
export async function mintAppCallGrant(
	secret: string,
	grant: {
		sessionId: string;
		role: WorkspaceAppSession["role"];
		revisionId: string;
	},
) {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ grant })
		.setProtectedHeader({ alg: "HS256", typ: "tedix.workspace-app-call" })
		.setIssuer(issuer)
		.setAudience(callGrantAudience)
		.setIssuedAt(now)
		.setExpirationTime(now + APP_CALL_GRANT_TTL_SECONDS)
		.sign(await signingKey(secret));
}

/** The grant's checked role and revision, or null when it is not valid for this session. */
export async function verifyAppCallGrant(
	secret: string,
	token: string,
	sessionId: string,
) {
	try {
		const { payload, protectedHeader } = await jwtVerify(
			token,
			await signingKey(secret),
			{
				issuer,
				audience: callGrantAudience,
				algorithms: ["HS256"],
				maxTokenAge: APP_CALL_GRANT_TTL_SECONDS,
			},
		);
		const grant = z
			.object({
				sessionId: z.string().min(1),
				role: AppRuntimeRoleSchema,
				revisionId: z.uuid(),
			})
			.strict()
			.parse(payload.grant);
		if (
			protectedHeader.typ !== "tedix.workspace-app-call" ||
			grant.sessionId !== sessionId
		)
			return null;
		return grant;
	} catch {
		return null;
	}
}
