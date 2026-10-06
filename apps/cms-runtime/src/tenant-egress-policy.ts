import { RPCSerializer } from "@orpc/client";
import { CmsEditorProposalInputSchema } from "@tedix/api-contract/schemas/cms-editor-proposals";
import { validateUrl } from "@tedix/ssrf-guard";

export interface TenantEgressDecision {
	decision: "allow" | "deny";
	host: string;
	reason: string | null;
}

/** The configured identity key endpoint needed by tenant Descope auth. */
export function isConfiguredDescopeJwksRequest(
	request: Request,
	config: { baseUrl?: string; projectId?: string },
): boolean {
	if (request.method !== "GET" || !config.baseUrl || !config.projectId)
		return false;
	if (!/^[A-Za-z0-9_-]+$/.test(config.projectId)) return false;

	try {
		const base = new URL(config.baseUrl);
		if (
			base.protocol !== "https:" ||
			base.hostname !== "auth.tedix.dev" ||
			base.port ||
			base.username ||
			base.password ||
			base.search ||
			base.hash
		)
			return false;
		const expected = new URL(
			`${base.href.replace(/\/+$/, "")}/${config.projectId}/.well-known/jwks.json`,
		);
		return new URL(request.url).href === expected.href;
	} catch {
		return false;
	}
}

/** Drop every tenant-supplied header before the parent fetches identity keys. */
export function descopeJwksFetchRequest(request: Request): Request {
	return new Request(request.url, {
		method: "GET",
		headers: { Accept: "application/json" },
		redirect: "manual",
	});
}

const CMS_EDITOR_PROPOSAL_URL =
	"https://api.tedix.dev/rpc/sites/proposeCmsEditorDraft";
// The shared schema caps the draft at 48 KiB; leave room for native RPC metadata.
const CMS_EDITOR_PROPOSAL_MAX_BYTES = 64 * 1024;

/** The API independently verifies the JWT and fresh CMS editorial membership. */
export async function cmsEditorProposalFetchRequest(
	request: Request,
	siteId: string,
): Promise<Request | null> {
	if (request.method !== "POST" || request.url !== CMS_EDITOR_PROPOSAL_URL)
		return null;
	const authorization = request.headers.get("authorization");
	if (
		!authorization ||
		!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
			authorization,
		) ||
		request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
			"application/json" ||
		request.headers.has("content-encoding")
	)
		return null;
	const declaredBytes = Number(request.headers.get("content-length") ?? "0");
	if (
		!Number.isFinite(declaredBytes) ||
		declaredBytes < 0 ||
		declaredBytes > CMS_EDITOR_PROPOSAL_MAX_BYTES ||
		!request.body
	)
		return null;
	const reader = request.body.getReader();
	let bytes = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > CMS_EDITOR_PROPOSAL_MAX_BYTES) return null;
			chunks.push(value);
		}
		const body = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const input = CmsEditorProposalInputSchema.safeParse(
			new RPCSerializer().deserialize(
				JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
			),
		);
		if (!input.success || input.data.siteId !== siteId) return null;
		return new Request(CMS_EDITOR_PROPOSAL_URL, {
			method: "POST",
			body,
			headers: {
				Authorization: authorization,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			redirect: "manual",
		});
	} catch {
		return null;
	} finally {
		void reader.cancel().catch(() => {});
	}
}

/**
 * Apply the CMS tenant-isolate outbound policy before the parent Worker makes
 * the real network request. The shared guard rejects private, link-local, and
 * Tedix-internal destinations; `global_fetch_strictly_public` remains the
 * DNS-level boundary for public hostnames that resolve or rebind privately.
 */
export function tenantEgressDecision(rawUrl: string): TenantEgressDecision {
	let host = "invalid";
	try {
		host = new URL(rawUrl).hostname.toLowerCase();
	} catch {
		return { decision: "deny", host, reason: "Invalid URL" };
	}

	const reason = validateUrl(rawUrl);
	return reason
		? { decision: "deny", host, reason }
		: { decision: "allow", host, reason: null };
}
