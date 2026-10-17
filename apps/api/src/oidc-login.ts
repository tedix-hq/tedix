import {
	OIDC_SESSION_COOKIE,
	OIDC_STATE_COOKIE,
} from "@tedix/auth/oidc-cookies";
import {
	discoverOidc,
	exchangeOidcCode,
	mapOidcScopes,
	oidcDigest,
	oidcRandom,
	readOidcConfig,
} from "@tedix/auth/oidc";
import { resolveProductSession } from "@tedix/auth/product-session-broker";
import {
	consumeOidcLogin,
	deleteOidcSession,
	getOidcOrganization,
	getOidcSession,
	insertOidcRecord,
	resolveOidcMember,
} from "@tedix/db/queries/oidc-sessions";
import type { BaseContext } from "./rpc/context";

const now = () => Math.floor(Date.now() / 1000);
function cookie(name: string, value: string, age: number) {
	return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
}
async function organization(context: BaseContext, id: string) {
	const org = await getOidcOrganization(context.db, id);
	if (!org?.metadata?.identityProvider)
		throw new Error("OIDC is not configured");
	const config = readOidcConfig(
		org.metadata.identityProvider,
		context.env.ENVIRONMENT === "development",
	);
	return { org, config, digest: await oidcDigest(JSON.stringify(config)) };
}
export async function resolveOidcUser(
	context: BaseContext,
	credential: string,
) {
	const session = await getOidcSession(
		context.db,
		await oidcDigest(credential),
		now(),
	);
	if (!session?.subject) throw new Error("OIDC session unavailable");
	const { config, digest } = await organization(
		context,
		session.organizationId,
	);
	if (digest !== session.configDigest)
		throw new Error("OIDC configuration changed");
	const target = context.headers.get("X-Tedix-Tenant-Id");
	if (target && target !== session.organizationId)
		throw new Error("OIDC tenant mismatch");
	const member = await resolveOidcMember(
		context.db,
		session.organizationId,
		config.issuer,
		session.subject,
	);
	if (!member) throw new Error("OIDC active membership required");
	return {
		member,
		session,
		config,
		scopes: mapOidcScopes(config, session.scopes),
	};
}
/** Public protocol endpoints; organization selection is never membership authority. */
export async function handleOidcLogin(
	request: Request,
	context: BaseContext,
): Promise<Response> {
	const url = new URL(request.url);
	const verb = url.pathname.split("/").at(-1);
	const headers = new Headers({
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	});
	try {
		if (verb === "start" && request.method === "GET") {
			const id = url.searchParams.get("organization") ?? "";
			const { config, digest } = await organization(context, id);
			const metadata = await discoverOidc(config);
			const state = oidcRandom(),
				verifier = oidcRandom(),
				nonce = oidcRandom();
			await insertOidcRecord(context.db, {
				id: await oidcDigest(state),
				organizationId: id,
				kind: "login",
				configDigest: digest,
				verifier,
				nonce,
				expiresAt: now() + 600,
			});
			const destination = new URL(metadata.authorization_endpoint);
			destination.search = new URLSearchParams({
				response_type: "code",
				client_id: config.clientId,
				redirect_uri: config.redirectUri,
				scope: config.scopes.join(" "),
				state,
				nonce,
				code_challenge: await oidcDigest(verifier),
				code_challenge_method: "S256",
			}).toString();
			headers.set("Set-Cookie", cookie(OIDC_STATE_COOKIE, state, 600));
			headers.set("Location", destination.toString());
			return new Response(null, { status: 302, headers });
		}
		if (verb === "callback" && request.method === "GET") {
			const state = url.searchParams.get("state");
			if (
				!state ||
				resolveProductSession(
					request.headers.get("Cookie"),
					OIDC_STATE_COOKIE,
				) !== state
			)
				throw new Error("OIDC state mismatch");
			const login = await consumeOidcLogin(
				context.db,
				await oidcDigest(state),
				now(),
			);
			if (!login?.verifier || !login.nonce)
				throw new Error("OIDC login expired or replayed");
			const { config, digest } = await organization(
				context,
				login.organizationId,
			);
			if (digest !== login.configDigest)
				throw new Error("OIDC configuration changed");
			const tokens = await exchangeOidcCode({
				config,
				code: url.searchParams.get("code") ?? "",
				verifier: login.verifier,
				nonce: login.nonce,
			});
			if (
				!(await resolveOidcMember(
					context.db,
					login.organizationId,
					config.issuer,
					tokens.subject,
				))
			)
				throw new Error("OIDC active membership required");
			const credential = oidcRandom(),
				expiresAt = Math.min(tokens.expiresAt, now() + config.sessionSeconds);
			await insertOidcRecord(context.db, {
				id: await oidcDigest(credential),
				organizationId: login.organizationId,
				kind: "session",
				configDigest: digest,
				subject: tokens.subject,
				scopes: tokens.scopes,
				expiresAt,
			});
			headers.append(
				"Set-Cookie",
				cookie(OIDC_SESSION_COOKIE, credential, expiresAt - now()),
			);
			headers.append("Set-Cookie", cookie(OIDC_STATE_COOKIE, "", 0));
			headers.set("Location", new URL("/", config.redirectUri).toString());
			return new Response(null, { status: 302, headers });
		}
		const credential = resolveProductSession(
			request.headers.get("Cookie"),
			OIDC_SESSION_COOKIE,
		);
		if (!credential) throw new Error("OIDC session required");
		const user = await resolveOidcUser(context, credential);
		if (verb === "session" && request.method === "GET")
			return Response.json(
				{
					organizationId: user.session.organizationId,
					userId: user.member.userId,
					scopes: user.scopes,
					expiresAt: user.session.expiresAt,
					user: {
						name: user.member.name ?? user.member.email,
						email: user.member.email,
					},
				},
				{ headers },
			);
		if (verb === "logout" && request.method === "POST") {
			if (
				request.headers.get("Origin") !==
				new URL(user.config.redirectUri).origin
			)
				return new Response(null, { status: 403, headers });
			await deleteOidcSession(context.db, await oidcDigest(credential));
			headers.set("Set-Cookie", cookie(OIDC_SESSION_COOKIE, "", 0));
			// RP session is revoked before discovery; IdP sign-out is a separate browser navigation.
			let logoutUrl: string | null = null;
			try {
				const metadata = await discoverOidc(user.config);
				if (metadata.end_session_endpoint) {
					const dest = new URL(metadata.end_session_endpoint);
					dest.searchParams.set("client_id", user.config.clientId);
					dest.searchParams.set(
						"post_logout_redirect_uri",
						new URL("/", user.config.redirectUri).toString(),
					);
					logoutUrl = dest.toString();
				}
			} catch {
				/* Local revocation does not depend on IdP availability. */
			}
			return Response.json({ loggedOut: true, logoutUrl }, { headers });
		}
		return new Response(null, { status: 404, headers });
	} catch {
		return Response.json(
			{ error: "OIDC authentication failed" },
			{ status: 401, headers },
		);
	}
}
