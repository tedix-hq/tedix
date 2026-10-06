import {
	isReadOnlyConsentSelection,
	selectConsentPreset,
} from "@tedix/mcp-shared/auth/consent-scopes";
import { Descope, useDescope, useUser } from "@descope/react-sdk/flows";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TedixDescopeProvider } from "@/shared/descope-provider";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Checkbox } from "@/components/kumo/checkbox";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Text } from "@/components/kumo/text";
import { useDocumentTitle } from "@/lib/use-document-title";
import { osApi } from "@/lib/api";
import {
	buildBrokerStartPath,
	buildOsAuthReturnUrl,
	isDescopeFlowContinuation,
	OS_BROKER_STATUS_TIMEOUT_MS,
} from "@/shared/session-status";
import { TedixBrandMark } from "@/shared/tedix-brand";
import { IdentityJourneyFrame } from "@/account/identity-journey";
import { ConsentPermissionGroups } from "@/account/consent-permission-groups";
import {
	isTedixByosLoginScreen,
	TedixByosLoginScreen,
} from "@/account/descope-byos-login-screen";
import {
	DESCOPE_LOGIN_INTERACTIONS,
	DESCOPE_OTP_SCREEN_NAME,
	resolveDescopePasswordScreen,
	type DescopeByosContext,
	type DescopeFlowNext,
} from "@/shared/descope-byos-contract";
import { TedixByosOtpScreen } from "@/shared/descope-byos-otp-screen";
import {
	TedixByosPasswordScreen,
	type ByosPasswordScreenContract,
} from "@/shared/descope-byos-password-screen";
import {
	type ConsentPermission,
	normalizeConsentPermissions,
} from "@/shared/consent-permissions";

export const INBOUND_CONSENT_FLOW_ID = "inbound-apps-user-consent";
export const INBOUND_MULTI_ORG_CONSENT_FLOW_ID =
	"inbound-apps-multi-org-consent";
export const INBOUND_CONSENT_SCREEN_NAMES = new Set([
	"Consent Screen - Verified App",
	"Consent Screen - Unverified App",
	"Consent Screen - Verified",
	"Consent Screen - Unverified",
]);
export const INBOUND_CONSENT_AUTHORIZE_INTERACTION = "_Z6xPaS9jy";
export const INBOUND_CONSENT_CANCEL_INTERACTION = "6N3cb_5t3T";
export const INBOUND_CONSENT_RECOVERY_STORAGE_PREFIX =
	"tedix-inbound-consent-authorization:";
const INBOUND_CONSENT_BROKER_GUARD_PREFIX =
	"tedix-inbound-consent-broker-attempted:";

type InboundConsentFlowFailure =
	| "expired-callback"
	| "invalid-session"
	| "lost-request"
	| "unknown";

type ConsentRecoveryStorage = Pick<Storage, "getItem" | "setItem">;

type ConsentScreenState = {
	kind: "consent";
	context: Record<string, unknown>;
	next: DescopeFlowNext;
	scopes: ConsentPermission[];
};

type LoginScreenState = {
	kind: "login";
	context: DescopeByosContext;
	next: DescopeFlowNext;
};

type OtpScreenState = {
	kind: "otp";
	context: DescopeByosContext;
	next: DescopeFlowNext;
};

type InboundCustomScreenState =
	| ConsentScreenState
	| LoginScreenState
	| OtpScreenState
	| {
			kind: "password";
			contract: ByosPasswordScreenContract;
			context: DescopeByosContext;
			next: DescopeFlowNext;
	  };

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

export function isInvalidDescopeJwtFamily(error: unknown): boolean {
	return /E064006|JWT family ID invalidated/i.test(errorText(error));
}

export function isExpiredDescopeOauthCallback(error: unknown): boolean {
	return /E061301|Failed to exchange OAuth code/i.test(errorText(error));
}

export function inboundConsentFlowFailure(
	error: unknown,
): InboundConsentFlowFailure {
	if (isInvalidDescopeJwtFamily(error)) return "invalid-session";
	if (isExpiredDescopeOauthCallback(error)) return "expired-callback";
	return "unknown";
}

export function inboundConsentFlowError(result: unknown): unknown | null {
	const record = scopeRecord(result);
	if (!record) return null;
	if (record.ok === false) return record.error ?? record;
	return record.error ?? null;
}

export function inboundConsentContextError(
	context: Record<string, unknown>,
): unknown | null {
	return context.error ?? null;
}

export function inboundConsentDecisionError(error: unknown): string {
	const details =
		typeof error === "object" && error !== null
			? (error as { code?: unknown; status?: unknown })
			: null;
	return details?.code === "UNAUTHORIZED" || details?.status === 401
		? "Your Tedix session expired. Return to the application and sign in again."
		: "Could not save this consent decision. Please try again.";
}

export async function advanceInboundConsentFlow(
	next: DescopeFlowNext,
	interactionId: string,
	form: Record<string, unknown>,
): Promise<unknown | null> {
	try {
		return inboundConsentFlowError(await next(interactionId, form));
	} catch (error) {
		return error;
	}
}

export function inboundConsentTenant(url: string): string | undefined {
	try {
		return new URL(url).searchParams.get("tenant")?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function trustedInboundConsentAuthorizationUrl(url: string): string | null {
	try {
		const candidate = new URL(url);
		if (
			candidate.protocol === "https:" &&
			["api.descope.com", "auth.tedix.dev"].includes(candidate.hostname) &&
			/\/authorize\/?$/.test(candidate.pathname)
		) {
			return candidate.href;
		}
	} catch {
		// An absent or non-URL referrer is normal under strict referrer policies.
	}
	return null;
}

/**
 * Stable return URL for any provider redirect started by this flow. Descope
 * reads `code` and `descope-login-flow` directly from `window.location`, then
 * removes them. Passing that one-time callback back as `redirectUrl` stores a
 * spent provider code in the running flow and makes a later redirect replay it.
 */
export function inboundConsentResourceUrl(
	locationUrl: string,
	authorizationUrl?: string | null,
): string | null {
	try {
		const resources = [
			locationUrl,
			...(authorizationUrl ? [authorizationUrl] : []),
		].flatMap((source) => {
			const params = new URL(source).searchParams;
			return [...params.getAll("resource"), ...params.getAll("oidc_resource")];
		});
		if (!resources.length) return null;
		const normalized = resources.map((resource) => {
			if (!resource || resource.length > 2048) return null;
			const url = new URL(resource);
			return url.protocol === "https:" &&
				!url.username &&
				!url.password &&
				!url.search &&
				!url.hash
				? url.toString()
				: null;
		});
		if (
			normalized.some((resource) => resource === null) ||
			new Set(normalized).size !== 1
		)
			return null;
		return normalized[0] ?? null;
	} catch {
		return null;
	}
}

export function inboundConsentCallbackUrl(
	locationUrl: string,
	authorizationUrl?: string | null,
): string {
	const source = new URL(locationUrl);
	const callback = new URL(source.pathname, source.origin);
	const tenant = source.searchParams.get("tenant")?.trim();
	if (tenant) callback.searchParams.set("tenant", tenant);
	if (source.searchParams.get("mode") === "multi-org") {
		callback.searchParams.set("mode", "multi-org");
	}
	const appId = source.searchParams.get("third_party_app_id")?.trim();
	if (appId && /^TPA[A-Za-z0-9_-]{1,252}$/.test(appId)) {
		callback.searchParams.set("third_party_app_id", appId);
	}
	const resource = inboundConsentResourceUrl(locationUrl, authorizationUrl);
	if (resource) callback.searchParams.set("resource", resource);
	return callback.toString();
}

function inboundConsentRecoveryStorageKey(locationUrl: string): string | null {
	try {
		const stateId = new URL(locationUrl).searchParams.get(
			"third_party_app_state_id",
		);
		if (!stateId || stateId.length > 512) return null;
		return `${INBOUND_CONSENT_RECOVERY_STORAGE_PREFIX}${stateId}`;
	} catch {
		return null;
	}
}

/**
 * Preserve the immutable Descope `/authorize` request across the external IdP
 * round trip. Only the opaque transaction URL is stored; provider codes,
 * session tokens, and callback parameters are never persisted.
 */
export function inboundConsentRecoveryUrl(
	locationUrl: string,
	referrerUrl: string,
	storage: ConsentRecoveryStorage,
): string | null {
	const storageKey = inboundConsentRecoveryStorageKey(locationUrl);
	const trustedReferrer = trustedInboundConsentAuthorizationUrl(referrerUrl);
	if (trustedReferrer) {
		if (storageKey) {
			try {
				storage.setItem(storageKey, trustedReferrer);
			} catch {
				// Storage may be denied; the current document can still recover.
			}
		}
		return trustedReferrer;
	}
	if (!storageKey) return null;
	try {
		return trustedInboundConsentAuthorizationUrl(
			storage.getItem(storageKey) ?? "",
		);
	} catch {
		return null;
	}
}

function scopeRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function requestedScopes(context: Record<string, unknown>): unknown {
	const data = scopeRecord(context.data);
	return data?.inboundAppApproveScopes;
}

/**
 * The permissions a consent screen asks for, or null when the request lost
 * them. A reloaded consent page resumes the Descope flow without
 * `inboundAppApproveScopes`; rendering that as a zero-permission approval
 * would let a user "approve" a request they never saw.
 */
export function inboundConsentRequestedPermissions(
	context: Record<string, unknown>,
): ReturnType<typeof normalizeConsentPermissions> | null {
	const scopes = normalizeConsentPermissions(requestedScopes(context));
	return scopes.length > 0 ? scopes : null;
}

/** Bulk consent selection follows the displayed order and the organization cap. */
export function firstConsentOrganizationIds(
	organizations: readonly { id: string }[],
): string[] {
	return organizations.slice(0, 10).map((organization) => organization.id);
}

/** Platform authority is separate from ordinary permission presets. */
export function selectedConsentPermissions(
	offered: readonly ConsentPermission[],
	selected: readonly string[],
	platformEligible: boolean,
	platformAdministration: boolean,
): ConsentPermission[] {
	return offered.filter((permission) =>
		permission.name === "platform:admin"
			? platformEligible && platformAdministration
			: selected.includes(permission.name),
	);
}

export function consentForm(
	context: Record<string, unknown>,
	scopes: ConsentPermission[],
	selectedTenantIds?: readonly string[],
	consentRevision?: string,
): Record<string, unknown> {
	// ContextKeyInput outputs require their full form.* names in BYOS payloads.
	// Descope merges the current screen's outputs into its flow context. Re-sending
	// inputs from earlier screens can make the consent step reject custom outputs.
	const existing = selectedTenantIds ? {} : (scopeRecord(context.form) ?? {});
	return {
		...existing,
		thirdPartyAppApproveScopes: scopes.map((scope) => scope.name),
		...(selectedTenantIds
			? { "form.tedixSelectedOrganizations": JSON.stringify(selectedTenantIds) }
			: {}),
		...(consentRevision
			? { "form.tedixConsentRevision": consentRevision }
			: {}),
	};
}

export function inboundConsentClientId(
	authorizationUrl: string | null,
): string | null {
	if (!authorizationUrl) return null;
	const trusted = trustedInboundConsentAuthorizationUrl(authorizationUrl);
	if (!trusted) return null;
	const clientId = new URL(trusted).searchParams.get("client_id")?.trim();
	return clientId && clientId.length <= 2048 ? clientId : null;
}

/** The provider app ID survives the callback when referrer policy hides client_id. */
export function inboundConsentClientReference(
	authorizationUrl: string | null,
	locationUrl: string,
): string | null {
	const clientId = inboundConsentClientId(authorizationUrl);
	if (clientId) return clientId;
	try {
		const appId = new URL(locationUrl).searchParams
			.get("third_party_app_id")
			?.trim();
		return appId && /^TPA[A-Za-z0-9_-]{1,252}$/.test(appId) ? appId : null;
	} catch {
		return null;
	}
}

export function isMultiOrganizationConsent(locationUrl: string): boolean {
	try {
		return new URL(locationUrl).searchParams.get("mode") === "multi-org";
	} catch {
		return false;
	}
}

export function inboundConsentFlowId(locationUrl: string) {
	return isMultiOrganizationConsent(locationUrl)
		? INBOUND_MULTI_ORG_CONSENT_FLOW_ID
		: INBOUND_CONSENT_FLOW_ID;
}

function GroupedConsentScreen({
	state,
	tenant,
	clientId,
	resourceUrl,
	onFlowError,
}: {
	state: ConsentScreenState;
	tenant?: string;
	clientId: string | null;
	resourceUrl: string | null;
	onFlowError: (error: unknown) => void;
}) {
	const descope = useDescope();
	const { user } = useUser();
	const multiOrganization = isMultiOrganizationConsent(window.location.href);
	const selectableScopes = state.scopes.filter(
		(scope) => scope.name !== "platform:admin",
	);
	const platformPermission = state.scopes.find(
		(scope) => scope.name === "platform:admin",
	);
	const platformEligible = user?.roleNames?.includes("platform-admin") === true;
	const [platformAdministration, setPlatformAdministration] = useState(false);
	const [step, setStep] = useState<"permissions" | "organizations" | "review">(
		"permissions",
	);
	const [selectedScopes, setSelectedScopes] = useState<string[]>(() =>
		selectConsentPreset(selectableScopes, "read"),
	);
	const approvedPermissions = selectedConsentPermissions(
		state.scopes,
		selectedScopes,
		platformEligible,
		platformAdministration,
	);
	const requiredScopes = selectableScopes
		.filter((scope) => scope.required)
		.map((scope) => scope.name);
	const [scopePreset, setScopePreset] = useState<"read" | "full" | "custom">(
		"read",
	);
	const [organizations, setOrganizations] = useState<
		Array<{ id: string; name: string }>
	>([]);
	const [organizationsLoading, setOrganizationsLoading] =
		useState(multiOrganization);
	const [organizationsError, setOrganizationsError] = useState(false);
	const [organizationsReload, setOrganizationsReload] = useState(0);
	const [selectedTenantIds, setSelectedTenantIds] = useState<string[]>([]);
	const [directoryReload, setDirectoryReload] = useState(0);
	const [workspaceDirectory, setWorkspaceDirectory] = useState<{
		eligibleTenants: Set<string> | null;
		error: boolean;
	} | null>(null);
	useEffect(() => {
		if (!multiOrganization) return;
		let active = true;
		setWorkspaceDirectory({
			eligibleTenants: null,
			error: false,
		});
		void osApi.directory
			.listMyWorkspaces({ limit: 100, offset: 0 })
			.then((result) => {
				if (!active) return;
				setWorkspaceDirectory({
					eligibleTenants: new Set(
						result.data
							.filter(
								(workspace) =>
									workspace.org.provisionComplete &&
									workspace.surfaces.some(
										(surface) =>
											surface.surface === "mcp" &&
											surface.provisioned &&
											Boolean(surface.canonicalUrl),
									),
							)
							.map((workspace) => workspace.org.descopeTenantId)
							.filter((id): id is string => Boolean(id)),
					),
					error: false,
				});
			})
			.catch(() => {
				if (active) {
					setWorkspaceDirectory({
						eligibleTenants: null,
						error: true,
					});
				}
			});
		return () => {
			active = false;
		};
	}, [multiOrganization, directoryReload]);
	const currentDirectory = workspaceDirectory;
	const eligibleTenants =
		currentDirectory?.eligibleTenants ?? new Set<string>();
	const directoryLoading =
		!currentDirectory?.eligibleTenants && !currentDirectory?.error;
	const directoryError = Boolean(currentDirectory?.error);
	const visibleOrganizations = organizations.filter((organization) =>
		eligibleTenants.has(organization.id),
	);
	const bulkOrganizationIds = firstConsentOrganizationIds(visibleOrganizations);
	const selectedOrganizationsValid = selectedTenantIds.every((id) =>
		visibleOrganizations.some((organization) => organization.id === id),
	);
	useEffect(() => {
		if (!multiOrganization) return;
		let active = true;
		setOrganizations([]);
		setSelectedTenantIds([]);
		if (!currentDirectory?.eligibleTenants) {
			setOrganizationsLoading(false);
			setOrganizationsError(false);
			return;
		}
		const eligibleTenantIds = [...currentDirectory.eligibleTenants];
		if (eligibleTenantIds.length === 0) {
			setOrganizationsLoading(false);
			setOrganizationsError(false);
			return;
		}
		setOrganizationsLoading(true);
		setOrganizationsError(false);
		void (async () => {
			const tenants: Array<{ id: string; name: string }> = [];
			// Descope rejects myTenants requests containing more than ten IDs.
			for (let offset = 0; offset < eligibleTenantIds.length; offset += 10) {
				if (!active) return [];
				const result = await descope.myTenants(
					eligibleTenantIds.slice(offset, offset + 10),
				);
				if (!result.ok || !result.data) {
					throw new Error("Organization lookup unavailable");
				}
				tenants.push(...result.data.tenants);
			}
			return tenants;
		})()
			.then((tenants) => {
				if (!active) return;
				setOrganizations(tenants.map(({ id, name }) => ({ id, name })));
				setOrganizationsError(false);
				setOrganizationsLoading(false);
			})
			.catch(() => {
				if (active) {
					setOrganizations([]);
					setOrganizationsError(true);
					setOrganizationsLoading(false);
				}
			});
		return () => {
			active = false;
		};
	}, [
		descope,
		multiOrganization,
		organizationsReload,
		currentDirectory?.eligibleTenants,
	]);
	const [organizationName, setOrganizationName] = useState<string | null>(null);
	useEffect(() => {
		if (!tenant) return;
		let active = true;
		void descope
			.myTenants([tenant])
			.then((result) => {
				if (!active || !result.ok || !result.data) return;
				setOrganizationName(
					result.data.tenants.find((candidate) => candidate.id === tenant)
						?.name ?? null,
				);
			})
			.catch(() => {
				// The consent decision remains available if the name lookup fails.
			});
		return () => {
			active = false;
		};
	}, [descope, tenant]);
	const [submitting, setSubmitting] = useState<"authorize" | "cancel" | null>(
		null,
	);
	const submissionStarted = useRef(false);
	const [completionDelayed, setCompletionDelayed] = useState(false);
	const [decisionError, setDecisionError] = useState<string | null>(null);
	useEffect(() => {
		if (!submitting) return;
		const timeout = window.setTimeout(() => setCompletionDelayed(true), 15_000);
		return () => window.clearTimeout(timeout);
	}, [submitting]);
	const continueFlow = async (
		kind: "authorize" | "cancel",
		interactionId: string,
	) => {
		if (submissionStarted.current) return;
		submissionStarted.current = true;
		setSubmitting(kind);
		setDecisionError(null);
		let consentRevision: string | undefined;
		if (kind === "authorize") {
			if (!clientId || !resourceUrl || (!multiOrganization && !tenant)) {
				setDecisionError(
					"This access request is incomplete. Return to the application and try again.",
				);
				submissionStarted.current = false;
				setSubmitting(null);
				return;
			}
			try {
				if (kind === "authorize") {
					const staged = await osApi.organizations.stageMultiOrgMcpConsent({
						clientId,
						resourceUrl,
						selectedTenantIds: multiOrganization
							? selectedTenantIds
							: [tenant!],
						approvedScopes: approvedPermissions
							.filter(
								(scope) =>
									!["openid", "offline_access", "profile", "email"].includes(
										scope.name,
									),
							)
							.map((scope) => scope.name),
					});
					consentRevision = staged.revision;
				}
			} catch (error) {
				setDecisionError(inboundConsentDecisionError(error));
				submissionStarted.current = false;
				setSubmitting(null);
				return;
			}
		}
		const flowError = await advanceInboundConsentFlow(
			state.next,
			interactionId,
			consentForm(
				state.context,
				approvedPermissions,
				multiOrganization
					? selectedTenantIds
					: kind === "authorize"
						? [tenant!]
						: undefined,
				consentRevision,
			),
		);
		if (flowError) onFlowError(flowError);
		// The SDK owns the following screens and redirect. Keep the interaction
		// disabled until this screen unmounts; resolving next is not CLI completion.
	};

	return (
		<main className="consent-page">
			<Card className="w-full max-w-170">
				<CardHeader className="gap-2.5">
					<TedixBrandMark />
					<CardTitle>
						{multiOrganization && step === "organizations"
							? "Choose organizations"
							: step === "review"
								? "Review access"
								: "Choose permissions"}
					</CardTitle>
					<Text role="body" tone="secondary">
						{step === "permissions"
							? "Choose what this application can do."
							: step === "organizations"
								? "Choose where it can access your data."
								: "This application will have only the access shown below."}
					</Text>
					{clientId ? (
						<details>
							<summary className="cursor-pointer text-kumo-subtle">
								Application details
							</summary>
							<Text role="body" tone="secondary" className="break-all">
								Application ID: {clientId}
							</Text>
						</details>
					) : null}
					{user?.email ? (
						<Text role="body" tone="secondary">
							Signed in as {user.email}
						</Text>
					) : null}
					{tenant && !multiOrganization ? (
						<Text role="body" weight="semibold">
							Organization: {organizationName ?? tenant}
						</Text>
					) : null}
				</CardHeader>
				<CardContent className="grid gap-3">
					{decisionError ? (
						<Text role="body" tone="error">
							{decisionError}
						</Text>
					) : null}
					{step === "permissions" ? (
						<>
							<Text role="body">
								You can change permissions later by reconnecting this
								application.
							</Text>
							<div className="flex flex-wrap gap-2">
								<Button
									variant={scopePreset === "read" ? "default" : "outline"}
									aria-pressed={scopePreset === "read"}
									onClick={() => {
										setScopePreset("read");
										setSelectedScopes(
											selectConsentPreset(selectableScopes, "read"),
										);
									}}
								>
									{isReadOnlyConsentSelection(
										selectConsentPreset(selectableScopes, "read"),
									)
										? "Read only"
										: "Read and required access"}
								</Button>
								<Button
									variant={scopePreset === "full" ? "default" : "outline"}
									aria-pressed={scopePreset === "full"}
									onClick={() => {
										setScopePreset("full");
										setSelectedScopes(
											selectableScopes.map((scope) => scope.name),
										);
									}}
								>
									All requested
								</Button>
								<Button
									variant={scopePreset === "custom" ? "default" : "outline"}
									aria-pressed={scopePreset === "custom"}
									onClick={() => setScopePreset("custom")}
								>
									Custom
								</Button>
								<Button
									variant="ghost"
									onClick={() => {
										setScopePreset("custom");
										setSelectedScopes(requiredScopes);
									}}
								>
									Deselect all
								</Button>
							</div>
							<Text role="label" tone="secondary">
								{selectedScopes.length} of {selectableScopes.length} selected
							</Text>
							<ConsentPermissionGroups
								permissions={selectableScopes}
								selectedScopes={selectedScopes}
								onSelectionChange={(scopes) => {
									setScopePreset("custom");
									setSelectedScopes(scopes);
								}}
							/>
							{platformPermission && platformEligible ? (
								<div className="grid gap-2">
									<Checkbox
										label="Platform administration"
										checked={platformAdministration}
										onCheckedChange={(checked) =>
											setPlatformAdministration(checked === true)
										}
									/>
									<Text role="body" tone="secondary">
										Administer the Tedix platform across organizations. This
										requires your platform administrator role and separate
										approval.
									</Text>
								</div>
							) : null}
							<div className="flex justify-end gap-2 pt-2">
								<Button
									variant="outline"
									disabled={Boolean(submitting)}
									onClick={() =>
										void continueFlow(
											"cancel",
											INBOUND_CONSENT_CANCEL_INTERACTION,
										)
									}
								>
									Cancel
								</Button>
								<Button
									disabled={selectedScopes.length === 0}
									onClick={() =>
										setStep(multiOrganization ? "organizations" : "review")
									}
								>
									{multiOrganization ? "Choose organizations" : "Review access"}
								</Button>
							</div>
						</>
					) : multiOrganization && step === "organizations" ? (
						<>
							<Text role="body">Select the organizations to include.</Text>
							<Text role="label" tone="secondary">
								{selectedTenantIds.length} selected · Up to 10
							</Text>
							<div className="flex flex-wrap gap-2">
								<Button
									variant="outline"
									disabled={
										bulkOrganizationIds.length === 0 ||
										JSON.stringify(bulkOrganizationIds).length > 500 ||
										Boolean(submitting)
									}
									onClick={() => setSelectedTenantIds(bulkOrganizationIds)}
								>
									{visibleOrganizations.length > 10
										? "Select first 10"
										: "Select all current"}
								</Button>
								<Button
									variant="ghost"
									disabled={
										selectedTenantIds.length === 0 || Boolean(submitting)
									}
									onClick={() => setSelectedTenantIds([])}
								>
									Clear selection
								</Button>
							</div>
							<Text role="body" tone="secondary">
								Organizations you join later are not included.
							</Text>
							{organizationsLoading || directoryLoading ? (
								<Text role="body" tone="secondary">
									Loading your organizations…
								</Text>
							) : null}
							{organizationsError || directoryError ? (
								<Text role="body" tone="error">
									Could not load your organizations. Please try again.
								</Text>
							) : null}
							{organizationsError || directoryError ? (
								<Button
									variant="outline"
									onClick={() => {
										setOrganizationsReload((count) => count + 1);
										setDirectoryReload((count) => count + 1);
									}}
								>
									Retry
								</Button>
							) : null}
							{visibleOrganizations.map((organization) => (
								<Checkbox
									key={organization.id}
									checked={selectedTenantIds.includes(organization.id)}
									disabled={
										Boolean(submitting) ||
										(!selectedTenantIds.includes(organization.id) &&
											selectedTenantIds.length >= 10)
									}
									onCheckedChange={(checked) =>
										setSelectedTenantIds((current) =>
											checked
												? current.includes(organization.id)
													? current
													: [...current, organization.id]
												: current.filter((id) => id !== organization.id),
										)
									}
									label={organization.name}
								/>
							))}
							{!organizationsLoading &&
							!directoryLoading &&
							!organizationsError &&
							!directoryError &&
							visibleOrganizations.length === 0 ? (
								<Text role="body" tone="error">
									No eligible organizations were found for this account.
								</Text>
							) : null}
							<div className="flex justify-end gap-2 pt-2">
								<Button
									variant="outline"
									onClick={() => setStep("permissions")}
								>
									Back
								</Button>
								<Button
									disabled={
										selectedTenantIds.length === 0 ||
										!selectedOrganizationsValid ||
										selectedTenantIds.length > 10 ||
										JSON.stringify(selectedTenantIds).length > 500
									}
									onClick={() => setStep("review")}
								>
									Review access
								</Button>
							</div>
						</>
					) : (
						<>
							<div className="flex items-start justify-between gap-3">
								<Text role="body" tone="secondary">
									You can remove this access at any time in Connected
									applications.
								</Text>
								<Badge className="shrink-0" variant="secondary">
									{isReadOnlyConsentSelection(
										approvedPermissions.map((scope) => scope.name),
									)
										? "Read only"
										: "Selected access"}
								</Badge>
							</div>
							<ConsentPermissionGroups permissions={approvedPermissions} />
							{multiOrganization
								? visibleOrganizations
										.filter((organization) =>
											selectedTenantIds.includes(organization.id),
										)
										.map((organization) => (
											<Text key={organization.id} role="body">
												{organization.name}
											</Text>
										))
								: null}
							{submitting ? (
								<div role="status">
									<Text role="body" tone="secondary">
										{submitting === "cancel"
											? completionDelayed
												? "Cancellation is taking longer than expected. Return to the application that requested access to check the result."
												: "Completing cancellation. Return to the application that requested access to check the result."
											: completionDelayed
												? "Authorization is taking longer than expected. Return to the application that requested access to check the result before starting a new login. Your consent may already have been recorded."
												: "Completing your request. Wait for the application that requested access to confirm authorization."}
									</Text>
								</div>
							) : null}
							<div className="flex justify-end gap-2.5 pt-2">
								{
									<Button
										variant="ghost"
										disabled={Boolean(submitting)}
										onClick={() =>
											setStep(
												multiOrganization ? "organizations" : "permissions",
											)
										}
									>
										Back
									</Button>
								}
								<Button
									variant="outline"
									disabled={Boolean(submitting)}
									onClick={() =>
										void continueFlow(
											"cancel",
											INBOUND_CONSENT_CANCEL_INTERACTION,
										)
									}
								>
									{submitting === "cancel" ? "Cancelling…" : "Cancel"}
								</Button>
								<Button
									disabled={
										Boolean(submitting) ||
										selectedScopes.length === 0 ||
										(multiOrganization &&
											(selectedScopes.length === 0 ||
												selectedTenantIds.length === 0 ||
												!selectedOrganizationsValid))
									}
									onClick={() =>
										void continueFlow(
											"authorize",
											INBOUND_CONSENT_AUTHORIZE_INTERACTION,
										)
									}
								>
									{submitting === "authorize" ? "Authorizing…" : "Authorize"}
								</Button>
							</div>
						</>
					)}
				</CardContent>
			</Card>
		</main>
	);
}

/** Keep the OAuth transaction identifier across the product-session bounce. */
export function inboundConsentBrokerReturnPath(locationUrl: string): string {
	const destination = new URL(buildOsAuthReturnUrl(locationUrl));
	// A provider callback code is single-use and must never be replayed.
	destination.searchParams.delete("code");
	return `${destination.pathname}${destination.search}`;
}

function BrokerReadyConsentScreen({
	returnPath,
	...screenProps
}: {
	returnPath: string;
	state: ConsentScreenState;
	tenant?: string;
	clientId: string | null;
	resourceUrl: string | null;
	onFlowError: (error: unknown) => void;
}) {
	const { user } = useUser();
	const consentEmail =
		typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
	const [brokerState, setBrokerState] = useState<
		"checking" | "authenticated" | "redirecting" | "unavailable"
	>("checking");
	const [authenticatedEmail, setAuthenticatedEmail] = useState<string | null>(
		null,
	);
	useEffect(() => {
		let active = true;
		void fetch("/auth/session-broker/status", {
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(OS_BROKER_STATUS_TIMEOUT_MS),
		})
			.then(async (response) => {
				if (!response.ok && response.status !== 401) {
					throw new Error("Broker status unavailable");
				}
				const status = (await response.json()) as {
					authenticated?: unknown;
					user?: { email?: unknown };
				};
				if (!active) return;
				if (response.ok && status.authenticated === true) {
					const brokerEmail =
						typeof status.user?.email === "string"
							? status.user.email.trim().toLowerCase()
							: "";
					setAuthenticatedEmail(
						consentEmail && brokerEmail === consentEmail ? consentEmail : null,
					);
					setBrokerState(
						consentEmail && brokerEmail === consentEmail
							? "authenticated"
							: "unavailable",
					);
					return;
				}
				const stateId = new URL(
					returnPath,
					window.location.origin,
				).searchParams.get("third_party_app_state_id");
				const guardKey = `${INBOUND_CONSENT_BROKER_GUARD_PREFIX}${stateId && stateId.length <= 512 ? stateId : "unknown"}`;
				const currentUrl = new URL(window.location.href);
				if (
					currentUrl.searchParams.has("error") ||
					isDescopeFlowContinuation(currentUrl.href)
				) {
					setBrokerState("unavailable");
					return;
				}
				try {
					if (window.sessionStorage.getItem(guardKey) !== null) {
						setBrokerState("unavailable");
						return;
					}
					window.sessionStorage.setItem(guardKey, "1");
				} catch {
					setBrokerState("unavailable");
					return;
				}
				setBrokerState("redirecting");
				window.location.replace(
					buildBrokerStartPath("/auth/session-broker", {
						redirectTo: returnPath,
					}),
				);
			})
			.catch(() => {
				if (active) setBrokerState("unavailable");
			});
		return () => {
			active = false;
		};
	}, [consentEmail, returnPath]);
	if (
		brokerState === "authenticated" &&
		consentEmail &&
		authenticatedEmail === consentEmail
	) {
		return <GroupedConsentScreen {...screenProps} />;
	}
	return (
		<IdentityJourneyFrame
			title="Authorize access"
			description={
				brokerState === "unavailable"
					? "Your Tedix sign-in could not be prepared. Return to the application and try again."
					: "Preparing your Tedix workspace authorization…"
			}
			loading={brokerState !== "unavailable"}
		>
			{null}
		</IdentityJourneyFrame>
	);
}

function InboundConsentFlow() {
	const descope = useDescope();
	const brokerReturnPath = useRef(
		inboundConsentBrokerReturnPath(window.location.href),
	);
	const recoveryUrl = useRef(
		inboundConsentRecoveryUrl(
			window.location.href,
			document.referrer,
			window.sessionStorage,
		),
	);
	const callbackUrl = useRef(
		inboundConsentCallbackUrl(window.location.href, recoveryUrl.current),
	);
	const clientReference = useRef(
		inboundConsentClientReference(recoveryUrl.current, window.location.href),
	);
	const tenant = useMemo(() => inboundConsentTenant(window.location.href), []);
	const flowId = useMemo(() => inboundConsentFlowId(window.location.href), []);
	const [customScreen, setCustomScreen] =
		useState<InboundCustomScreenState | null>(null);
	const [flowError, setFlowError] = useState<InboundConsentFlowFailure | null>(
		null,
	);
	const [recovering, setRecovering] = useState(false);
	const onScreenUpdate = useCallback(
		(
			screenName: string,
			context: Record<string, unknown>,
			next: DescopeFlowNext,
		) => {
			const contract = resolveDescopePasswordScreen(flowId, screenName);
			if (contract) {
				// Wrong-password context errors are retryable on this exact screen;
				// they are not a failed OAuth finish or invalid refresh family.
				setCustomScreen({ kind: "password", contract, context, next });
				return true;
			}
			const contextError = inboundConsentContextError(context);
			if (contextError) {
				setCustomScreen(null);
				setFlowError(inboundConsentFlowFailure(contextError));
				return true;
			}
			if (isTedixByosLoginScreen(screenName)) {
				setCustomScreen({
					kind: "login",
					context: context as DescopeByosContext,
					next,
				});
				return true;
			}
			if (screenName === DESCOPE_OTP_SCREEN_NAME) {
				setCustomScreen({
					kind: "otp",
					context: context as DescopeByosContext,
					next,
				});
				return true;
			}
			if (!INBOUND_CONSENT_SCREEN_NAMES.has(screenName)) {
				setCustomScreen(null);
				return false;
			}
			const scopes = inboundConsentRequestedPermissions(context);
			if (!scopes) {
				setCustomScreen(null);
				setFlowError("lost-request");
				return true;
			}
			setCustomScreen({ kind: "consent", context, next, scopes });
			return true;
		},
		[flowId],
	);
	const recoverSession = async () => {
		if (recovering) return;
		setRecovering(true);
		if (flowError === "invalid-session") {
			try {
				// Clear only a known-invalid refresh family before replaying the original
				// immutable authorization transaction. An OAuth-code failure does not
				// invalidate an otherwise healthy central browser session.
				await descope.logout();
			} catch {
				// Logout is best-effort when the family is already invalid.
			}
		}
		window.location.replace(recoveryUrl.current ?? "/account/organizations");
	};

	if (flowError) {
		return (
			<IdentityJourneyFrame
				title={
					flowError === "invalid-session"
						? "Sign in again to authorize"
						: flowError === "expired-callback"
							? "Authorization request expired"
							: flowError === "lost-request"
								? "Restart this authorization"
								: "Authorization could not continue"
				}
				description={
					flowError === "lost-request"
						? recoveryUrl.current
							? "This page was reloaded or reopened, so the requested permissions are no longer available. Nothing was approved. Retry to load the original request again."
							: "This page was reloaded or reopened, so the requested permissions are no longer available. Nothing was approved. Start the connection again from the application that requested access."
						: flowError === "invalid-session"
							? "Your sign-in session is no longer valid. Authorization could not finish; consent may already have been recorded. Sign in again to resume this request."
							: flowError === "expired-callback"
								? recoveryUrl.current
									? "This one-time sign-in callback was already used or expired. Return to the application that requested access to check the result before retrying the preserved authorization request."
									: "This one-time sign-in callback was already used or expired. Return to the application that requested access to check the result. If login did not complete, start a new login."
								: "Authorization could not finish. Consent may already have been recorded. Return to the application that requested access to check the result before retrying."
				}
			>
				<Button disabled={recovering} onClick={() => void recoverSession()}>
					{recovering
						? "Preparing authorization…"
						: recoveryUrl.current
							? flowError === "invalid-session"
								? "Sign in and retry"
								: "Retry authorization"
							: "Return to Tedix OS"}
				</Button>
			</IdentityJourneyFrame>
		);
	}

	return (
		<>
			<div hidden={Boolean(customScreen)}>
				<IdentityJourneyFrame
					title="Authorize access"
					description="Sign in to review the access requested by this application."
				>
					<Descope
						flowId={flowId}
						tenant={tenant}
						redirectUrl={callbackUrl.current}
						onScreenUpdate={onScreenUpdate}
						onError={(event) =>
							setFlowError(inboundConsentFlowFailure(event.detail))
						}
					/>
				</IdentityJourneyFrame>
			</div>
			{customScreen?.kind === "login" ? (
				<IdentityJourneyFrame
					title="Authorize access"
					description="Sign in to review the access requested by this application."
				>
					<TedixByosLoginScreen
						context={customScreen.context}
						interactions={DESCOPE_LOGIN_INTERACTIONS[flowId]}
						next={customScreen.next}
					/>
				</IdentityJourneyFrame>
			) : null}
			{customScreen?.kind === "password" ? (
				<IdentityJourneyFrame
					title="Authorize access"
					description="Sign in to review the access requested by this application."
				>
					<TedixByosPasswordScreen
						key={customScreen.contract.mode}
						{...customScreen}
					/>
				</IdentityJourneyFrame>
			) : null}
			{customScreen?.kind === "otp" ? (
				<IdentityJourneyFrame
					title="Check your email"
					description="Verify your email to continue reviewing this access request."
				>
					<TedixByosOtpScreen
						context={customScreen.context}
						next={customScreen.next}
					/>
				</IdentityJourneyFrame>
			) : null}
			{customScreen?.kind === "consent" ? (
				<BrokerReadyConsentScreen
					key={JSON.stringify(customScreen.scopes)}
					returnPath={brokerReturnPath.current}
					state={customScreen}
					tenant={tenant}
					clientId={clientReference.current}
					resourceUrl={inboundConsentResourceUrl(callbackUrl.current)}
					onFlowError={(error) =>
						setFlowError(inboundConsentFlowFailure(error))
					}
				/>
			) : null}
		</>
	);
}

function SessionReadyInboundConsent() {
	const descope = useDescope();
	const [ready, setReady] = useState(false);
	useEffect(() => {
		let active = true;
		// One forced refresh hydrates the consent session from the auth-host
		// HttpOnly refresh cookie (the SDK persists nothing client-side, so
		// there is no app-host copy to guard against) and advances the central
		// broker lineage before the inbound-app flow takes over.
		void descope.refresh(undefined, false).finally(() => {
			if (active) setReady(true);
		});
		return () => {
			active = false;
		};
	}, [descope]);
	if (!ready) {
		return (
			<main className="centered-state" aria-busy="true">
				<TedixBrandMark />
				<p>Preparing your Tedix workspace authorization…</p>
			</main>
		);
	}
	return <InboundConsentFlow />;
}

export function InboundConsentPage() {
	useDocumentTitle("Authorize access · Tedix");
	// The serialized bootstrap owns the one Descope refresh needed to hydrate
	// consent, then the inbound-app flow owns the transaction through finish.
	return (
		<TedixDescopeProvider>
			<SessionReadyInboundConsent />
		</TedixDescopeProvider>
	);
}
