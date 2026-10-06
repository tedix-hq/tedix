import * as z from "zod";

const IdentifierSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);
const EnvironmentNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Z][A-Z0-9_]*$/);
const BindingNameSchema = EnvironmentNameSchema;
const SecretNameSchema = EnvironmentNameSchema;
const NonEmptyStringSchema = z.string().min(1).max(512);
const WorkspacePathSchema = z
	.string()
	.min(1)
	.max(512)
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!value.split("/").some((segment) => segment === "." || segment === ".."),
		"must be a workspace-relative path without traversal segments",
	)
	.refine(
		(value) =>
			value.endsWith(".jsonc") || value.endsWith("/cloudflare.config.ts"),
		"must identify a JSONC or Cloudflare Worker config file",
	);
const ProfileSchema = z.enum(["developer", "smb", "enterprise"]);
const RequirementSchema = z.enum(["required", "optional"]);

export const CoordinateSchema = z.discriminatedUnion("state", [
	z.strictObject({
		state: z.literal("resolved"),
		value: NonEmptyStringSchema,
	}),
	z.strictObject({
		state: z.literal("unresolved"),
		key: IdentifierSchema,
		reason: NonEmptyStringSchema,
	}),
]);

const RouteSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("pattern"),
		pattern: NonEmptyStringSchema,
		domain: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("custom-domain"),
		hostname: z.string().min(1).max(253),
		domain: IdentifierSchema,
	}),
]);

const BindingSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("d1"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("r2"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("kv"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("durable-object"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("workflow"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("queue"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
		role: z.enum(["producer", "consumer"]),
	}),
	z.strictObject({
		kind: z.literal("service"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
		/** Named entrypoint, e.g. `InternalEntrypoint` for trusted internal calls. */
		entrypoint: NonEmptyStringSchema.optional(),
	}),
	z.strictObject({
		kind: z.literal("browser"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("ai"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("vectorize"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("hyperdrive"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("container"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("assets"),
		name: BindingNameSchema,
		resource: IdentifierSchema,
	}),
]);

const resourceBase = {
	id: IdentifierSchema,
	provisioning: z.enum(["create", "adopt"]),
	requirement: RequirementSchema,
};

export const CloudflareResourceSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...resourceBase,
		kind: z.literal("d1"),
		databaseId: CoordinateSchema,
		databaseName: NonEmptyStringSchema,
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("r2"),
		bucketName: CoordinateSchema,
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("kv"),
		namespaceId: CoordinateSchema,
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("durable-object"),
		className: NonEmptyStringSchema,
		scriptName: CoordinateSchema,
		storage: z.enum(["sqlite", "kv"]),
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("workflow"),
		className: NonEmptyStringSchema,
		workflowName: CoordinateSchema,
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("queue"),
		queueName: CoordinateSchema,
		delivery: z.enum(["at-least-once"]),
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("service"),
		serviceName: CoordinateSchema,
		environment: NonEmptyStringSchema.optional(),
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("browser"),
		account: IdentifierSchema,
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("ai"),
		account: IdentifierSchema,
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("vectorize"),
		indexName: CoordinateSchema,
		dimensions: z.number().int().positive(),
		metric: z.enum(["cosine", "euclidean", "dot-product"]),
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("hyperdrive"),
		configurationId: CoordinateSchema,
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("container"),
		containerName: CoordinateSchema,
		className: NonEmptyStringSchema,
		image: NonEmptyStringSchema,
	}),
	z.strictObject({
		...resourceBase,
		kind: z.literal("assets"),
		directory: NonEmptyStringSchema,
		runWorkerFirst: z.boolean(),
	}),
]);

const AccessPlanSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("included"),
		profiles: z.array(ProfileSchema).min(1),
	}),
	z.strictObject({
		kind: z.literal("entitlement"),
		profiles: z.array(ProfileSchema).min(1),
		entitlement: IdentifierSchema,
	}),
	z.strictObject({
		kind: z.literal("provider-plan"),
		profiles: z.array(ProfileSchema).min(1),
		provider: IdentifierSchema,
		plan: NonEmptyStringSchema,
	}),
]);

const BootstrapInputSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("identifier"),
		name: EnvironmentNameSchema,
		value: IdentifierSchema,
		source: z.enum(["operator", "generated"]),
	}),
	z.strictObject({
		kind: z.literal("hostname"),
		name: EnvironmentNameSchema,
		value: z.string().min(1).max(253),
		source: z.enum(["operator", "generated"]),
	}),
	z.strictObject({
		kind: z.literal("url"),
		name: EnvironmentNameSchema,
		value: z.string().url(),
		source: z.enum(["operator", "generated"]),
	}),
	z.strictObject({
		kind: z.literal("boolean"),
		name: EnvironmentNameSchema,
		value: z.boolean(),
		source: z.enum(["operator", "generated"]),
	}),
	z.strictObject({
		kind: z.literal("integer"),
		name: EnvironmentNameSchema,
		value: z.number().int(),
		source: z.enum(["operator", "generated"]),
	}),
]);

const InstallationManifestDocumentSchema = z.strictObject({
	schemaVersion: z.literal("1.0"),
	installation: z.strictObject({
		id: IdentifierSchema,
		name: NonEmptyStringSchema,
		environment: z.enum(["development", "staging", "production"]),
		release: z.strictObject({
			version: NonEmptyStringSchema,
			channel: z.enum(["nightly", "candidate", "stable", "lts"]),
		}),
	}),
	organization: z.strictObject({
		key: IdentifierSchema,
		displayName: NonEmptyStringSchema,
		profile: ProfileSchema,
		capabilityRequirements: z.strictObject({
			required: z.array(IdentifierSchema),
			optional: z.array(IdentifierSchema),
		}),
	}),
	cloudflare: z.strictObject({
		primaryAccount: IdentifierSchema,
		accounts: z
			.array(
				z.strictObject({
					key: IdentifierSchema,
					accountId: CoordinateSchema,
					/**
					 * Fresh-account certification is stricter than ordinary provisioning:
					 * preflight verifies that no prior Worker or declared resource type
					 * exists before any mutation is allowed.
					 */
					freshAccount: z.boolean().default(false),
				}),
			)
			.min(1),
		domains: z.array(
			z.strictObject({
				key: IdentifierSchema,
				hostname: z.string().min(1).max(253),
				account: IdentifierSchema,
				zoneId: CoordinateSchema,
				purpose: z.enum(["application", "tenant", "internal"]),
			}),
		),
	}),
	workers: z.array(
		z.strictObject({
			id: IdentifierSchema,
			account: IdentifierSchema,
			sourceConfig: WorkspacePathSchema,
			scriptName: CoordinateSchema,
			compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
			routes: z.array(RouteSchema),
			// An installation, not the authored source config, owns whether the
			// script is reachable on its account's workers.dev hostname.
			workersDev: z.boolean(),
			bindings: z.array(BindingSchema),
			vars: z.record(EnvironmentNameSchema, z.json()),
		}),
	),
	surfaces: z.array(
		z.strictObject({
			id: IdentifierSchema,
			kind: z.enum(["api", "os", "mcp", "runtime", "site"]),
			worker: IdentifierSchema,
			exposure: z.enum(["public", "authenticated", "internal"]),
		}),
	),
	resources: z.array(CloudflareResourceSchema),
	providerPrerequisites: z.array(
		z.strictObject({
			id: IdentifierSchema,
			provider: IdentifierSchema,
			requirement: RequirementSchema,
			status: z.enum(["ready", "missing", "not-applicable"]),
			configurationNames: z.array(EnvironmentNameSchema),
			secretNames: z.array(SecretNameSchema),
		}),
	),
	secretRequirements: z.array(
		z.strictObject({
			name: SecretNameSchema,
			scope: z.enum(["installation", "provider", "worker"]),
			target: IdentifierSchema,
			required: z.boolean(),
		}),
	),
	capabilities: z.array(
		z.strictObject({
			id: IdentifierSchema,
			requirement: RequirementSchema,
			availability: z.enum(["available", "unavailable", "planned"]),
			accessPlan: AccessPlanSchema,
		}),
	),
	entitlements: z.strictObject({
		grants: z.array(
			z.strictObject({
				key: IdentifierSchema,
				status: z.enum(["active", "inactive"]),
				source: z.enum(["license", "managed-plan", "operator"]),
			}),
		),
	}),
	fleetAuthority: z.strictObject({
		mode: z.enum(["disabled", "co-located"]),
	}),
	billingSettlement: z
		.strictObject({
			provider: IdentifierSchema,
			mode: z.enum(["external", "managed", "disabled"]),
			accountReference: NonEmptyStringSchema.optional(),
		})
		.optional(),
	bootstrap: z.strictObject({
		seed: z.enum(["empty", "developer-example", "organization-template"]),
		inputs: z.array(BootstrapInputSchema),
	}),
	lifecycle: z.strictObject({
		backup: z.strictObject({
			required: z.boolean(),
			resourceIds: z.array(IdentifierSchema),
			retentionDays: z.number().int().positive(),
			restoreTestRequired: z.boolean(),
		}),
		export: z.strictObject({
			required: z.boolean(),
			format: z.enum(["portable-json", "provider-native", "both"]),
			includes: z.array(
				z.enum(["configuration", "data", "artifacts", "audit"]),
			),
		}),
		upgrade: z.strictObject({
			strategy: z.enum(["in-place", "blue-green"]),
			fromSchemaVersions: z.array(NonEmptyStringSchema).min(1),
			preflightRequired: z.literal(true),
			backupRequired: z.boolean(),
			rollbackRequired: z.boolean(),
		}),
	}),
	execution: z.strictObject({
		preflight: z.literal("fail-before-mutation"),
		mutationRequiresCertification: z.literal(true),
	}),
	certification: z.strictObject({
		status: z.enum(["uncertified", "blocked", "certified"]),
		level: z.enum([
			"schema-valid",
			"profile-ready",
			"installation-ready",
			"operational",
		]),
		evidence: z.array(
			z.strictObject({
				kind: z.enum(["schema", "clean-account", "backup-restore", "upgrade"]),
				reference: NonEmptyStringSchema,
			}),
		),
	}),
});

type ManifestDocument = z.infer<typeof InstallationManifestDocumentSchema>;
type IssuePath = Array<string | number>;

interface SemanticIssue {
	code: string;
	message: string;
	path: IssuePath;
}

const PASS_REFERENCE_PREFIX = ["pass:", "//"].join("");
const SECRET_LIKE_INPUT =
	/(?:^|_)(?:API_KEY|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/;

function issueSortKey(issue: SemanticIssue): string {
	return `${issue.path.join("/")}\0${issue.code}\0${issue.message}`;
}

function sortedIssues(issues: SemanticIssue[]): SemanticIssue[] {
	return issues.sort((left, right) =>
		issueSortKey(left).localeCompare(issueSortKey(right)),
	);
}

function duplicateIssues(
	values: Array<{ id?: string; key?: string }>,
	path: string,
): SemanticIssue[] {
	const seen = new Set<string>();
	const issues: SemanticIssue[] = [];
	for (const [index, value] of values.entries()) {
		const identifier = value.id ?? value.key;
		if (!identifier || !seen.has(identifier)) {
			if (identifier) seen.add(identifier);
			continue;
		}
		issues.push({
			code: "identifier.duplicate",
			message: `duplicate identifier ${identifier}`,
			path: [path, index, value.id ? "id" : "key"],
		});
	}
	return issues;
}

function inspectSecretFreeValue(
	value: unknown,
	path: IssuePath,
	issues: SemanticIssue[],
): void {
	if (typeof value === "string") {
		if (value.toLowerCase().includes(PASS_REFERENCE_PREFIX)) {
			issues.push({
				code: "secret.pass-reference",
				message: "secret-provider references are forbidden",
				path,
			});
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, nested] of value.entries()) {
			inspectSecretFreeValue(nested, [...path, index], issues);
		}
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, nested] of Object.entries(value).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		inspectSecretFreeValue(nested, [...path, key], issues);
	}
}

function unresolvedCoordinates(
	value: unknown,
	path: IssuePath,
	issues: SemanticIssue[],
): void {
	if (Array.isArray(value)) {
		for (const [index, nested] of value.entries()) {
			unresolvedCoordinates(nested, [...path, index], issues);
		}
		return;
	}
	if (!value || typeof value !== "object") return;
	const object = value as Record<string, unknown>;
	if (object.state === "unresolved") {
		issues.push({
			code: "certification.unresolved-coordinate",
			message: `coordinate ${String(object.key)} is unresolved`,
			path,
		});
		return;
	}
	for (const [key, nested] of Object.entries(object).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		unresolvedCoordinates(nested, [...path, key], issues);
	}
}

function semanticIssues(manifest: ManifestDocument): SemanticIssue[] {
	const issues: SemanticIssue[] = [];
	inspectSecretFreeValue(manifest, [], issues);
	issues.push(
		...duplicateIssues(manifest.cloudflare.accounts, "cloudflare.accounts"),
		...duplicateIssues(manifest.cloudflare.domains, "cloudflare.domains"),
		...duplicateIssues(manifest.workers, "workers"),
		...duplicateIssues(manifest.surfaces, "surfaces"),
		...duplicateIssues(manifest.resources, "resources"),
		...duplicateIssues(manifest.providerPrerequisites, "providerPrerequisites"),
		...duplicateIssues(manifest.capabilities, "capabilities"),
	);

	const accounts = new Set(
		manifest.cloudflare.accounts.map((account) => account.key),
	);
	const domains = new Set(
		manifest.cloudflare.domains.map((domain) => domain.key),
	);
	const workers = new Set(manifest.workers.map((worker) => worker.id));
	const resources = new Map(
		manifest.resources.map((resource) => [resource.id, resource.kind]),
	);
	if (!accounts.has(manifest.cloudflare.primaryAccount)) {
		issues.push({
			code: "topology.primary-account-missing",
			message: `primary account ${manifest.cloudflare.primaryAccount} is not declared`,
			path: ["cloudflare", "primaryAccount"],
		});
	}
	for (const [index, domain] of manifest.cloudflare.domains.entries()) {
		if (!accounts.has(domain.account)) {
			issues.push({
				code: "topology.domain-account-missing",
				message: `account ${domain.account} is not declared`,
				path: ["cloudflare", "domains", index, "account"],
			});
		}
	}
	for (const [workerIndex, worker] of manifest.workers.entries()) {
		if (!accounts.has(worker.account)) {
			issues.push({
				code: "topology.worker-account-missing",
				message: `account ${worker.account} is not declared`,
				path: ["workers", workerIndex, "account"],
			});
		}
		for (const [routeIndex, route] of worker.routes.entries()) {
			if (!domains.has(route.domain)) {
				issues.push({
					code: "topology.route-domain-missing",
					message: `domain ${route.domain} is not declared`,
					path: ["workers", workerIndex, "routes", routeIndex, "domain"],
				});
			}
		}
		for (const [bindingIndex, binding] of worker.bindings.entries()) {
			const resourceKind = resources.get(binding.resource);
			if (!resourceKind) {
				issues.push({
					code: "binding.resource-missing",
					message: `resource ${binding.resource} is not declared`,
					path: ["workers", workerIndex, "bindings", bindingIndex, "resource"],
				});
			} else if (resourceKind !== binding.kind) {
				issues.push({
					code: "binding.kind-mismatch",
					message: `binding kind ${binding.kind} does not match resource kind ${resourceKind}`,
					path: ["workers", workerIndex, "bindings", bindingIndex, "kind"],
				});
			}
		}
		for (const name of Object.keys(worker.vars).sort()) {
			if (SECRET_LIKE_INPUT.test(name)) {
				issues.push({
					code: "worker.secret-like-var",
					message: `worker var ${name} must be represented by secretRequirements`,
					path: ["workers", workerIndex, "vars", name],
				});
			}
		}
	}
	for (const [index, surface] of manifest.surfaces.entries()) {
		if (!workers.has(surface.worker)) {
			issues.push({
				code: "surface.worker-missing",
				message: `worker ${surface.worker} is not declared`,
				path: ["surfaces", index, "worker"],
			});
		}
	}
	for (const [index, input] of manifest.bootstrap.inputs.entries()) {
		if (SECRET_LIKE_INPUT.test(input.name)) {
			issues.push({
				code: "bootstrap.secret-like-input",
				message: `bootstrap input ${input.name} must be represented by secretRequirements`,
				path: ["bootstrap", "inputs", index, "name"],
			});
		}
	}
	const bindingNames = new Set(
		manifest.workers.flatMap((worker) =>
			worker.bindings.map((binding) => binding.name),
		),
	);
	if (
		manifest.fleetAuthority.mode === "co-located" &&
		!bindingNames.has("DB")
	) {
		issues.push({
			code: "fleet-authority.tenant-binding-missing",
			message: "co-located fleet authority requires DB",
			path: ["fleetAuthority", "mode"],
		});
	}
	if (
		manifest.fleetAuthority.mode === "disabled" &&
		manifest.billingSettlement?.mode === "managed"
	) {
		issues.push({
			code: "fleet-authority.managed-settlement-disabled",
			message: "managed billing settlement requires fleet authority",
			path: ["billingSettlement", "mode"],
		});
	}

	const profile = manifest.organization.profile;
	const capabilitiesById = new Map(
		manifest.capabilities.map((capability) => [capability.id, capability]),
	);
	const activeEntitlements = new Set(
		manifest.entitlements.grants
			.filter((grant) => grant.status === "active")
			.map((grant) => grant.key),
	);
	for (const [requirement, identifiers] of Object.entries(
		manifest.organization.capabilityRequirements,
	) as Array<["required" | "optional", string[]]>) {
		for (const [index, identifier] of identifiers.entries()) {
			const capability = capabilitiesById.get(identifier);
			if (!capability) {
				if (
					requirement === "required" &&
					manifest.certification.status === "certified"
				) {
					issues.push({
						code: "certification.required-capability-missing",
						message: `required capability ${identifier} is not declared`,
						path: [
							"organization",
							"capabilityRequirements",
							requirement,
							index,
						],
					});
				}
				continue;
			}
			if (capability.requirement !== requirement) {
				issues.push({
					code: "capability.requirement-mismatch",
					message: `capability ${identifier} is ${capability.requirement}, expected ${requirement}`,
					path: ["organization", "capabilityRequirements", requirement, index],
				});
			}
		}
	}
	for (const [index, capability] of manifest.capabilities.entries()) {
		if (!capability.accessPlan.profiles.includes(profile)) {
			issues.push({
				code: "capability.profile-mismatch",
				message: `capability ${capability.id} does not allow profile ${profile}`,
				path: ["capabilities", index, "accessPlan", "profiles"],
			});
		}
		if (
			manifest.certification.status === "certified" &&
			capability.requirement === "required" &&
			capability.availability !== "available"
		) {
			issues.push({
				code: "certification.required-capability-unavailable",
				message: `required capability ${capability.id} is not available`,
				path: ["capabilities", index, "availability"],
			});
		}
		if (
			manifest.certification.status === "certified" &&
			capability.requirement === "required" &&
			capability.accessPlan.kind === "entitlement" &&
			!activeEntitlements.has(capability.accessPlan.entitlement)
		) {
			issues.push({
				code: "certification.entitlement-missing",
				message: `required entitlement ${capability.accessPlan.entitlement} is not active`,
				path: ["capabilities", index, "accessPlan", "entitlement"],
			});
		}
	}
	if (manifest.certification.status === "certified") {
		unresolvedCoordinates(manifest, [], issues);
		for (const [index, provider] of manifest.providerPrerequisites.entries()) {
			if (provider.requirement === "required" && provider.status !== "ready") {
				issues.push({
					code: "certification.provider-not-ready",
					message: `required provider ${provider.id} is not ready`,
					path: ["providerPrerequisites", index, "status"],
				});
			}
		}
	}
	return sortedIssues(issues);
}

export const InstallationManifestSchema =
	InstallationManifestDocumentSchema.superRefine((manifest, context) => {
		for (const issue of semanticIssues(manifest)) {
			context.addIssue({
				code: "custom",
				message: `[${issue.code}] ${issue.message}`,
				path: issue.path,
			});
		}
	});

export type Coordinate = z.infer<typeof CoordinateSchema>;
export type CloudflareResource = z.infer<typeof CloudflareResourceSchema>;
export type InstallationManifest = z.infer<typeof InstallationManifestSchema>;
export type InstallationProfile = z.infer<typeof ProfileSchema>;
export type CloudflareBinding =
	InstallationManifest["workers"][number]["bindings"][number];
export type InstallationWorker = InstallationManifest["workers"][number];
export type InstallationSurface = InstallationManifest["surfaces"][number];
export type ProviderPrerequisite =
	InstallationManifest["providerPrerequisites"][number];
export type InstallationCapability =
	InstallationManifest["capabilities"][number];
export type InstallationEntitlement =
	InstallationManifest["entitlements"]["grants"][number];
export type BootstrapInput =
	InstallationManifest["bootstrap"]["inputs"][number];
export type InstallationLifecycle = InstallationManifest["lifecycle"];
export type CertificationStatus =
	InstallationManifest["certification"]["status"];
export type CertificationLevel = InstallationManifest["certification"]["level"];

export interface InstallationManifestIssue {
	code: string;
	message: string;
	path: IssuePath;
}

export interface InstallationManifestCertification {
	certified: boolean;
	effectiveStatus: CertificationStatus;
	issues: InstallationManifestIssue[];
	manifest?: InstallationManifest;
	success: boolean;
}

function normalizeZodIssue(issue: z.core.$ZodIssue): InstallationManifestIssue {
	const custom =
		issue.code === "custom"
			? issue.message.match(/^\[([^\]]+)\]\s*(.*)$/)
			: null;
	return {
		code: custom?.[1] ?? `schema.${issue.code}`,
		message: custom?.[2] ?? issue.message,
		path: issue.path.map((segment) =>
			typeof segment === "symbol" ? (segment.description ?? "symbol") : segment,
		),
	};
}

function statusFromInput(input: unknown): CertificationStatus {
	if (!input || typeof input !== "object") return "blocked";
	const certification = (input as Record<string, unknown>).certification;
	if (!certification || typeof certification !== "object") return "blocked";
	const status = (certification as Record<string, unknown>).status;
	return status === "uncertified" || status === "certified"
		? status
		: "blocked";
}

export function certifyInstallationManifest(
	input: unknown,
): InstallationManifestCertification {
	const result = InstallationManifestSchema.safeParse(input);
	if (!result.success) {
		const issues = result.error.issues
			.map(normalizeZodIssue)
			.sort((left, right) =>
				issueSortKey(left).localeCompare(issueSortKey(right)),
			);
		return {
			certified: false,
			effectiveStatus: "blocked",
			issues,
			success: false,
		};
	}
	const effectiveStatus = statusFromInput(result.data);
	return {
		certified: effectiveStatus === "certified",
		effectiveStatus,
		issues: [],
		manifest: result.data,
		success: true,
	};
}

export class InstallationManifestValidationError extends Error {
	readonly issues: InstallationManifestIssue[];

	constructor(issues: InstallationManifestIssue[]) {
		super(
			`Installation manifest preflight failed: ${issues.map((issue) => issue.code).join(", ")}`,
		);
		this.name = "InstallationManifestValidationError";
		this.issues = issues;
	}
}

export function parseInstallationManifest(
	input: unknown,
): InstallationManifest {
	const result = certifyInstallationManifest(input);
	if (!result.success || !result.manifest) {
		throw new InstallationManifestValidationError(result.issues);
	}
	return result.manifest;
}

export function installationManifestJsonSchema(): Record<string, unknown> {
	return z.toJSONSchema(InstallationManifestSchema, {
		target: "draft-2020-12",
		io: "input",
	}) as Record<string, unknown>;
}
