import {
	CLOUDFLARE_API_BASE_URL,
	type PreflightReport,
	preflightCloudflareAccount,
} from "./preflight";
import {
	type DescopeIdentityReadinessOptions,
	type IdentityReadinessReport,
	preflightDescopeIdentity,
	requiresInteractiveIdentityPreflight,
} from "./identity-readiness";
import {
	type CloudflareResource,
	type Coordinate,
	type InstallationManifest,
	parseInstallationManifest,
} from "./schema";

type ResourceKind = CloudflareResource["kind"];

export type ProvisionAction =
	| "created"
	| "adopted"
	| "planned-create"
	| "deploy-owned"
	| "capability"
	| "operator-required"
	| "failed";

export interface ProvisionEntry {
	id: string;
	kind: ResourceKind;
	requirement: "required" | "optional";
	action: ProvisionAction;
	/** Resource name or identifier the action addressed. */
	subject?: string;
	detail?: string;
	/** Unresolved-coordinate keys this action resolved, with their values. */
	resolved?: Array<{ key: string; value: string }>;
}

export interface ProvisionReport {
	ok: boolean;
	mode: ProvisionMode;
	preflight: PreflightReport;
	identity?: IdentityReadinessReport;
	entries: ProvisionEntry[];
	/** All coordinate resolutions from this run, keyed by coordinate key. */
	resolvedCoordinates: Record<string, string>;
}

export type ProvisionMode = "plan" | "apply";

export interface ProvisionOptions {
	manifest: unknown;
	apiToken: string;
	/**
	 * "plan" (default) stays strictly read-only: existence checks plus the
	 * actions an apply run would take. "apply" creates missing resources.
	 */
	mode?: ProvisionMode;
	apiBaseUrl?: string;
	fetchImplementation?: typeof fetch;
	/**
	 * Credentials for the manifest-owned identity target. The read-only provider
	 * check completes before any Cloudflare request during interactive apply.
	 */
	identity?: Pick<
		DescopeIdentityReadinessOptions,
		"managementKey" | "fetchImplementation"
	>;
}

export class ProvisioningRefusedError extends Error {
	readonly preflight: PreflightReport;

	constructor(preflight: PreflightReport) {
		super(
			"Refusing to provision: the account capability preflight failed and the manifest execution policy is fail-before-mutation",
		);
		this.name = "ProvisioningRefusedError";
		this.preflight = preflight;
	}
}

export class IdentityReadinessRefusedError extends Error {
	readonly report?: IdentityReadinessReport;

	constructor(report?: IdentityReadinessReport) {
		super(
			report
				? "Refusing to provision: the identity-provider readiness preflight failed"
				: "Refusing to provision: Descope readiness inputs are required for interactive surfaces",
		);
		this.name = "IdentityReadinessRefusedError";
		this.report = report;
	}
}

/**
 * How each manifest resource kind materializes. Every schema kind MUST be
 * listed — the Record fails compilation when a kind is added without deciding
 * its provisioning path, mirroring the preflight's fail-closed ratchet.
 *
 * - "api": creatable/adoptable through the Cloudflare REST API here
 * - "deploy-owned": materialized by deploying the Workers that declare it
 *   (Durable Object namespaces, Workflows, services, assets, containers)
 * - "capability": account-level product with no per-resource creation;
 *   availability is already proven by the preflight
 * - "operator-required": creation needs operator-held secrets (Hyperdrive
 *   origin credentials), so the provisioner only verifies presence
 */
const PROVISIONING_PATHS: Record<
	ResourceKind,
	"api" | "deploy-owned" | "capability" | "operator-required"
> = {
	ai: "capability",
	assets: "deploy-owned",
	browser: "capability",
	container: "deploy-owned",
	d1: "api",
	"durable-object": "deploy-owned",
	hyperdrive: "operator-required",
	kv: "api",
	queue: "api",
	r2: "api",
	service: "deploy-owned",
	vectorize: "api",
	workflow: "deploy-owned",
};

interface ApiResult {
	ok: boolean;
	status: number;
	result?: unknown;
	detail?: string;
}

interface ApiClient {
	get(path: string): Promise<ApiResult>;
	post(path: string, body: unknown): Promise<ApiResult>;
}

function createApiClient(
	accountBase: string,
	apiToken: string,
	fetchImplementation: typeof fetch,
): ApiClient {
	const request = async (
		method: "GET" | "POST",
		path: string,
		body?: unknown,
	): Promise<ApiResult> => {
		let response: Response;
		try {
			response = await fetchImplementation(`${accountBase}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${apiToken}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		let envelope:
			| {
					success?: boolean;
					result?: unknown;
					errors?: Array<{ code?: number; message?: string }>;
			  }
			| undefined;
		try {
			envelope = (await response.json()) as typeof envelope;
		} catch {
			envelope = undefined;
		}
		const firstError = envelope?.errors?.[0];
		return {
			ok: response.ok && envelope?.success !== false,
			status: response.status,
			result: envelope?.result,
			detail: firstError
				? `${firstError.code ?? "unknown"}: ${firstError.message ?? ""}`
				: undefined,
		};
	};
	return {
		get: (path) => request("GET", path),
		post: (path, body) => request("POST", path, body),
	};
}

function coordinateValue(coordinate: Coordinate): string | undefined {
	return coordinate.state === "resolved" ? coordinate.value : undefined;
}

function coordinateKey(coordinate: Coordinate): string | undefined {
	return coordinate.state === "unresolved" ? coordinate.key : undefined;
}

/** Deterministic name for a create-provisioned resource without a resolved one. */
function derivedName(
	manifest: InstallationManifest,
	resource: CloudflareResource,
): string {
	return `${manifest.organization.key}-${resource.id}`;
}

interface ApiKindPlan {
	/** Name (or id for adopt-by-id kinds) addressed on the account. */
	subject: string;
	exists: (api: ApiClient) => Promise<ApiResult & { foundId?: string }>;
	create: (api: ApiClient) => Promise<ApiResult & { createdId?: string }>;
	/** Coordinate resolutions once the resource id/name is known. */
	resolutions: (
		materializedId: string,
	) => Array<{ key: string; value: string }>;
}

function apiKindPlan(
	manifest: InstallationManifest,
	resource: CloudflareResource,
): ApiKindPlan {
	switch (resource.kind) {
		case "d1": {
			const name = resource.databaseName;
			const idKey = coordinateKey(resource.databaseId);
			return {
				subject: name,
				exists: async (api) => {
					const listed = await api.get(
						`/d1/database?name=${encodeURIComponent(name)}`,
					);
					const match = Array.isArray(listed.result)
						? (listed.result as Array<{ name?: string; uuid?: string }>).find(
								(row) => row.name === name,
							)
						: undefined;
					return { ...listed, foundId: match?.uuid };
				},
				create: async (api) => {
					const created = await api.post("/d1/database", { name });
					const row = created.result as { uuid?: string } | undefined;
					return { ...created, createdId: row?.uuid };
				},
				resolutions: (id) => (idKey ? [{ key: idKey, value: id }] : []),
			};
		}
		case "r2": {
			const name =
				coordinateValue(resource.bucketName) ?? derivedName(manifest, resource);
			const nameKey = coordinateKey(resource.bucketName);
			return {
				subject: name,
				exists: async (api) => {
					const got = await api.get(`/r2/buckets/${encodeURIComponent(name)}`);
					return { ...got, foundId: got.ok ? name : undefined };
				},
				create: async (api) => {
					const created = await api.post("/r2/buckets", { name });
					return { ...created, createdId: created.ok ? name : undefined };
				},
				resolutions: (id) => (nameKey ? [{ key: nameKey, value: id }] : []),
			};
		}
		case "kv": {
			const title = derivedName(manifest, resource);
			const resolvedId = coordinateValue(resource.namespaceId);
			const idKey = coordinateKey(resource.namespaceId);
			return {
				subject: resolvedId ?? title,
				exists: async (api) => {
					if (resolvedId) {
						const got = await api.get(
							`/storage/kv/namespaces/${encodeURIComponent(resolvedId)}`,
						);
						return { ...got, foundId: got.ok ? resolvedId : undefined };
					}
					const listed = await api.get("/storage/kv/namespaces?per_page=100");
					const match = Array.isArray(listed.result)
						? (listed.result as Array<{ id?: string; title?: string }>).find(
								(row) => row.title === title,
							)
						: undefined;
					return { ...listed, foundId: match?.id };
				},
				create: async (api) => {
					const created = await api.post("/storage/kv/namespaces", { title });
					const row = created.result as { id?: string } | undefined;
					return { ...created, createdId: row?.id };
				},
				resolutions: (id) => (idKey ? [{ key: idKey, value: id }] : []),
			};
		}
		case "queue": {
			const name =
				coordinateValue(resource.queueName) ?? derivedName(manifest, resource);
			const nameKey = coordinateKey(resource.queueName);
			return {
				subject: name,
				exists: async (api) => {
					const listed = await api.get("/queues?per_page=100");
					const match = Array.isArray(listed.result)
						? (listed.result as Array<{ queue_name?: string }>).find(
								(row) => row.queue_name === name,
							)
						: undefined;
					return { ...listed, foundId: match ? name : undefined };
				},
				create: async (api) => {
					const created = await api.post("/queues", { queue_name: name });
					return { ...created, createdId: created.ok ? name : undefined };
				},
				resolutions: (id) => (nameKey ? [{ key: nameKey, value: id }] : []),
			};
		}
		case "vectorize": {
			const name =
				coordinateValue(resource.indexName) ?? derivedName(manifest, resource);
			const nameKey = coordinateKey(resource.indexName);
			return {
				subject: name,
				exists: async (api) => {
					const got = await api.get(
						`/vectorize/v2/indexes/${encodeURIComponent(name)}`,
					);
					return { ...got, foundId: got.ok ? name : undefined };
				},
				create: async (api) => {
					const created = await api.post("/vectorize/v2/indexes", {
						name,
						config: {
							dimensions: resource.dimensions,
							metric: resource.metric,
						},
					});
					return { ...created, createdId: created.ok ? name : undefined };
				},
				resolutions: (id) => (nameKey ? [{ key: nameKey, value: id }] : []),
			};
		}
		default:
			throw new Error(`resource kind ${resource.kind} has no API plan`);
	}
}

function resourceAccountKey(
	manifest: InstallationManifest,
	resource: CloudflareResource,
): string {
	if ("account" in resource) return resource.account;
	for (const worker of manifest.workers) {
		if (worker.bindings.some((entry) => entry.resource === resource.id)) {
			return worker.account;
		}
	}
	return manifest.cloudflare.primaryAccount;
}

function installationIdentityTarget(
	manifest: InstallationManifest,
): Pick<DescopeIdentityReadinessOptions, "projectId" | "osUrl" | "baseUrl"> {
	const workerIds = new Set(
		manifest.surfaces
			.filter((surface) => surface.kind === "os")
			.map((surface) => surface.worker),
	);
	if (workerIds.size !== 1) {
		throw new Error(
			"Refusing to provision: identity preflight requires exactly one OS worker",
		);
	}
	const worker = manifest.workers.find((entry) => workerIds.has(entry.id));
	if (!worker) throw new Error("Refusing to provision: OS worker is missing");
	const vars = worker.vars;
	function configuration(name: string): string {
		const value = vars[name];
		if (typeof value !== "string" || !value || /\s/.test(value)) {
			throw new Error(
				`Refusing to provision: OS worker vars.${name} must be a nonempty string without whitespace`,
			);
		}
		return value;
	}
	function origin(name: string): string {
		const value = configuration(name);
		try {
			const url = new URL(value);
			if (url.protocol === "https:" && !url.port && value === url.origin)
				return value;
		} catch {
			// Never include a malformed configuration value in diagnostics.
		}
		throw new Error(
			`Refusing to provision: OS worker vars.${name} must be a canonical HTTPS origin without a port, credentials, path, query or fragment`,
		);
	}
	const osUrl = origin("OS_URL");
	const brokerUrl = origin("SESSION_BROKER_URL");
	const descopeBaseUrl = origin("DESCOPE_BASE_URL");
	if (
		(osUrl === "https://os.tedix.dev") !==
		(brokerUrl === "https://auth.tedix.dev")
	) {
		throw new Error(
			"Refusing to provision: an installation cannot mix managed Tedix origins",
		);
	}
	if (brokerUrl === osUrl || brokerUrl !== descopeBaseUrl) {
		throw new Error(
			"Refusing to provision: OS worker broker and Descope must share one auth host distinct from OS",
		);
	}
	const brokerWorkers = manifest.workers.filter(
		(entry) => entry.sourceConfig === "apps/session-broker/wrangler.jsonc",
	);
	if (brokerWorkers.length !== 1) {
		throw new Error(
			"Refusing to provision: interactive OS requires exactly one session-broker Worker",
		);
	}
	const brokerVars = brokerWorkers[0]!.vars;
	for (const [name, expected] of Object.entries({
		OS_URL: osUrl,
		SESSION_BROKER_URL: brokerUrl,
		DESCOPE_BASE_URL: descopeBaseUrl,
		DESCOPE_PROJECT_ID: configuration("DESCOPE_PROJECT_ID"),
	})) {
		if (brokerVars[name] !== expected) {
			throw new Error(
				`Refusing to provision: session-broker Worker vars.${name} must equal OS worker vars.${name}`,
			);
		}
	}
	return {
		projectId: configuration("DESCOPE_PROJECT_ID"),
		osUrl,
		baseUrl: descopeBaseUrl,
	};
}

/**
 * Materialize the manifest's account-level Cloudflare resources.
 *
 * Runs the applicable read-only identity and capability preflights before
 * mutation — the `execution.preflight: "fail-before-mutation"` contract.
 * "plan" mode never issues a write; "apply" creates missing API-creatable
 * resources idempotently (existing resources are adopted, never recreated).
 * Deploy-owned kinds (Durable Objects, Workflows, services, assets,
 * containers) are reported but deliberately untouched: deploying the Workers
 * that declare them is their provisioning path. Hyperdrive needs operator-held
 * origin credentials, so it is verified when resolved and reported as
 * operator-required otherwise.
 */
export async function provisionCloudflareResources(
	options: ProvisionOptions,
): Promise<ProvisionReport> {
	const manifest = parseInstallationManifest(options.manifest);
	const mode = options.mode ?? "plan";
	const apiBaseUrl = options.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL;
	const fetchImplementation =
		options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
	let identity: IdentityReadinessReport | undefined;
	if (mode === "apply" && requiresInteractiveIdentityPreflight(manifest)) {
		if (!options.identity) throw new IdentityReadinessRefusedError();
		identity = await preflightDescopeIdentity({
			...installationIdentityTarget(manifest),
			managementKey: options.identity.managementKey,
			fetchImplementation: options.identity.fetchImplementation,
		});
		if (!identity.ok) throw new IdentityReadinessRefusedError(identity);
	}

	const preflight = await preflightCloudflareAccount({
		manifest: options.manifest,
		apiToken: options.apiToken,
		apiBaseUrl,
		fetchImplementation,
	});
	if (!preflight.ok) throw new ProvisioningRefusedError(preflight);

	const accountIds = new Map<string, string>();
	for (const account of manifest.cloudflare.accounts) {
		const value = coordinateValue(account.accountId);
		if (value) accountIds.set(account.key, value);
	}

	const entries: ProvisionEntry[] = [];
	const resolvedCoordinates: Record<string, string> = {};

	for (const resource of manifest.resources) {
		const path = PROVISIONING_PATHS[resource.kind];
		const base = {
			id: resource.id,
			kind: resource.kind,
			requirement: resource.requirement,
		};
		if (path === "deploy-owned") {
			entries.push({
				...base,
				action: "deploy-owned",
				detail: "materialized by deploying the declaring Worker",
			});
			continue;
		}
		if (path === "capability") {
			entries.push({
				...base,
				action: "capability",
				detail: "account-level product; availability proven by preflight",
			});
			continue;
		}
		if (path === "operator-required") {
			entries.push({
				...base,
				action: "operator-required",
				detail:
					"creation requires operator-held origin credentials; supply a resolved configuration id",
			});
			continue;
		}

		const accountKey = resourceAccountKey(manifest, resource);
		const accountId = accountIds.get(accountKey);
		if (!accountId) {
			entries.push({
				...base,
				action: "failed",
				detail: `account ${accountKey} has no resolved account id`,
			});
			continue;
		}
		const api = createApiClient(
			`${apiBaseUrl}/accounts/${accountId}`,
			options.apiToken,
			fetchImplementation,
		);
		const plan = apiKindPlan(manifest, resource);
		const existing = await plan.exists(api);
		if (existing.foundId) {
			const resolved = plan.resolutions(existing.foundId);
			for (const entry of resolved) {
				resolvedCoordinates[entry.key] = entry.value;
			}
			entries.push({
				...base,
				action: "adopted",
				subject: plan.subject,
				...(resolved.length > 0 ? { resolved } : {}),
			});
			continue;
		}
		if (resource.provisioning === "adopt") {
			entries.push({
				...base,
				action: "failed",
				subject: plan.subject,
				detail: existing.detail ?? "adopt-provisioned resource was not found",
			});
			continue;
		}
		if (mode === "plan") {
			entries.push({
				...base,
				action: "planned-create",
				subject: plan.subject,
			});
			continue;
		}
		const created = await plan.create(api);
		if (!created.ok || !created.createdId) {
			entries.push({
				...base,
				action: "failed",
				subject: plan.subject,
				detail: created.detail ?? `create failed with status ${created.status}`,
			});
			continue;
		}
		const resolved = plan.resolutions(created.createdId);
		for (const entry of resolved) {
			resolvedCoordinates[entry.key] = entry.value;
		}
		entries.push({
			...base,
			action: "created",
			subject: plan.subject,
			...(resolved.length > 0 ? { resolved } : {}),
		});
	}

	entries.sort((left, right) => left.id.localeCompare(right.id));
	// A failed optional resource degrades the installation, it does not block.
	const ok = entries.every(
		(entry) => entry.action !== "failed" || entry.requirement === "optional",
	);
	return {
		ok,
		mode,
		preflight,
		...(identity ? { identity } : {}),
		entries,
		resolvedCoordinates,
	};
}

/**
 * Execute SQL statements against a provisioned D1 database through the REST
 * API, in order, stopping at the first failure. This is the sanctioned
 * bootstrap path for migrations and sanitized seed data: the SQL itself comes
 * from the caller (the tracked migration files and a sanitized seed), never
 * from this package, so no tenant data can ship inside the provisioner.
 */
export async function executeD1Statements(options: {
	accountId: string;
	databaseId: string;
	statements: string[];
	apiToken: string;
	apiBaseUrl?: string;
	fetchImplementation?: typeof fetch;
}): Promise<{ ok: boolean; executed: number; detail?: string }> {
	const apiBaseUrl = options.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL;
	const fetchImplementation =
		options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
	const api = createApiClient(
		`${apiBaseUrl}/accounts/${options.accountId}`,
		options.apiToken,
		fetchImplementation,
	);
	let executed = 0;
	for (const sql of options.statements) {
		const result = await api.post(
			`/d1/database/${encodeURIComponent(options.databaseId)}/query`,
			{ sql },
		);
		if (!result.ok) {
			return {
				ok: false,
				executed,
				detail:
					result.detail ?? `statement failed with status ${result.status}`,
			};
		}
		executed++;
	}
	return { ok: true, executed };
}

/**
 * The sanitized bootstrap plan derived from the manifest: which seed profile
 * to load, the operator/generated inputs (already secret-free by schema), and
 * the D1 resources bootstrap SQL must target. Callers pair this with their
 * tracked migration files and a seed matching `seed`.
 */
export function bootstrapPlan(manifestInput: unknown): {
	seed: InstallationManifest["bootstrap"]["seed"];
	inputs: InstallationManifest["bootstrap"]["inputs"];
	databaseResourceIds: string[];
} {
	const manifest = parseInstallationManifest(manifestInput);
	return {
		seed: manifest.bootstrap.seed,
		inputs: manifest.bootstrap.inputs,
		databaseResourceIds: manifest.resources
			.filter((resource) => resource.kind === "d1")
			.map((resource) => resource.id)
			.sort(),
	};
}

export function renderProvisionReport(report: ProvisionReport): string {
	const lines = report.entries.map((entry) => {
		const action = entry.action.toUpperCase().padEnd(18);
		const subject = entry.subject ? ` ${entry.subject}` : "";
		const requirement = entry.requirement === "optional" ? " (optional)" : "";
		const detail = entry.detail ? ` — ${entry.detail}` : "";
		return `${action}${entry.id} [${entry.kind}]${subject}${requirement}${detail}`;
	});
	lines.push(
		report.ok
			? `PASS (${report.mode}): all required resources are materialized or planned`
			: `FAIL (${report.mode}): required resources failed to materialize`,
	);
	return `${lines.join("\n")}\n`;
}
