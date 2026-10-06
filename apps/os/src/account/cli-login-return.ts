/**
 * Build the loopback return URL that the `tedix` CLI's local callback server
 * waits on after the operator picks an organization at `os.tedix.dev/cli/login`.
 *
 * The CLI opens `os.tedix.dev/cli/login?port=<loopback>&state=<uuid>` and parses
 * a redirect to `http://127.0.0.1:<port>/workspace?state=<uuid>&organization=<slug>&tenant=<descope-id>`
 * (see `packages/cli/src/browser-workspace-selection.ts`). This builder is the
 * launcher's half of that contract.
 *
 * SECURITY — no open redirect. The destination host is ALWAYS the loopback
 * literal `127.0.0.1`; it is never taken from a request parameter. `port`,
 * `state`, and `organization` are the only caller-influenced values and each is
 * strictly validated, so a crafted `?port=`/`?state=` cannot redirect the
 * authenticated browser anywhere but the user's own machine. Any invalid input
 * returns `null` — the caller must refuse to redirect, never fall back to a
 * best-effort target.
 */

import { OS_LAUNCHER_ORIGIN } from "@/account/launcher-routing";
import { buildBrokerStartPath } from "@/shared/session-status";

// Mirrors the CLI's ORGANIZATION_SLUG_RE exactly so a slug the launcher accepts
// is one the CLI will also accept on the callback.
const ORGANIZATION_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
// Opaque anti-CSRF nonce the CLI minted; bound in length and charset so it can
// never smuggle URL structure into the redirect target.
const STATE_RE = /^[A-Za-z0-9._-]{1,200}$/;
const DESCOPE_TENANT_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const SCOPE_RE =
	/^(?:mcp:[a-z0-9_-]+\.(?:read|write|admin)|connections\.(?:execute|admin)|platform:admin)$/;

export interface CliLoginOrganizationSelection {
	organization: string;
	tenant: string;
}

function normalizeCliLoginSelection(params: {
	port: string | null | undefined;
	state: string | null | undefined;
	organization: string;
	tenant: string;
}): {
	organization: string;
	port: number;
	state: string;
	tenant: string;
} | null {
	const port = Number(params.port);
	if (!params.port || !Number.isInteger(port) || port < 1 || port > 65_535) {
		return null;
	}
	const state = params.state?.trim();
	if (!state || !STATE_RE.test(state)) return null;
	const organization = params.organization.trim().toLowerCase();
	if (!ORGANIZATION_SLUG_RE.test(organization)) return null;
	const tenant = params.tenant.trim();
	if (!DESCOPE_TENANT_ID_RE.test(tenant)) return null;
	return { organization, port, state, tenant };
}

export function buildCliLoginReturnTarget(params: {
	port: string | null | undefined;
	state: string | null | undefined;
	organization: string;
	tenant: string;
	selections?: readonly CliLoginOrganizationSelection[];
	scopes?: readonly string[];
}): string | null {
	const selection = normalizeCliLoginSelection(params);
	if (!selection) return null;

	// Host is a hardcoded loopback literal — never a parameter. This is what
	// makes the redirect un-openable regardless of the query string.
	const target = new URL(`http://127.0.0.1:${selection.port}/workspace`);
	target.searchParams.set("state", selection.state);
	target.searchParams.set("organization", selection.organization);
	target.searchParams.set("tenant", selection.tenant);
	if (params.selections) {
		if (
			params.selections.length < 1 ||
			params.selections.length > 50 ||
			params.selections[0]?.organization !== selection.organization ||
			params.selections[0]?.tenant !== selection.tenant
		)
			return null;
		const seen = new Set<string>();
		for (const item of params.selections) {
			const valid = normalizeCliLoginSelection({
				...params,
				organization: item.organization,
				tenant: item.tenant,
			});
			if (!valid || seen.has(valid.tenant)) return null;
			seen.add(valid.tenant);
			target.searchParams.append("selected_org", valid.organization);
			target.searchParams.append("selected_tenant", valid.tenant);
		}
	}
	if (params.scopes) {
		if (params.scopes.length < 1 || params.scopes.length > 100) return null;
		const unique = new Set(params.scopes);
		if (
			unique.size !== params.scopes.length ||
			[...unique].some((scope) => !SCOPE_RE.test(scope))
		)
			return null;
		for (const scope of params.scopes)
			target.searchParams.append("scope", scope);
	}
	return target.toString();
}

export function buildCliLoginBrokerTarget(params: {
	port: string | null | undefined;
	state: string | null | undefined;
	organization: string;
	tenant: string;
	selections?: readonly CliLoginOrganizationSelection[];
	scopes?: readonly string[];
}): string | null {
	const selection = normalizeCliLoginSelection(params);
	if (!selection) return null;
	if (!buildCliLoginReturnTarget(params)) return null;

	const resume = new URL("/cli/login", OS_LAUNCHER_ORIGIN);
	resume.searchParams.set("port", String(selection.port));
	resume.searchParams.set("state", selection.state);
	resume.searchParams.set("organization", selection.organization);
	resume.searchParams.set("selected_organization", selection.organization);
	resume.searchParams.set("selected_tenant", selection.tenant);
	for (const item of params.selections ?? []) {
		resume.searchParams.append("batch_org", item.organization);
		resume.searchParams.append("batch_tenant", item.tenant);
	}
	for (const scope of params.scopes ?? [])
		resume.searchParams.append("scope", scope);

	return buildBrokerStartPath("/cli/session-broker", {
		redirectTo: `${resume.pathname}${resume.search}`,
		tenantId: selection.tenant,
	});
}
