import type { InstallationManifest } from "./schema";

const INTERACTIVE_ROLE_PERMISSIONS = {
	owner: ["tedis:read"],
	admin: ["tedis:read"],
	member: ["tedis:read"],
	viewer: ["tedis:read"],
} as const;

export const DESCOPE_API_BASE_URL = "https://api.descope.com";

export type IdentityReadinessStatus = "passed" | "failed" | "error";

export interface IdentityReadinessCheck {
	id: string;
	status: IdentityReadinessStatus;
	detail: string;
}

export interface IdentitySurface {
	kind: "os";
	origin: string;
	approvedWebDomain: string;
	redirectUrl: string;
}

export interface IdentityReadinessReport {
	ok: boolean;
	mutationAllowed: boolean;
	provider: "descope";
	projectId: string;
	baseUrl: string;
	managementApiBaseUrl: string;
	flowId: string;
	surfaces: IdentitySurface[];
	checks: IdentityReadinessCheck[];
	readOnlyRequests: Array<{
		method: "GET" | "POST";
		url: string;
		operation: "oidc-discovery" | "project-export";
	}>;
}

export interface DescopeIdentityReadinessOptions {
	projectId: string;
	managementKey: string;
	osUrl?: string;
	baseUrl?: string;
	managementApiBaseUrl?: string;
	flowId?: string;
	fetchImplementation?: typeof fetch;
}

function normalizedBaseUrl(value: string, label: string): string {
	const url = new URL(value);
	if (url.username || url.password || url.search || url.hash) {
		throw new Error(`${label} must be an origin without credentials or query`);
	}
	if (
		url.protocol !== "https:" &&
		!(
			url.protocol === "http:" &&
			(url.hostname === "localhost" || url.hostname === "127.0.0.1")
		)
	) {
		throw new Error(
			`${label} must use HTTPS (HTTP is allowed only for localhost)`,
		);
	}
	return url.origin;
}

function surface(
	kind: IdentitySurface["kind"],
	value: string,
): IdentitySurface {
	const origin = normalizedBaseUrl(value, `${kind} URL`);
	const url = new URL(origin);
	return {
		kind,
		origin,
		approvedWebDomain: url.hostname.toLowerCase(),
		redirectUrl: new URL("/login", origin).toString(),
	};
}

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function fileObject(value: unknown): Record<string, unknown> | null {
	if (typeof value === "string") {
		try {
			return object(JSON.parse(value));
		} catch {
			return null;
		}
	}
	return object(value);
}

function trustedDomains(project: Record<string, unknown> | null): Set<string> {
	const raw = project?.trustedDomains;
	const values = Array.isArray(raw)
		? raw
		: typeof raw === "string"
			? raw.split(",")
			: [];
	return new Set(
		values
			.filter((value): value is string => typeof value === "string")
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean),
	);
}

function exportedRoles(
	value: Record<string, unknown> | null,
): Map<string, Set<string>> {
	const roles = Array.isArray(value?.roles) ? value.roles : [];
	return new Map(
		roles.flatMap((entry) => {
			const role = object(entry);
			if (typeof role?.name !== "string") return [];
			// Descope's project export serializes a role's grants as `permissions`,
			// while its role-management API returns `permissionNames`. Accept both
			// read-only representations so a live export is the source of truth.
			const rawPermissions = Array.isArray(role.permissions)
				? role.permissions
				: Array.isArray(role.permissionNames)
					? role.permissionNames
					: [];
			const permissionNames = rawPermissions.filter(
				(permission): permission is string => typeof permission === "string",
			);
			return [[role.name, new Set(permissionNames)] as const];
		}),
	);
}

function check(
	id: string,
	status: IdentityReadinessStatus,
	detail: string,
): IdentityReadinessCheck {
	return { id, status, detail };
}

async function responseJson(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("json")) return null;
	return response.json().catch(() => null);
}

/**
 * Read-only Descope readiness gate for self-hosted interactive surfaces.
 *
 * Descope's project export endpoint is an HTTP POST, but it is the provider's
 * documented read operation: it returns project configuration and performs no
 * import or update. The report records every request so callers can audit the
 * fail-before-mutation boundary without exposing the management key.
 */
export async function preflightDescopeIdentity(
	options: DescopeIdentityReadinessOptions,
): Promise<IdentityReadinessReport> {
	const projectId = options.projectId.trim();
	const managementKey = options.managementKey.trim();
	if (!projectId) throw new Error("Descope project ID is required");
	if (!managementKey) throw new Error("Descope management key is required");

	const baseUrl = normalizedBaseUrl(
		options.baseUrl ?? DESCOPE_API_BASE_URL,
		"Descope base URL",
	);
	const managementApiBaseUrl = normalizedBaseUrl(
		options.managementApiBaseUrl ?? DESCOPE_API_BASE_URL,
		"Descope management API base URL",
	);
	const flowId = options.flowId?.trim() || "sign-up-or-in";
	const surfaces = options.osUrl ? [surface("os", options.osUrl)] : [];
	if (surfaces.length === 0) {
		throw new Error("an OS URL is required");
	}
	const fetchImplementation =
		options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
	const checks: IdentityReadinessCheck[] = [];
	const readOnlyRequests: IdentityReadinessReport["readOnlyRequests"] = [];

	const discoveryUrl = `${baseUrl}/${encodeURIComponent(projectId)}/.well-known/openid-configuration`;
	readOnlyRequests.push({
		method: "GET",
		url: discoveryUrl,
		operation: "oidc-discovery",
	});
	try {
		const response = await fetchImplementation(discoveryUrl, { method: "GET" });
		const body = object(await responseJson(response));
		const expectedIssuer = `${baseUrl}/${projectId}`;
		if (!response.ok) {
			checks.push(
				check(
					"descope.project-discovery",
					"failed",
					`OIDC discovery returned HTTP ${response.status}`,
				),
			);
		} else if (body?.issuer !== expectedIssuer) {
			checks.push(
				check(
					"descope.project-discovery",
					"failed",
					`OIDC issuer did not match ${expectedIssuer}`,
				),
			);
		} else {
			checks.push(
				check(
					"descope.project-discovery",
					"passed",
					`project issuer is ${expectedIssuer}`,
				),
			);
		}
	} catch {
		// Transport exceptions can contain request headers or credentials.
		// Keep reports operation-specific without serializing the thrown value.
		checks.push(
			check(
				"descope.project-discovery",
				"error",
				"OIDC discovery request failed",
			),
		);
	}

	const exportUrl = `${managementApiBaseUrl}/v1/mgmt/project/export`;
	readOnlyRequests.push({
		method: "POST",
		url: exportUrl,
		operation: "project-export",
	});
	let files: Record<string, unknown> | null = null;
	try {
		const response = await fetchImplementation(exportUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${projectId}:${managementKey}`,
				"Content-Type": "application/json",
			},
			body: "{}",
		});
		const body = object(await responseJson(response));
		files = object(body?.files);
		if (!response.ok || !files) {
			checks.push(
				check(
					"descope.management-access",
					"failed",
					`project export returned HTTP ${response.status}`,
				),
			);
		} else {
			checks.push(
				check(
					"descope.management-access",
					"passed",
					"management key can read the project export",
				),
			);
		}
	} catch {
		checks.push(
			check(
				"descope.management-access",
				"error",
				"project export request failed",
			),
		);
	}

	const project = fileObject(files?.["project.json"]);
	const approved = trustedDomains(project);
	for (const entry of surfaces) {
		const present = approved.has(entry.approvedWebDomain);
		checks.push(
			check(
				`descope.approved-domain.${entry.kind}`,
				present ? "passed" : files ? "failed" : "error",
				present
					? `${entry.approvedWebDomain} is approved`
					: `add ${entry.approvedWebDomain} to Project Settings > Approved Domains`,
			),
		);
	}

	const flow = fileObject(files?.[`flows/${flowId}/metadata.json`]);
	const enabled = flow !== null && flow.disabled !== true;
	checks.push(
		check(
			"descope.login-flow",
			enabled ? "passed" : files ? "failed" : "error",
			enabled
				? `${flowId} exists and is enabled`
				: `publish and enable the ${flowId} flow`,
		),
	);

	const roles = exportedRoles(fileObject(files?.["roles.json"]));
	for (const [roleName, requiredPermissions] of Object.entries(
		INTERACTIVE_ROLE_PERMISSIONS,
	)) {
		const permissions = roles.get(roleName);
		const missing = requiredPermissions.filter(
			(permission) => !permissions?.has(permission),
		);
		checks.push(
			check(
				`descope.role.${roleName}`,
				missing.length === 0 && permissions
					? "passed"
					: files
						? "failed"
						: "error",
				missing.length === 0 && permissions
					? `${roleName} grants ${requiredPermissions.join(", ")}`
					: `create or update ${roleName} with ${missing.join(", ") || requiredPermissions.join(", ")}`,
			),
		);
	}

	checks.sort((left, right) => left.id.localeCompare(right.id));
	const ok = checks.every((entry) => entry.status === "passed");
	return {
		ok,
		mutationAllowed: ok,
		provider: "descope",
		projectId,
		baseUrl,
		managementApiBaseUrl,
		flowId,
		surfaces,
		checks,
		readOnlyRequests,
	};
}

export function renderIdentityReadinessReport(
	report: IdentityReadinessReport,
): string {
	const lines = [
		`Descope identity readiness: ${report.ok ? "PASS" : "FAIL"}`,
		`  project: ${report.projectId}`,
		`  base URL: ${report.baseUrl}`,
		"  Approved Web Domains:",
		...report.surfaces.map((entry) => `    - ${entry.approvedWebDomain}`),
		"  Redirect URLs:",
		...report.surfaces.map(
			(entry) => `    - ${entry.kind}: ${entry.redirectUrl}`,
		),
		...report.checks.map(
			(entry) =>
				`  [${entry.status === "passed" ? "ok" : "!!"}] ${entry.id}: ${entry.detail}`,
		),
	];
	return `${lines.join("\n")}\n`;
}

export function requiresInteractiveIdentityPreflight(
	manifest: InstallationManifest,
): boolean {
	return (
		manifest.providerPrerequisites.some(
			(provider) =>
				provider.provider === "descope" && provider.requirement === "required",
		) && manifest.surfaces.some((surface) => surface.kind === "os")
	);
}
