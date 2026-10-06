import { parse, type ParseError } from "jsonc-parser";
import {
	certifyInstallationManifest,
	parseInstallationManifest,
	type CloudflareResource,
	type Coordinate,
	type InstallationManifest,
	type InstallationWorker,
} from "./schema";

type JsonPrimitive = boolean | null | number | string;
export type WranglerJsonValue =
	| JsonPrimitive
	| WranglerJsonValue[]
	| { [key: string]: WranglerJsonValue };
export type WranglerConfig = Record<string, WranglerJsonValue>;

export type WranglerOverlayMode = "deploy" | "preview";

export interface WranglerOverlayOptions {
	manifest: unknown;
	mode?: WranglerOverlayMode;
	sourceConfig: string;
	workerId: string;
}

export interface WranglerOverlayResult {
	config: WranglerConfig;
	requiredSecrets: string[];
	text: string;
}

function renderJson(
	value: WranglerJsonValue,
	depth = 0,
	prefixWidth = 0,
): string[] {
	if (value === null || typeof value !== "object")
		return [JSON.stringify(value)];
	if (Array.isArray(value)) {
		if (value.every((entry) => entry === null || typeof entry !== "object")) {
			// oxfmt separates inline array elements with ", "; the tracked
			// artifact must satisfy the byte-equality test AND format:check.
			const inline = `[${value.map((entry) => JSON.stringify(entry)).join(", ")}]`;
			if (prefixWidth + inline.length <= 80) return [inline];
		}
		const lines = ["["];
		for (const [index, entry] of value.entries()) {
			const rendered = renderJson(entry, depth + 1);
			lines.push(
				`${"\t".repeat(depth + 1)}${rendered[0]}`,
				...rendered.slice(1),
			);
			if (index < value.length - 1) lines[lines.length - 1] += ",";
		}
		lines.push(`${"\t".repeat(depth)}]`);
		return lines;
	}

	const entries = Object.entries(value);
	const lines = ["{"];
	for (const [index, [key, nested]] of entries.entries()) {
		const prefix = `${"\t".repeat(depth + 1)}${JSON.stringify(key)}: `;
		const rendered = renderJson(nested, depth + 1, prefix.length);
		lines.push(`${prefix}${rendered[0]}`, ...rendered.slice(1));
		if (index < entries.length - 1) lines[lines.length - 1] += ",";
	}
	lines.push(`${"\t".repeat(depth)}}`);
	return lines;
}

function renderJsonDocument(value: WranglerJsonValue): string {
	return `${renderJson(value).join("\n")}\n`;
}

export function renderWranglerSecretNames(
	workerId: string,
	requiredSecrets: string[],
): string {
	return renderJsonDocument({
		requiredSecrets: [...requiredSecrets].sort(),
		workerId,
	});
}

export class WranglerOverlayError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "WranglerOverlayError";
		this.code = code;
	}
}

// Script-scoped, coordinate-free features (`ratelimits`, `version_metadata`,
// `worker_loaders`) deliberately pass through from the authored source: they
// carry no account or resource identifiers, and stripping them breaks
// fail-closed runtime paths (rate limiting 503s every request without its
// binding; skill workflows cannot load their Dynamic Worker without LOADER).
const STRIPPED_SOURCE_KEYS = new Set([
	"account_id",
	"agent_memory",
	"ai",
	"ai_search",
	"ai_search_namespaces",
	"analytics_engine_datasets",
	"artifacts",
	"assets",
	"browser",
	"containers",
	"d1_databases",
	"data_blobs",
	"dispatch_namespaces",
	"durable_objects",
	"env",
	"flagship",
	"hyperdrive",
	"images",
	"kv_namespaces",
	"logfwdr",
	"media",
	"mtls_certificates",
	"name",
	"pipelines",
	"queues",
	"r2_buckets",
	"routes",
	"secrets",
	"secrets_store_secrets",
	"send_email",
	"services",
	"stream",
	"tail_consumers",
	"text_blobs",
	"unsafe",
	"vars",
	"vectorize",
	"wasm_modules",
	"websearch",
	"workflows",
	"workers_dev",
]);
const SECRET_LIKE_KEY =
	/(?:^|_)(?:API_KEY|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/i;
const PASS_REFERENCE_PREFIX = ["pass:", "//"].join("");
const MANAGED_STRIPE_SECRETS = [
	"STRIPE_SECRET_KEY",
	"STRIPE_TEST_SECRET_KEY",
	"STRIPE_WEBHOOK_SECRET",
	"STRIPE_TEST_WEBHOOK_SECRET",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSourceConfig(source: string): WranglerConfig {
	const errors: ParseError[] = [];
	const parsed = parse(source, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	if (errors.length > 0 || !isObject(parsed)) {
		throw new WranglerOverlayError(
			"source.invalid-jsonc",
			`Authored Wrangler source is not valid JSONC (error ${errors[0]?.error ?? "unknown"})`,
		);
	}
	return parsed as WranglerConfig;
}

function resolveCoordinate(coordinate: Coordinate, label: string): string {
	if (coordinate.state === "unresolved") {
		throw new WranglerOverlayError(
			"coordinate.unresolved",
			`${label} is unresolved (${coordinate.key}): ${coordinate.reason}`,
		);
	}
	return coordinate.value;
}

function rejectUnresolved(value: unknown, path = "manifest"): void {
	if (Array.isArray(value)) {
		for (const [index, nested] of value.entries()) {
			rejectUnresolved(nested, `${path}[${index}]`);
		}
		return;
	}
	if (!isObject(value)) return;
	if (value.state === "unresolved") {
		throw new WranglerOverlayError(
			"coordinate.unresolved",
			`${path} is unresolved (${String(value.key)})`,
		);
	}
	for (const [key, nested] of Object.entries(value)) {
		rejectUnresolved(nested, `${path}.${key}`);
	}
}

function validatedManifest(
	input: unknown,
	mode: WranglerOverlayMode,
): InstallationManifest {
	if (mode === "preview") {
		const manifest = parseInstallationManifest(input);
		rejectUnresolved(manifest);
		return manifest;
	}
	const certification = certifyInstallationManifest(input);
	if (!certification.success || !certification.manifest) {
		throw new WranglerOverlayError(
			"certification.invalid",
			`Deploy overlay requires a valid manifest: ${certification.issues.map((issue) => issue.code).join(", ")}`,
		);
	}
	if (
		!certification.certified ||
		(certification.manifest.certification.level !== "installation-ready" &&
			certification.manifest.certification.level !== "operational")
	) {
		throw new WranglerOverlayError(
			"certification.required",
			"Deploy overlay requires certified installation-ready or operational status",
		);
	}
	rejectUnresolved(certification.manifest);
	return certification.manifest;
}

function copyAuthoredRuntime(source: WranglerConfig): WranglerConfig {
	const runtime: WranglerConfig = {};
	for (const [key, value] of Object.entries(source)) {
		if (STRIPPED_SOURCE_KEYS.has(key) || key === "compatibility_date") continue;
		runtime[key] = structuredClone(value);
	}
	return runtime;
}

function resourceMap(
	manifest: InstallationManifest,
): Map<string, CloudflareResource> {
	return new Map(manifest.resources.map((resource) => [resource.id, resource]));
}

function resourceFor<K extends CloudflareResource["kind"]>(
	resources: Map<string, CloudflareResource>,
	id: string,
	kind: K,
): Extract<CloudflareResource, { kind: K }> {
	const resource = resources.get(id);
	if (!resource || resource.kind !== kind) {
		throw new WranglerOverlayError(
			"binding.resource-invalid",
			`Binding resource ${id} is not a declared ${kind} resource`,
		);
	}
	return resource as Extract<CloudflareResource, { kind: K }>;
}

function applyBindings(
	config: WranglerConfig,
	manifest: InstallationManifest,
	worker: InstallationWorker,
	workerScriptName: string,
): void {
	const resources = resourceMap(manifest);
	const arrays = {
		containers: [] as WranglerJsonValue[],
		d1_databases: [] as WranglerJsonValue[],
		hyperdrive: [] as WranglerJsonValue[],
		kv_namespaces: [] as WranglerJsonValue[],
		r2_buckets: [] as WranglerJsonValue[],
		services: [] as WranglerJsonValue[],
		vectorize: [] as WranglerJsonValue[],
		workflows: [] as WranglerJsonValue[],
	};
	const durableObjects: WranglerJsonValue[] = [];
	const queueConsumers: WranglerJsonValue[] = [];
	const queueProducers: WranglerJsonValue[] = [];

	for (const binding of [...worker.bindings].sort((left, right) =>
		`${left.kind}\0${left.name}\0${left.resource}`.localeCompare(
			`${right.kind}\0${right.name}\0${right.resource}`,
		),
	)) {
		switch (binding.kind) {
			case "d1": {
				const resource = resourceFor(resources, binding.resource, "d1");
				arrays.d1_databases.push({
					binding: binding.name,
					database_id: resolveCoordinate(resource.databaseId, resource.id),
					database_name: resource.databaseName,
				});
				break;
			}
			case "r2": {
				const resource = resourceFor(resources, binding.resource, "r2");
				arrays.r2_buckets.push({
					binding: binding.name,
					bucket_name: resolveCoordinate(resource.bucketName, resource.id),
				});
				break;
			}
			case "kv": {
				const resource = resourceFor(resources, binding.resource, "kv");
				arrays.kv_namespaces.push({
					binding: binding.name,
					id: resolveCoordinate(resource.namespaceId, resource.id),
				});
				break;
			}
			case "durable-object": {
				const resource = resourceFor(
					resources,
					binding.resource,
					"durable-object",
				);
				const scriptName = resolveCoordinate(resource.scriptName, resource.id);
				durableObjects.push({
					name: binding.name,
					class_name: resource.className,
					...(scriptName === workerScriptName
						? {}
						: { script_name: scriptName }),
				});
				break;
			}
			case "workflow": {
				const resource = resourceFor(resources, binding.resource, "workflow");
				arrays.workflows.push({
					binding: binding.name,
					class_name: resource.className,
					name: resolveCoordinate(resource.workflowName, resource.id),
				});
				break;
			}
			case "queue": {
				const resource = resourceFor(resources, binding.resource, "queue");
				const queue = resolveCoordinate(resource.queueName, resource.id);
				if (binding.role === "producer") {
					queueProducers.push({ binding: binding.name, queue });
				} else {
					queueConsumers.push({ queue });
				}
				break;
			}
			case "service": {
				const resource = resourceFor(resources, binding.resource, "service");
				const serviceName = resolveCoordinate(
					resource.serviceName,
					resource.id,
				);
				arrays.services.push({
					binding: binding.name,
					service: resource.environment
						? `${serviceName}-${resource.environment}`
						: serviceName,
					...(binding.entrypoint ? { entrypoint: binding.entrypoint } : {}),
				});
				break;
			}
			case "browser":
				resourceFor(resources, binding.resource, "browser");
				config.browser = { binding: binding.name };
				break;
			case "ai":
				resourceFor(resources, binding.resource, "ai");
				config.ai = { binding: binding.name };
				break;
			case "vectorize": {
				const resource = resourceFor(resources, binding.resource, "vectorize");
				arrays.vectorize.push({
					binding: binding.name,
					index_name: resolveCoordinate(resource.indexName, resource.id),
				});
				break;
			}
			case "hyperdrive": {
				const resource = resourceFor(resources, binding.resource, "hyperdrive");
				arrays.hyperdrive.push({
					binding: binding.name,
					id: resolveCoordinate(resource.configurationId, resource.id),
				});
				break;
			}
			case "container": {
				const resource = resourceFor(resources, binding.resource, "container");
				arrays.containers.push({
					class_name: resource.className,
					image: resource.image,
					name: resolveCoordinate(resource.containerName, resource.id),
				});
				break;
			}
			case "assets": {
				const resource = resourceFor(resources, binding.resource, "assets");
				config.assets = {
					binding: binding.name,
					directory: resource.directory,
					run_worker_first: resource.runWorkerFirst,
				};
				break;
			}
		}
	}

	for (const [key, value] of Object.entries(arrays)) {
		if (value.length > 0) config[key] = value;
	}
	if (durableObjects.length > 0) {
		config.durable_objects = { bindings: durableObjects };
	}
	if (queueConsumers.length > 0 || queueProducers.length > 0) {
		config.queues = {
			...(queueConsumers.length > 0 ? { consumers: queueConsumers } : {}),
			...(queueProducers.length > 0 ? { producers: queueProducers } : {}),
		};
	}
}

function assertSecretFree(value: unknown, path = "config"): void {
	if (typeof value === "string") {
		if (value.toLowerCase().includes(PASS_REFERENCE_PREFIX)) {
			throw new WranglerOverlayError(
				"secret.pass-reference",
				`${path} contains a forbidden secret-provider reference`,
			);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, nested] of value.entries()) {
			assertSecretFree(nested, `${path}[${index}]`);
		}
		return;
	}
	if (!isObject(value)) return;
	for (const [key, nested] of Object.entries(value)) {
		if (SECRET_LIKE_KEY.test(key)) {
			throw new WranglerOverlayError(
				"secret.inline-value",
				`${path}.${key} looks like an inline secret value`,
			);
		}
		assertSecretFree(nested, `${path}.${key}`);
	}
}

function requiredSecrets(
	manifest: InstallationManifest,
	workerId: string,
): string[] {
	const mode = manifest.billingSettlement?.mode ?? "disabled";
	const secrets = [
		...new Set(
			manifest.secretRequirements
				.filter(
					(requirement) =>
						requirement.required &&
						(requirement.scope !== "worker" || requirement.target === workerId),
				)
				.map((requirement) => requirement.name),
		),
	];
	if (mode !== "managed" || manifest.fleetAuthority.mode === "disabled") {
		return secrets.filter((name) => !name.startsWith("STRIPE_")).sort();
	}
	const missing = MANAGED_STRIPE_SECRETS.filter(
		(name) => !secrets.includes(name),
	);
	if (missing.length > 0) {
		throw new WranglerOverlayError(
			"billing-settlement.secrets-missing",
			`Managed Stripe settlement requires secret names: ${missing.join(", ")}`,
		);
	}
	return secrets.sort();
}

export function createWranglerOverlay(
	options: WranglerOverlayOptions,
): WranglerOverlayResult {
	const mode = options.mode ?? "preview";
	const manifest = validatedManifest(options.manifest, mode);
	const worker = manifest.workers.find(({ id }) => id === options.workerId);
	if (!worker) {
		throw new WranglerOverlayError(
			"worker.not-found",
			`Worker ${options.workerId} is not declared`,
		);
	}
	const source = parseSourceConfig(options.sourceConfig);
	const config = copyAuthoredRuntime(source);
	const account = manifest.cloudflare.accounts.find(
		({ key }) => key === worker.account,
	);
	if (!account) {
		throw new WranglerOverlayError(
			"account.not-found",
			`Worker account ${worker.account} is not declared`,
		);
	}
	const workerScriptName = resolveCoordinate(worker.scriptName, worker.id);
	config.account_id = resolveCoordinate(account.accountId, account.key);
	config.name = workerScriptName;
	config.compatibility_date = worker.compatibilityDate;
	config.routes = [...worker.routes]
		.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		)
		.map((route): WranglerConfig => {
			const domain = manifest.cloudflare.domains.find(
				({ key }) => key === route.domain,
			);
			if (!domain) {
				throw new WranglerOverlayError(
					"route.domain-not-found",
					`Route domain ${route.domain} is not declared`,
				);
			}
			return route.kind === "custom-domain"
				? {
						custom_domain: true,
						pattern: route.hostname,
						zone_name: domain.hostname,
					}
				: { pattern: route.pattern, zone_name: domain.hostname };
		});
	config.workers_dev = worker.workersDev;
	config.vars = Object.fromEntries(
		Object.entries(worker.vars).sort(([left], [right]) =>
			left.localeCompare(right),
		),
	) as WranglerConfig;
	const settlementMode = manifest.billingSettlement?.mode ?? "disabled";
	config.vars.TEDIX_BILLING_SETTLEMENT_MODE = settlementMode;
	config.vars.TEDIX_FLEET_AUTHORITY_MODE = manifest.fleetAuthority.mode;
	config.vars.TEDIX_RUNTIME_ENTITLEMENT_GRANTS = JSON.stringify(
		[...manifest.entitlements.grants].sort((left, right) =>
			left.key.localeCompare(right.key),
		),
	);
	applyBindings(config, manifest, worker, workerScriptName);
	assertSecretFree(config);
	return {
		config,
		requiredSecrets: requiredSecrets(manifest, worker.id),
		text: renderJsonDocument(config),
	};
}
