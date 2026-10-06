import { constantTimeEquals } from "./tenant-internal-auth";

export const CMS_HUMAN_IDENTITY_HEADER = "X-Tedix-CMS-Human-Identity";
export const CMS_HUMAN_ASSERTION_HEADER = "X-Tedix-CMS-Human-Assertion";
const CMS_FORWARDED_USER_AUTH_HEADER = "X-Tedix-CMS-Forwarded-User-Auth";

/** An attested human request must read the current activation marker, including revocations. */
export function hasAttestedCmsHumanIdentity(
	request: Request,
	sharedToken: string | undefined,
): boolean {
	const identity = request.headers.get(CMS_HUMAN_IDENTITY_HEADER);
	const attestation = request.headers.get(CMS_FORWARDED_USER_AUTH_HEADER);
	return Boolean(
		identity?.trim() &&
		sharedToken &&
		attestation &&
		constantTimeEquals(attestation, sharedToken),
	);
}

export interface CmsHumanIdentity {
	siteId: string;
	slug: string;
	bundleEtag: string;
	tenantId: string;
	subject: string;
	email: string;
	name: string;
	role: 10 | 40 | 50;
}

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function validIdentity(value: unknown): value is CmsHumanIdentity {
	if (!value || typeof value !== "object") return false;
	const input = value as Record<string, unknown>;
	return (
		[
			"siteId",
			"slug",
			"bundleEtag",
			"tenantId",
			"subject",
			"email",
			"name",
		].every(
			(key) =>
				typeof input[key] === "string" && (input[key] as string).length > 0,
		) && [10, 40, 50].includes(input.role as number)
	);
}

export function decodeCmsHumanIdentity(
	encoded: string | null,
): CmsHumanIdentity | null {
	if (!encoded || encoded.length > 4096) return null;
	try {
		const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return validIdentity(value) ? value : null;
	} catch {
		return null;
	}
}

export async function deriveTenantHumanAuthKey(args: {
	sharedToken: string | undefined;
	siteId: string;
	slug: string;
	bundleEtag: string;
}): Promise<string | undefined> {
	if (!args.sharedToken) return undefined;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(args.sharedToken),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const data = encoder.encode(
		`tedix-cms-human-key:v1:${args.siteId}:${args.slug}:${args.bundleEtag}`,
	);
	return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}

async function sign(keyText: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(keyText),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return b64url(
		new Uint8Array(
			await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
		),
	);
}

export async function mintCmsHumanAssertion(args: {
	key: string;
	identity: CmsHumanIdentity;
	request: Request;
	now?: number;
}): Promise<string> {
	const issuedAt = args.now ?? Math.floor(Date.now() / 1000);
	const url = new URL(args.request.url);
	const payload = b64url(
		encoder.encode(
			JSON.stringify({
				...args.identity,
				method: args.request.method.toUpperCase(),
				path: url.pathname + url.search,
				iat: issuedAt,
				exp: issuedAt + 30,
			}),
		),
	);
	return `${payload}.${await sign(args.key, payload)}`;
}

export async function forwardCmsHumanAssertion(args: {
	original: Request;
	tenantRequest: Request;
	sharedToken: string | undefined;
	key: string | undefined;
	expected: Pick<
		CmsHumanIdentity,
		"siteId" | "slug" | "bundleEtag" | "tenantId"
	>;
}): Promise<Request> {
	if (
		!args.original.headers.has(CMS_HUMAN_IDENTITY_HEADER) &&
		!args.tenantRequest.headers.has(CMS_HUMAN_ASSERTION_HEADER)
	)
		return args.tenantRequest;
	const headers = new Headers(args.tenantRequest.headers);
	// Neutralize all public-supplied assertion material even when Request init merges headers.
	headers.set(CMS_HUMAN_IDENTITY_HEADER, "");
	headers.set(CMS_HUMAN_ASSERTION_HEADER, "");
	const attestation = args.original.headers.get(CMS_FORWARDED_USER_AUTH_HEADER);
	const identity = decodeCmsHumanIdentity(
		args.original.headers.get(CMS_HUMAN_IDENTITY_HEADER),
	);
	if (
		args.sharedToken &&
		args.key &&
		attestation &&
		constantTimeEquals(attestation, args.sharedToken) &&
		identity &&
		identity.siteId === args.expected.siteId &&
		identity.slug === args.expected.slug &&
		identity.bundleEtag === args.expected.bundleEtag &&
		identity.tenantId === args.expected.tenantId
	) {
		headers.set(
			CMS_HUMAN_ASSERTION_HEADER,
			await mintCmsHumanAssertion({
				key: args.key,
				identity,
				request: args.tenantRequest,
			}),
		);
	}
	return new Request(args.tenantRequest, { headers });
}
