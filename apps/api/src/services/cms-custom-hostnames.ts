const CF_API = "https://api.cloudflare.com/client/v4";
const DNS_API = "https://cloudflare-dns.com/dns-query";

export interface CmsCustomHostnameEnv {
	CF_CMS_SAAS_ZONE_ID?: string;
	CF_CMS_HOSTNAMES_TOKEN?: string;
	CF_CMS_SAAS_TARGET_DOMAIN?: string;
}

export interface CmsCustomHostname {
	id: string;
	hostname: string;
	status: string;
	ssl?: {
		status?: string;
		method?: string;
		type?: string;
		validation_records?: Array<{
			status?: string;
			txt_name?: string;
			txt_value?: string;
			cname?: string;
			cname_target?: string;
			http_url?: string;
			http_body?: string;
		}>;
	};
	ownership_verification?: {
		type?: "txt";
		name?: string;
		value?: string;
	};
	verification_errors?: string[];
}

interface CfResponse<T> {
	success?: boolean;
	result?: T;
	errors?: Array<{ code?: number; message?: string }>;
}

function assertHostname(hostname: string): string {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	if (
		normalized.length > 253 ||
		!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/.test(
			normalized,
		) ||
		normalized === "tedix.dev" ||
		normalized.endsWith(".tedix.dev") ||
		normalized === "tedix.tech" ||
		normalized.endsWith(".tedix.tech")
	)
		throw new Error("Invalid CMS custom hostname");
	return normalized;
}

function config(env: CmsCustomHostnameEnv) {
	const zoneId = env.CF_CMS_SAAS_ZONE_ID?.trim();
	const token = env.CF_CMS_HOSTNAMES_TOKEN?.trim();
	if (!zoneId || !/^[a-f0-9]{32}$/.test(zoneId) || !token)
		throw new Error("CMS custom hostname provider is not configured");
	return { zoneId, token };
}

export function cmsCustomHostnameTarget(
	env: CmsCustomHostnameEnv,
	siteSlug: string,
): string {
	const targetDomain = env.CF_CMS_SAAS_TARGET_DOMAIN?.trim().toLowerCase();
	if (
		targetDomain !== "cms.tedix.dev" ||
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(siteSlug)
	)
		throw new Error("CMS custom hostname target is not configured");
	return `${siteSlug}.${targetDomain}`;
}

async function request<T>(
	env: CmsCustomHostnameEnv,
	method: "GET" | "POST" | "DELETE",
	path: string,
	options: { body?: unknown; allowMissing?: boolean } = {},
): Promise<T | null> {
	const { zoneId, token } = config(env);
	const response = await fetch(
		`${CF_API}/zones/${zoneId}/custom_hostnames${path}`,
		{
			method,
			signal: AbortSignal.timeout(30_000),
			headers: {
				Authorization: `Bearer ${token}`,
				...(options.body ? { "Content-Type": "application/json" } : {}),
			},
			...(options.body ? { body: JSON.stringify(options.body) } : {}),
		},
	);
	if (response.status === 404 && options.allowMissing) return null;
	const payload = (await response.json().catch(() => ({}))) as CfResponse<T>;
	if (!response.ok || !payload.success || payload.result === undefined) {
		const detail = payload.errors
			?.map((error) => `${error.code ?? "?"}: ${error.message ?? "unknown"}`)
			.join("; ");
		throw new Error(
			`CMS custom hostname provider ${method} failed: ${detail || response.status}`,
		);
	}
	return payload.result;
}

export function createCmsDomainVerificationToken(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function cmsDomainVerificationName(hostname: string): string {
	return `_tedix-cms.${assertHostname(hostname)}`;
}

export async function createCmsCustomHostname(
	env: CmsCustomHostnameEnv,
	hostname: string,
): Promise<CmsCustomHostname> {
	const exact = assertHostname(hostname);
	const result = await request<CmsCustomHostname>(env, "POST", "", {
		body: {
			hostname: exact,
			ssl: { method: "txt", type: "dv" },
		},
	});
	if (!result?.id || result.hostname.toLowerCase() !== exact)
		throw new Error(
			"CMS custom hostname provider returned an invalid identity",
		);
	return result;
}

export async function getCmsCustomHostname(
	env: CmsCustomHostnameEnv,
	id: string,
): Promise<CmsCustomHostname | null> {
	if (!/^[a-zA-Z0-9-]{1,64}$/.test(id))
		throw new Error("Invalid CMS custom hostname ID");
	return request<CmsCustomHostname>(env, "GET", `/${encodeURIComponent(id)}`, {
		allowMissing: true,
	});
}

export async function findCmsCustomHostname(
	env: CmsCustomHostnameEnv,
	hostname: string,
): Promise<CmsCustomHostname | null> {
	const exact = assertHostname(hostname);
	const query = new URLSearchParams({ "hostname.exact": exact, per_page: "2" });
	const result = await request<CmsCustomHostname[]>(
		env,
		"GET",
		`?${query.toString()}`,
	);
	return result?.find((item) => item.hostname.toLowerCase() === exact) ?? null;
}

/** Deletion is idempotent for a provider ID already gone. */
export async function deleteCmsCustomHostname(
	env: CmsCustomHostnameEnv,
	id: string,
	expectedHostname: string,
): Promise<boolean> {
	if (!/^[a-zA-Z0-9-]{1,64}$/.test(id))
		throw new Error("Invalid CMS custom hostname ID");
	const exact = assertHostname(expectedHostname);
	const current = await getCmsCustomHostname(env, id);
	if (!current) return false;
	if (current.hostname.toLowerCase() !== exact)
		throw new Error("CMS custom hostname provider identity mismatch");
	return Boolean(
		await request<{ id: string }>(env, "DELETE", `/${encodeURIComponent(id)}`, {
			allowMissing: true,
		}),
	);
}

export function isCmsCustomHostnameReady(hostname: CmsCustomHostname): boolean {
	return hostname.status === "active" && hostname.ssl?.status === "active";
}

interface DnsJson {
	Status?: number;
	Answer?: Array<{ name?: string; type?: number; data?: string }>;
}

async function dnsRecords(hostname: string, type: "TXT" | "CNAME" | "SOA") {
	const url = new URL(DNS_API);
	url.searchParams.set("name", hostname);
	url.searchParams.set("type", type);
	const response = await fetch(url, {
		headers: { Accept: "application/dns-json" },
	});
	if (!response.ok) throw new Error(`CMS DNS check failed: ${response.status}`);
	const body = (await response.json()) as DnsJson;
	if (body.Status !== 0) return [];
	return body.Answer ?? [];
}

/** Fresh per-claim proof; a dangling CNAME alone never establishes ownership. */
export async function verifyCmsDnsChallenge(
	hostname: string,
	verificationToken: string,
): Promise<boolean> {
	if (!/^[a-f0-9]{64}$/.test(verificationToken))
		throw new Error("Invalid CMS domain verification token");
	const name = cmsDomainVerificationName(hostname);
	const records = await dnsRecords(name, "TXT");
	return records.some(
		(record) =>
			record.type === 16 &&
			record.name?.toLowerCase().replace(/\.$/, "") === name &&
			record.data?.replaceAll('"', "").replaceAll(" ", "") ===
				verificationToken,
	);
}

/** Direct CNAME proof. Proxied O2O DNS may hide the target from public DNS. */
export async function verifyCmsDnsTarget(
	hostname: string,
	expectedTarget: string,
): Promise<boolean> {
	const normalized = assertHostname(hostname);
	const target = expectedTarget.toLowerCase().replace(/\.$/, "");
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.cms\.tedix\.dev$/.test(target))
		throw new Error("Invalid CMS SaaS target");
	const records = await dnsRecords(normalized, "CNAME");
	return records.some(
		(record) =>
			record.type === 5 &&
			record.name?.toLowerCase().replace(/\.$/, "") === normalized &&
			record.data?.toLowerCase().replace(/\.$/, "") === target,
	);
}

/** A flattened apex CNAME has no public CNAME answer. The provider's active
 * hostname and certificate supply the target proof before activation. */
export async function verifyCmsDnsZoneApex(hostname: string): Promise<boolean> {
	const normalized = assertHostname(hostname);
	const records = await dnsRecords(normalized, "SOA");
	return records.some(
		(record) =>
			record.type === 6 &&
			record.name?.toLowerCase().replace(/\.$/, "") === normalized,
	);
}
