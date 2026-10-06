import {
	type CloudflareResource,
	type InstallationManifest,
	parseInstallationManifest,
} from "./schema";

export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

type ResourceKind = CloudflareResource["kind"];
type Requirement = "required" | "optional";

export type PreflightCheckStatus =
	| "ok"
	| "forbidden"
	| "unavailable"
	| "error"
	| "unresolved";

export interface PreflightCheck {
	id: string;
	account?: string;
	kinds: ResourceKind[];
	requirement: Requirement;
	path?: string;
	status: PreflightCheckStatus;
	httpStatus?: number;
	detail?: string;
}

export interface PreflightReport {
	ok: boolean;
	mutationAllowed: boolean;
	checks: PreflightCheck[];
}

export interface PreflightOptions {
	manifest: unknown;
	apiToken: string;
	apiBaseUrl?: string;
	fetchImplementation?: typeof fetch;
}

/**
 * Read-only capability probe per resource kind. Every schema resource kind
 * MUST have an entry — the Record type fails compilation when a new kind is
 * added without deciding its probe, which is the fail-closed ratchet behind
 * "never silently omit a required dependency".
 */
const CAPABILITY_PROBE_PATHS: Record<ResourceKind, string> = {
	ai: "/ai/models/search?per_page=1",
	assets: "/workers/scripts",
	browser: "/browser-rendering/devtools/session?limit=1",
	container: "/containers/applications",
	d1: "/d1/database?per_page=1",
	"durable-object": "/workers/durable_objects/namespaces?per_page=1",
	hyperdrive: "/hyperdrive/configs?per_page=1",
	kv: "/storage/kv/namespaces?per_page=1",
	queue: "/queues?per_page=1",
	r2: "/r2/buckets?per_page=1",
	service: "/workers/scripts",
	vectorize: "/vectorize/v2/indexes",
	workflow: "/workflows?per_page=1",
};

/**
 * Resource inventories that a fresh-account certification must prove empty.
 * Account capabilities (AI, Browser Rendering), operator-held Hyperdrive, and
 * deploy-only state without a list API are deliberately excluded. Worker
 * scripts are checked separately for every fresh account because every Tedix
 * installation declares at least one Worker.
 */
const FRESH_RESOURCE_PROBE_PATHS: Partial<Record<ResourceKind, string>> = {
	assets: "/workers/scripts?per_page=1",
	container: "/containers/applications?per_page=1",
	d1: "/d1/database?per_page=1",
	"durable-object": "/workers/durable_objects/namespaces?per_page=1",
	kv: "/storage/kv/namespaces?per_page=1",
	queue: "/queues?per_page=1",
	r2: "/r2/buckets?per_page=1",
	service: "/workers/scripts?per_page=1",
	vectorize: "/vectorize/v2/indexes?per_page=1",
	workflow: "/workflows?per_page=1",
};

interface ProbeOutcome {
	status: PreflightCheckStatus;
	httpStatus?: number;
	detail?: string;
	result?: unknown;
}

async function probe(
	url: string,
	apiToken: string,
	fetchImplementation: typeof fetch,
): Promise<ProbeOutcome> {
	let response: Response;
	try {
		response = await fetchImplementation(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiToken}` },
		});
	} catch (error) {
		return {
			status: "error",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	const envelope = body as
		| {
				success?: boolean;
				errors?: Array<{ code?: number; message?: string }>;
				result?: unknown;
		  }
		| undefined;
	const firstError = envelope?.errors?.[0];
	const detail = firstError
		? `${firstError.code ?? "unknown"}: ${firstError.message ?? ""}`
		: undefined;
	if (response.ok && envelope?.success !== false) {
		return { status: "ok", result: envelope?.result };
	}
	if (response.status === 401 || response.status === 403) {
		return { status: "forbidden", httpStatus: response.status, detail };
	}
	if (response.status === 404 || response.status === 405) {
		return { status: "unavailable", httpStatus: response.status, detail };
	}
	return { status: "error", httpStatus: response.status, detail };
}

function resolvedValue(coordinate: {
	state: "resolved" | "unresolved";
	value?: string;
	key?: string;
}): string | undefined {
	return coordinate.state === "resolved" ? coordinate.value : undefined;
}

function resourceAccounts(
	manifest: InstallationManifest,
	resource: CloudflareResource,
): string[] {
	if ("account" in resource) return [resource.account];
	const binding = new Set<string>();
	for (const worker of manifest.workers) {
		if (worker.bindings.some((entry) => entry.resource === resource.id)) {
			binding.add(worker.account);
		}
	}
	return binding.size > 0
		? [...binding].sort()
		: [manifest.cloudflare.primaryAccount];
}

interface AccountKindDemand {
	account: string;
	kind: ResourceKind;
	requirement: Requirement;
}

function accountKindDemands(
	manifest: InstallationManifest,
): AccountKindDemand[] {
	const demands = new Map<string, AccountKindDemand>();
	for (const resource of manifest.resources) {
		for (const account of resourceAccounts(manifest, resource)) {
			const key = `${account}\0${resource.kind}`;
			const existing = demands.get(key);
			if (existing?.requirement === "required") continue;
			demands.set(key, {
				account,
				kind: resource.kind,
				requirement: resource.requirement,
			});
		}
	}
	return [...demands.values()].sort((left, right) =>
		`${left.account}\0${left.kind}`.localeCompare(
			`${right.account}\0${right.kind}`,
		),
	);
}

function checkSortKey(check: PreflightCheck): string {
	return check.id;
}

function resultCount(result: unknown): number | undefined {
	if (Array.isArray(result)) return result.length;
	if (result && typeof result === "object") {
		const objectResult = result as Record<string, unknown>;
		for (const field of ["items", "buckets"]) {
			const value = objectResult[field];
			if (Array.isArray(value)) {
				return value.length;
			}
		}
	}
	return undefined;
}

interface FreshnessDemand {
	account: string;
	kinds: ResourceKind[];
	path: string;
	label: string;
}

function freshAccountDemands(
	manifest: InstallationManifest,
): FreshnessDemand[] {
	const demands = new Map<string, FreshnessDemand>();
	const freshAccounts = new Set(
		manifest.cloudflare.accounts
			.filter((account) => account.freshAccount)
			.map((account) => account.key),
	);
	for (const account of freshAccounts) {
		demands.set(`${account}\0/workers/scripts?per_page=1`, {
			account,
			kinds: [],
			path: "/workers/scripts?per_page=1",
			label: "Worker scripts",
		});
	}
	for (const resource of manifest.resources) {
		const path = FRESH_RESOURCE_PROBE_PATHS[resource.kind];
		if (!path) continue;
		for (const account of resourceAccounts(manifest, resource)) {
			if (!freshAccounts.has(account)) continue;
			const key = `${account}\0${path}`;
			const existing = demands.get(key);
			if (existing) {
				if (!existing.kinds.includes(resource.kind)) {
					existing.kinds.push(resource.kind);
					existing.kinds.sort();
				}
				continue;
			}
			demands.set(key, {
				account,
				kinds: [resource.kind],
				path,
				label: resource.kind,
			});
		}
	}
	return [...demands.values()].sort((left, right) =>
		`${left.account}\0${left.path}`.localeCompare(
			`${right.account}\0${right.path}`,
		),
	);
}

/**
 * Verify — with read-only requests only — that every Cloudflare account the
 * manifest names is reachable with the given token and exposes every product
 * capability the declared resources need, and that every declared zone exists
 * and matches its hostname and account. Never mutates anything: this is the
 * `execution.preflight: "fail-before-mutation"` gate, and callers must not
 * provision when `mutationAllowed` is false.
 */
export async function preflightCloudflareAccount(
	options: PreflightOptions,
): Promise<PreflightReport> {
	const manifest = parseInstallationManifest(options.manifest);
	const apiBaseUrl = options.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL;
	const fetchImplementation =
		options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
	const checks: PreflightCheck[] = [];

	const accountIds = new Map<string, string>();
	for (const account of manifest.cloudflare.accounts) {
		const accountId = resolvedValue(account.accountId);
		if (!accountId) {
			checks.push({
				id: `account:${account.key}`,
				account: account.key,
				kinds: [],
				requirement: "required",
				status: "unresolved",
				detail: "account id coordinate is unresolved",
			});
			continue;
		}
		accountIds.set(account.key, accountId);
		const { result: _accountResult, ...outcome } = await probe(
			`${apiBaseUrl}/accounts/${accountId}`,
			options.apiToken,
			fetchImplementation,
		);
		checks.push({
			id: `account:${account.key}`,
			account: account.key,
			kinds: [],
			requirement: "required",
			path: `/accounts/${accountId}`,
			...outcome,
		});
	}

	for (const demand of accountKindDemands(manifest)) {
		const accountId = accountIds.get(demand.account);
		if (!accountId) {
			checks.push({
				id: `capability:${demand.account}:${demand.kind}`,
				account: demand.account,
				kinds: [demand.kind],
				requirement: demand.requirement,
				status: "unresolved",
				detail: "account id coordinate is unresolved",
			});
			continue;
		}
		const path = CAPABILITY_PROBE_PATHS[demand.kind];
		const { result: _capabilityResult, ...outcome } = await probe(
			`${apiBaseUrl}/accounts/${accountId}${path}`,
			options.apiToken,
			fetchImplementation,
		);
		checks.push({
			id: `capability:${demand.account}:${demand.kind}`,
			account: demand.account,
			kinds: [demand.kind],
			requirement: demand.requirement,
			path,
			...outcome,
		});
	}

	for (const demand of freshAccountDemands(manifest)) {
		const accountId = accountIds.get(demand.account);
		if (!accountId) continue;
		let outcome = await probe(
			`${apiBaseUrl}/accounts/${accountId}${demand.path}`,
			options.apiToken,
			fetchImplementation,
		);
		if (outcome.status === "ok") {
			const count = resultCount(outcome.result);
			if (count === undefined) {
				outcome = {
					status: "error",
					detail: `could not determine ${demand.label} inventory from Cloudflare response`,
				};
			} else if (count > 0) {
				outcome = {
					status: "error",
					detail: `fresh-account certification requires no existing ${demand.label}; found at least ${count}`,
				};
			}
		}
		const { result: _freshnessResult, ...checkOutcome } = outcome;
		const inventoryId =
			demand.path.split("?")[0]?.split("/").filter(Boolean).join("-") ??
			"inventory";
		checks.push({
			id: `freshness:${demand.account}:${inventoryId}`,
			account: demand.account,
			kinds: demand.kinds,
			requirement: "required",
			path: demand.path,
			...checkOutcome,
		});
	}

	for (const domain of manifest.cloudflare.domains) {
		const zoneId = resolvedValue(domain.zoneId);
		if (!zoneId) {
			checks.push({
				id: `zone:${domain.key}`,
				account: domain.account,
				kinds: [],
				requirement: "required",
				status: "unresolved",
				detail: "zone id coordinate is unresolved",
			});
			continue;
		}
		let outcome = await probe(
			`${apiBaseUrl}/zones/${zoneId}`,
			options.apiToken,
			fetchImplementation,
		);
		if (outcome.status === "ok") {
			const zone = outcome.result as
				| { name?: string; account?: { id?: string } }
				| undefined;
			const expectedAccountId = accountIds.get(domain.account);
			if (
				zone?.name &&
				domain.hostname !== zone.name &&
				!domain.hostname.endsWith(`.${zone.name}`)
			) {
				outcome = {
					status: "error",
					detail: `hostname ${domain.hostname} is not inside zone ${zone.name}`,
				};
			} else if (
				zone?.account?.id &&
				expectedAccountId &&
				zone.account.id !== expectedAccountId
			) {
				outcome = {
					status: "error",
					detail: `zone belongs to account ${zone.account.id}, expected ${expectedAccountId}`,
				};
			}
		}
		const { result: _zoneResult, ...checkOutcome } = outcome;
		checks.push({
			id: `zone:${domain.key}`,
			account: domain.account,
			kinds: [],
			requirement: "required",
			path: `/zones/${zoneId}`,
			...checkOutcome,
		});
	}

	checks.sort((left, right) =>
		checkSortKey(left).localeCompare(checkSortKey(right)),
	);
	const ok = checks.every(
		(check) => check.status === "ok" || check.requirement === "optional",
	);
	return { ok, mutationAllowed: ok, checks };
}

export function renderPreflightReport(report: PreflightReport): string {
	const lines = report.checks.map((check) => {
		const status = check.status.toUpperCase().padEnd(11);
		const requirement = check.requirement === "optional" ? " (optional)" : "";
		const detail = check.detail ? ` — ${check.detail}` : "";
		return `${status}${check.id}${requirement}${detail}`;
	});
	lines.push(
		report.ok
			? "PASS: every required capability is available; mutation is allowed"
			: "FAIL: required capabilities are missing; refusing before mutation",
	);
	return `${lines.join("\n")}\n`;
}
