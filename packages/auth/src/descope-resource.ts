/**
 * Descope OAuth Resource management.
 *
 * Resources are the current authorization model shared by the Resources and
 * Agentic Identity Hub console views. Do not confuse these endpoints with the
 * legacy `/v1/mgmt/mcp/server/*` surface, which creates `MS...` records that do
 * not appear in the Resources inventory.
 */

import { descopeManagementFetch } from "./descope-fetch.ts";
import { DESCOPE_MANAGEMENT_BASE_URL } from "./types.ts";

export interface DescopeResourceEnv {
	DESCOPE_PROJECT_ID: string;
	DESCOPE_MANAGEMENT_KEY: string;
	DESCOPE_BASE_URL?: string;
}

export interface DescopeResourceScope {
	name: string;
	description?: string;
	optional?: boolean;
	values?: string[];
	[key: string]: unknown;
}

export interface DescopeResourceScopes {
	permissionsScopes?: DescopeResourceScope[];
	attributesScopes?: DescopeResourceScope[];
	connectionsScopes?: DescopeResourceScope[];
	[key: string]: unknown;
}

export interface DescopeResourceDynamicRegistrationSettings {
	dynamicRegistration?: Record<string, unknown>;
	cimdSettings?: Record<string, unknown>;
	dynamicRegistrationTemplateId?: string;
	useTemplate?: boolean;
	loginPageURL?: string;
	skipConsentScreen?: boolean;
	forceAddAllAuthorizationInfo?: boolean;
	tags?: string[];
	sessionSettings?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface DescopeResource {
	id: string;
	version?: string;
	name: string;
	scopes?: DescopeResourceScopes;
	createdTime?: string;
	modifiedTime?: string;
	userAccess?: string;
	clientAccess?: string;
	description?: string;
	uri: string;
	type: "api" | "mcp" | string;
	dynamicRegistrationSettings?: DescopeResourceDynamicRegistrationSettings;
	[key: string]: unknown;
}

export interface CreateDescopeResourceParams {
	name: string;
	uri: string;
	type: "api" | "mcp";
	description?: string;
	scopes?: DescopeResourceScopes;
	userAccess?: string;
	clientAccess?: string;
	dynamicRegistrationSettings?: DescopeResourceDynamicRegistrationSettings;
}

function resourceUrl(env: DescopeResourceEnv, path: string): string {
	return `${env.DESCOPE_BASE_URL ?? DESCOPE_MANAGEMENT_BASE_URL}${path}`;
}

export async function createDescopeResource(
	env: DescopeResourceEnv,
	params: CreateDescopeResourceParams,
): Promise<DescopeResource> {
	const response = await descopeManagementFetch(env, {
		url: resourceUrl(env, "/v1/mgmt/resource/create"),
		method: "POST",
		body: params,
		idempotent: false,
		errorPrefix: "Descope Resource create failed",
	});
	const data = (await response.json()) as { resource?: DescopeResource };
	if (!data.resource?.id) {
		throw new Error("Descope Resource create response missing resource.id");
	}
	return data.resource;
}

export async function updateDescopeResource(
	env: DescopeResourceEnv,
	resource: DescopeResource,
): Promise<DescopeResource> {
	const response = await descopeManagementFetch(env, {
		url: resourceUrl(env, "/v1/mgmt/resource/update"),
		method: "POST",
		body: { resource },
		idempotent: false,
		errorPrefix: "Descope Resource update failed",
	});
	const data = (await response.json()) as { resource?: DescopeResource };
	if (!data.resource?.id) {
		throw new Error("Descope Resource update response missing resource.id");
	}
	return data.resource;
}

export async function loadDescopeResource(
	env: DescopeResourceEnv,
	id: string,
): Promise<DescopeResource> {
	const response = await descopeManagementFetch(env, {
		url: resourceUrl(
			env,
			`/v1/mgmt/resource/load?id=${encodeURIComponent(id)}`,
		),
		method: "GET",
		idempotent: true,
		errorPrefix: "Descope Resource load failed",
	});
	const data = (await response.json()) as { resource?: DescopeResource };
	if (!data.resource?.id) {
		throw new Error("Descope Resource load response missing resource.id");
	}
	return data.resource;
}

export async function loadDescopeResourceByUri(
	env: DescopeResourceEnv,
	uri: string,
): Promise<DescopeResource> {
	const response = await descopeManagementFetch(env, {
		url: resourceUrl(
			env,
			`/v1/mgmt/resource/load/uri?uri=${encodeURIComponent(uri)}`,
		),
		method: "GET",
		idempotent: true,
		errorPrefix: "Descope Resource URI load failed",
	});
	const data = (await response.json()) as { resource?: DescopeResource };
	if (!data.resource?.id) {
		throw new Error("Descope Resource URI load response missing resource.id");
	}
	return data.resource;
}

export async function loadAllDescopeResources(
	env: DescopeResourceEnv,
): Promise<DescopeResource[]> {
	const response = await descopeManagementFetch(env, {
		url: resourceUrl(env, "/v1/mgmt/resources/load"),
		method: "GET",
		idempotent: true,
		errorPrefix: "Descope Resources load failed",
	});
	const data = (await response.json()) as { resources?: DescopeResource[] };
	return data.resources ?? [];
}

export async function deleteDescopeResource(
	env: DescopeResourceEnv,
	id: string,
): Promise<void> {
	await descopeManagementFetch(env, {
		url: resourceUrl(env, "/v1/mgmt/resource/delete"),
		method: "POST",
		body: { id },
		idempotent: false,
		errorPrefix: "Descope Resource delete failed",
	});
}
