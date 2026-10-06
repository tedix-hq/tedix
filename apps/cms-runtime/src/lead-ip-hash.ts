/**
 * Parent-only lead-form IP pseudonymization.
 *
 * The HMAC key never enters a tenant Worker Loader isolate. The parent derives
 * a tenant-scoped pseudonym from Cloudflare-authenticated request metadata and
 * overwrites any caller-provided value before dispatch.
 */

export const LEAD_IP_HASH_HEADER = "X-Tedix-Lead-IP-Hash";
export const NATIVE_FORM_SUBMIT_PATH =
	"/_emdash/api/plugins/emdash-forms/submit";

const HMAC_DOMAIN = "tedix-lead-ip:v1";
const MINIMUM_HMAC_KEY_BYTES = 32;
const IP_ADDRESS = /^[\da-f:.]+$/i;
const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function neutralizeHeader(request: Request): Request {
	if (request.headers.get(LEAD_IP_HASH_HEADER) === null) return request;
	const headers = new Headers(request.headers);
	// An empty value reliably replaces the original across Bun and workerd.
	headers.set(LEAD_IP_HASH_HEADER, "");
	return new Request(request, { headers });
}

function trustedCloudflareIp(request: Request): string | undefined {
	const cf = (request as Request & { cf?: unknown }).cf;
	if (!cf || typeof cf !== "object") return undefined;
	const ip = request.headers.get("CF-Connecting-IP")?.trim();
	return ip && IP_ADDRESS.test(ip) ? ip : undefined;
}

export async function deriveLeadIpHash(
	secret: string,
	slug: string,
	ip: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(`${HMAC_DOMAIN}\0${slug}\0${ip}`),
	);
	return `h1:${toHex(signature).slice(0, 32)}`;
}

export async function protectLeadFormIp(
	request: Request,
	args: {
		originalRequest: Request;
		secret: string | undefined;
		slug: string;
	},
): Promise<Request | Response> {
	if (new URL(request.url).pathname !== NATIVE_FORM_SUBMIT_PATH) {
		return neutralizeHeader(request);
	}

	const secret = args.secret;
	if (!secret || encoder.encode(secret).byteLength < MINIMUM_HMAC_KEY_BYTES) {
		return Response.json(
			{ success: false, error: "lead form temporarily unavailable" },
			{
				status: 503,
				headers: { "Cache-Control": "no-store" },
			},
		);
	}

	const ip = trustedCloudflareIp(args.originalRequest);
	if (!ip) return neutralizeHeader(request);

	const headers = new Headers(request.headers);
	headers.set(
		LEAD_IP_HASH_HEADER,
		await deriveLeadIpHash(secret, args.slug, ip),
	);
	return new Request(request, { headers });
}
