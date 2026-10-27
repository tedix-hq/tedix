import { WorkspaceAppRenderer } from "@/components/workspace-app-renderer";
import { ORGANIZATION_DOMAIN_ENTRY } from "@tedix/api-contract/schemas/organization-domains";
import { WebPushSettings } from "@/components/web-push-settings";
import type {
	OrganizationPermission,
	OsCallerAuthority,
	OsUserPreferences,
	OsUserPreferencesState,
} from "@tedix/api-contract/schemas/user-settings";
import type { AiGatewayAdmissionPolicy } from "@tedix/api-contract/schemas/tedi";
import { resolveOsTenant } from "@/shared/os-tenant";
import {
	CaretRight,
	Desktop,
	Eye,
	Globe,
	Key,
	Moon,
	Plug,
	Rows,
	SignOut,
	Sun,
	UserCircle,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { CodeInline } from "@/components/kumo/code";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { SettingsRow, SettingsRows } from "@/components/settings-row";
import { OsRouterLink } from "@/components/kumo/link-provider";
import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { PersonalAgentValue } from "@/components/personal-agent-value";
import {
	runtimeEntitlementsQueryOptions,
	userConnectionsQueryOptions,
} from "@/lib/os-query-options";
import { useOsFormattingPreferences, formatCount } from "@/lib/format";
import { absoluteTime } from "@/lib/time";
import { useOsIdentity } from "@/lib/use-os-identity";
import {
	isRevisionConflict,
	useOsOperationalContext,
	useOsPreferences,
} from "@/lib/use-os-preferences";

declare const __LOCAL_DEMO_ENABLED__: boolean;
declare const __LOCAL_INFERENCE_ENABLED__: boolean;

import { OS_LOGOUT_PATH } from "@/shared/session-status";

const THEME_OPTIONS = [
	{
		value: "system",
		label: (
			<>
				<Desktop size={14} /> System
			</>
		),
	},
	{
		value: "light",
		label: (
			<>
				<Sun size={14} /> Light
			</>
		),
	},
	{
		value: "dark",
		label: (
			<>
				<Moon size={14} /> Dark
			</>
		),
	},
] as const;

const DENSITY_OPTIONS = [
	{ value: "comfortable", label: "Comfortable" },
	{ value: "compact", label: "Compact" },
] as const;

const MOTION_OPTIONS = [
	{ value: "system", label: "System" },
	{ value: "full", label: "Full" },
	{ value: "reduced", label: "Reduced" },
] as const;

const CONTRAST_OPTIONS = [
	{ value: "system", label: "System" },
	{ value: "high", label: "High" },
] as const;

/**
 * Regional options kept to a short, real list rather than the full ~800-zone
 * IANA database: the contract validates any canonical tag/zone, so this is a
 * convenience menu, not the boundary.
 */
const LOCALE_OPTIONS = [
	{ value: "en-US", label: "English (United States)" },
	{ value: "en-GB", label: "English (United Kingdom)" },
	{ value: "es-MX", label: "Español (México)" },
	{ value: "es-ES", label: "Español (España)" },
	{ value: "pt-BR", label: "Português (Brasil)" },
	{ value: "fr-FR", label: "Français (France)" },
	{ value: "de-DE", label: "Deutsch (Deutschland)" },
] as const;

const TIMEZONE_OPTIONS = [
	"America/Mexico_City",
	"America/New_York",
	"America/Chicago",
	"America/Denver",
	"America/Los_Angeles",
	"America/Sao_Paulo",
	"Europe/London",
	"Europe/Madrid",
	"Europe/Berlin",
	"Asia/Tokyo",
	"Asia/Singapore",
	"Australia/Sydney",
	"UTC",
].map((value) => ({ value, label: value }));

const FOLLOW_SYSTEM = "__system__";

function RegionalSelect({
	label,
	value,
	options,
	onValueChange,
}: {
	label: string;
	value: string | null;
	options: readonly { value: string; label: string }[];
	onValueChange: (value: string | null) => void;
}) {
	return (
		<Select
			value={value ?? FOLLOW_SYSTEM}
			onValueChange={(next) =>
				onValueChange(next === FOLLOW_SYSTEM ? null : String(next))
			}
		>
			<SelectTrigger
				aria-label={label}
				className="min-h-7 w-full max-w-full py-1 data-[size=sm]:h-auto sm:w-60"
				size="sm"
			>
				<SelectValue className="whitespace-normal text-clip [overflow-wrap:anywhere]">
					{(next) =>
						next === FOLLOW_SYSTEM
							? "Follow browser"
							: (options.find((option) => option.value === next)?.label ??
								String(next))
					}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={FOLLOW_SYSTEM}>Follow browser</SelectItem>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * The save button's state, kept explicit so "nothing changed", "saving" and
 * "the store moved under you" never collapse into one disabled button with no
 * explanation.
 */
type SaveState = "clean" | "dirty" | "saving" | "conflict" | "error";

export function saveState(input: {
	dirty: boolean;
	isPending: boolean;
	error: unknown;
}): SaveState {
	if (input.isPending) return "saving";
	if (input.error)
		return isRevisionConflict(input.error) ? "conflict" : "error";
	return input.dirty ? "dirty" : "clean";
}

/**
 * How a stored preference set is described. A profile that has never been
 * saved must not read as a set of deliberate choices, so the two are worded
 * differently and the timestamp only appears when there is a real write.
 */
export function preferenceOrigin(
	state: OsUserPreferencesState,
	localEvaluation = false,
): string {
	if (state.source === "default" && state.revision === 0) {
		return localEvaluation
			? "Local defaults — nothing saved to this isolated profile yet."
			: "Platform defaults — nothing saved to your profile yet.";
	}
	if (state.source === "default") {
		return "Stored preferences could not be read and platform defaults are shown; saving replaces them.";
	}
	return `Saved to ${localEvaluation ? "this isolated local profile" : "your Tedix profile"}${
		state.updatedAt ? ` · ${absoluteTime(state.updatedAt)}` : ""
	}.`;
}

export function inferenceAdmissionLabel(input: {
	active: boolean;
	localEvaluation: boolean;
	localInferenceEnabled: boolean;
}): string {
	if (!input.active) return "AI is blocked";
	if (!input.localEvaluation) return "AI is available";
	return input.localInferenceEnabled
		? "Paid remote AI is enabled for this local session"
		: "AI replies are off in this local session";
}

/** Summarize the organization policy shown in Workspace context. */
export function modelPolicySummary(
	policy: AiGatewayAdmissionPolicy | null,
): string {
	const parts = [
		policy?.allowedModelTiers?.length
			? `Models: ${policy.allowedModelTiers.join(" · ")}`
			: "Any model allowed",
	];
	if (policy?.dailyTokenLimit !== undefined) {
		parts.push(`${formatCount(policy.dailyTokenLimit)} tokens/day`);
	}
	if (policy?.dailySpendLimitMicros !== undefined) {
		parts.push(`$${(policy.dailySpendLimitMicros / 1_000_000).toFixed(2)}/day`);
	}
	return parts.join(" · ");
}

/**
 * What the four assignable membership roles let a person do, in one sentence
 * each. `authority.role` is a free-form membership value — custom roles exist
 * in the identity provider — so anything outside this map is summarized from
 * the granted capabilities instead. The exact codes stay under Technical
 * details in the rendered row.
 */
const ROLE_SUMMARIES: Record<string, string> = {
	owner: "You can manage this organization, including billing and members.",
	admin: "You can manage this organization, except billing.",
	member:
		"You can do everyday work and build apps here. An owner or admin manages members, settings, and billing.",
	viewer: "You can view this organization's work, but you can't make changes.",
};

function joinPhrases(phrases: readonly string[]): string {
	if (phrases.length <= 2) return phrases.join(" and ");
	return `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}`;
}

function capabilityPhrases(permissions: readonly string[]): string[] {
	const has = (...codes: OrganizationPermission[]) =>
		codes.some((code) => permissions.includes(code));
	const phrases: string[] = [];
	if (has("apps:create", "apps:update", "apps:delete"))
		phrases.push("manage apps");
	else if (has("apps:read")) phrases.push("view apps");
	if (has("tedis:create", "tedis:update", "tedis:delete"))
		phrases.push("manage agents");
	else if (has("tedis:read")) phrases.push("view agents");
	if (has("os:admin")) phrases.push("administer the OS");
	else if (has("os:publish", "os:approve"))
		phrases.push("publish and approve work in the OS");
	else if (has("os:author")) phrases.push("build apps and work in the OS");
	else if (has("os:run")) phrases.push("run work in the OS");
	else if (has("os:read")) phrases.push("use the OS");
	if (has("team:manage")) phrases.push("manage members and roles");
	else if (has("team:read")) phrases.push("view members");
	if (
		has(
			"settings:manage",
			"secrets:manage",
			"integrations:manage",
			"api_keys:manage",
		)
	)
		phrases.push("manage organization settings, keys, and integrations");
	if (has("billing:manage")) phrases.push("manage billing");
	else if (has("billing:read")) phrases.push("view billing");
	if (has("analytics:read")) phrases.push("view analytics");
	if (has("catalog:manage")) phrases.push("manage the app catalog");
	if (has("platform:admin")) phrases.push("administer the platform");
	return phrases;
}

/**
 * What the caller's role allows, in plain words: a hand-written sentence for
 * the known roles, a capability summary for a custom role, and an honest
 * statement for machine or permissionless sign-ins.
 */
export function authoritySummary(authority: OsCallerAuthority): string {
	const role = authority.role?.toLowerCase();
	if (role && ROLE_SUMMARIES[role]) return ROLE_SUMMARIES[role];
	if (authority.permissions.length > 0) {
		const phrases = capabilityPhrases(authority.permissions);
		if (phrases.length > 0) return `You can ${joinPhrases(phrases)}.`;
	}
	if (authority.authType === "tedi") {
		return "This is an agent identity — its access comes from its granted capabilities.";
	}
	if (authority.machineScopes.length > 0) {
		return "This is a machine sign-in; its access is set by the scopes under Technical details.";
	}
	return "This sign-in has no permissions in this workspace.";
}

/** Injectable-link seam for tests that render without a RouterProvider. */
type TeamMembersLinkProps = {
	to:
		| "/team"
		| "/admin/organization"
		| "/admin/billing"
		| "/account/connections";
	search?: { tab: "members" };
	className?: string;
	children?: ReactNode;
};
const DefaultTeamMembersLink: ComponentType<TeamMembersLinkProps> =
	OsRouterLink;

/**
 * The plain-English access summary is what a person reads first; the exact
 * role value, credential type, permission codes, and machine scopes stay
 * reachable under Technical details instead of fronting the row.
 */
function AuthorityDescription({ authority }: { authority: OsCallerAuthority }) {
	const details: Array<[string, string]> = [];
	if (authority.role) details.push(["Role", authority.role]);
	if (authority.authType) details.push(["Sign-in type", authority.authType]);
	if (authority.permissions.length > 0)
		details.push(["Permissions", authority.permissions.join(" · ")]);
	if (authority.machineScopes.length > 0)
		details.push(["Machine scopes", authority.machineScopes.join(" · ")]);
	return (
		<div className="grid gap-1">
			<span>{authoritySummary(authority)}</span>
			{details.length > 0 && (
				<Collapsible>
					<CollapsibleTrigger className="group/disclosure -mx-2 w-fit px-2">
						<CaretRight
							aria-hidden
							className="transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
							size={12}
						/>
						Technical details
					</CollapsibleTrigger>
					<CollapsibleContent>
						<dl className="m-0 mt-1 grid gap-2">
							{details.map(([label, value]) => (
								<div className="grid gap-0.5" key={label}>
									<dt className="text-kumo-subtle">{label}</dt>
									<dd className="m-0 break-words font-mono text-xs text-kumo-default">
										{value}
									</dd>
								</div>
							))}
						</dl>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

function OperationalContextSection({
	localEvaluation,
	localInferenceEnabled,
	MembersLinkComponent = DefaultTeamMembersLink,
}: {
	localEvaluation: boolean;
	localInferenceEnabled: boolean;
	MembersLinkComponent?: ComponentType<TeamMembersLinkProps>;
}) {
	useOsFormattingPreferences();
	const context = useOsOperationalContext();
	const entitlement = useQuery({
		...runtimeEntitlementsQueryOptions(),
		staleTime: 60_000,
	});
	const connections = useQuery({
		...userConnectionsQueryOptions(),
		staleTime: 60_000,
	});

	const connected = connections.data?.data.filter(
		(connection) => connection.status === "connected",
	).length;

	return (
		<PageSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Workspace context</SectionTitle>
					<SectionDescription>
						{localEvaluation
							? "Sample workspace stored on this machine. It grants no production access."
							: "Your workspace, permissions, and usage. Open each page to make changes."}
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>

			{context.isPending && <ListSkeleton rows={2} rowClassName="h-20" />}
			{context.isError && (
				<Alert variant="destructive">
					<AlertTitle>Workspace context is unavailable</AlertTitle>
					<AlertDescription>
						{(context.error as Error).message}
					</AlertDescription>
				</Alert>
			)}

			{context.data && (
				<SettingsRows>
					<SettingsRow
						icon={UserCircle}
						title={context.data.organization.name}
						description={`${context.data.organization.slug} · ${
							context.data.organization.type === "personal"
								? "Personal workspace"
								: "Organization"
						}`}
					>
						<Badge variant={context.data.authority.role ? "info" : "outline"}>
							{context.data.authority.role ?? "No membership role"}
						</Badge>
					</SettingsRow>

					<SettingsRow
						icon={Key}
						title={
							localEvaluation ? "Seeded local capabilities" : "What you can do"
						}
						description={
							<AuthorityDescription authority={context.data.authority} />
						}
					>
						{context.data.authority.crossTenantOverrideActive && (
							<Badge variant="warning">Tenant override</Badge>
						)}
					</SettingsRow>

					<SettingsRow
						icon={Eye}
						title="Purpose charter"
						description={
							context.data.purpose.access === "restricted"
								? "Your role cannot read the charter. This is a permission boundary, not an empty charter."
								: context.data.purpose.charter
									? `Version ${context.data.purpose.charter.version} · ${context.data.purpose.charter.status} · review due ${absoluteTime(
											context.data.purpose.charter.reviewDueAt,
										)}`
									: "No charter authored for this workspace yet."
						}
					>
						<Button
							render={<MembersLinkComponent to="/admin/organization" />}
							size="sm"
							variant="outline"
						>
							Manage
						</Button>
					</SettingsRow>

					<SettingsRow
						icon={Globe}
						title="AI usage and limits"
						description={
							entitlement.isPending
								? "Loading AI usage…"
								: entitlement.isError
									? `Unavailable: ${(entitlement.error as Error).message}`
									: entitlement.data?.entitlement
										? `${entitlement.data.entitlement.planName} · ${inferenceAdmissionLabel(
												{
													active: entitlement.data.entitlement.active,
													localEvaluation,
													localInferenceEnabled,
												},
											)} · ${modelPolicySummary(entitlement.data.modelPolicy)}`
										: "No AI plan is set up — AI can't run in this workspace."
						}
					>
						<Button
							render={<MembersLinkComponent to="/admin/billing" />}
							size="sm"
							variant="outline"
						>
							Billing
						</Button>
					</SettingsRow>

					<SettingsRow
						icon={Plug}
						title="Connections"
						description={
							connections.isPending
								? "Reading your connections…"
								: connections.isError
									? localEvaluation
										? "Production OAuth connections and grants are intentionally not imported into the isolated local environment."
										: `Unavailable: ${(connections.error as Error).message}`
									: connected === undefined
										? "No connection state returned."
										: `${formatCount(connected)} connected of ${formatCount(
												connections.data?.data.length ?? 0,
											)} known to this workspace.`
						}
					>
						<Button
							render={<MembersLinkComponent to="/account/connections" />}
							size="sm"
							variant="outline"
						>
							Manage
						</Button>
					</SettingsRow>

					<SettingsRow
						icon={UserCircle}
						title="Members and roles"
						description="Invite people and manage roles on the Team page."
					>
						<Button
							render={
								<MembersLinkComponent search={{ tab: "members" }} to="/team" />
							}
							size="sm"
							variant="outline"
						>
							Members
						</Button>
					</SettingsRow>
				</SettingsRows>
			)}
		</PageSection>
	);
}

export function SettingsPage({
	MembersLinkComponent,
}: {
	MembersLinkComponent?: ComponentType<TeamMembersLinkProps>;
} = {}) {
	useOsFormattingPreferences();
	const identity = useOsIdentity();
	const operationalContext = useOsOperationalContext();
	const localEvaluation =
		__LOCAL_DEMO_ENABLED__ &&
		resolveOsTenant(window.location.hostname).kind === "local";
	const { query, save } = useOsPreferences();
	const [draft, setDraft] = useState<OsUserPreferences | null>(null);

	// The server row is the base. A refetch (including the one a conflict
	// triggers) replaces the draft, so the operator always edits from the values
	// that actually survived.
	const serverPreferences = query.data?.preferences;
	useEffect(() => {
		if (serverPreferences) setDraft(serverPreferences);
	}, [serverPreferences]);

	const dirty =
		draft !== null &&
		serverPreferences !== undefined &&
		JSON.stringify(draft) !== JSON.stringify(serverPreferences);
	const state = saveState({
		dirty,
		isPending: save.isPending,
		error: save.error,
	});

	function patch(next: Partial<OsUserPreferences>) {
		setDraft((current) => (current ? { ...current, ...next } : current));
	}

	return (
		<Page width="md">
			<PageHeader>
				<PageHeading>
					<PageTitle>Settings</PageTitle>
					<PageDescription>
						{localEvaluation
							? "Preferences are stored only locally on this machine."
							: "Your preferences sync across browsers in this workspace."}
					</PageDescription>
				</PageHeading>
			</PageHeader>

			{localEvaluation && (
				<Alert>
					<AlertTitle>Isolated local evaluation</AlertTitle>
					<AlertDescription>
						This preview uses sample data on this machine. Production accounts,
						secrets, and connections are separate.
					</AlertDescription>
				</Alert>
			)}

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Profile and appearance</SectionTitle>
						<SectionDescription>
							{query.data
								? preferenceOrigin(query.data, localEvaluation)
								: query.isError
									? "Refresh the page to try again."
									: "Loading your preferences…"}
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>

				{query.isError && (
					<Alert variant="destructive">
						<AlertTitle>Preferences could not be loaded</AlertTitle>
						<AlertDescription>
							{(query.error as Error).message}
						</AlertDescription>
					</Alert>
				)}
				{state === "conflict" && (
					<Alert variant="destructive">
						<AlertTitle>Someone else saved first</AlertTitle>
						<AlertDescription>
							Newer preferences have been loaded. Reapply your changes and save
							again.
						</AlertDescription>
					</Alert>
				)}
				{state === "error" && (
					<Alert variant="destructive">
						<AlertTitle>Preferences were not saved</AlertTitle>
						<AlertDescription>{(save.error as Error).message}</AlertDescription>
					</Alert>
				)}

				{query.isPending && <ListSkeleton rows={3} rowClassName="h-16" />}

				<div className="grid gap-4">
					<SettingsRows>
						<SettingsRow
							icon={UserCircle}
							title={identity.name}
							description={
								localEvaluation
									? `${identity.email} · deterministic local identity, not a signed-in Tedix account`
									: identity.email || "Signed in Tedix member"
							}
						>
							<Button
								render={<a href={OS_LOGOUT_PATH} />}
								size="sm"
								variant="outline"
							>
								<SignOut size={14} />
								Sign out
							</Button>
						</SettingsRow>
						{draft && (
							<>
								<SettingsRow
									icon={Desktop}
									title="Appearance"
									description="Follow your device or choose light or dark."
								>
									<SegmentedControl<OsUserPreferences["theme"]>
										ariaLabel="Appearance"
										className="p-1"
										compact
										onValueChange={(theme) => patch({ theme })}
										options={THEME_OPTIONS}
										value={draft.theme}
									/>
								</SettingsRow>
								<SettingsRow
									icon={Rows}
									title="Density"
									description="Choose how much space appears between items."
								>
									<SegmentedControl<OsUserPreferences["density"]>
										ariaLabel="Density"
										className="p-1"
										compact
										onValueChange={(density) => patch({ density })}
										options={DENSITY_OPTIONS}
										value={draft.density}
									/>
								</SettingsRow>
								<SettingsRow
									icon={Eye}
									title="Motion"
									description="System follows your device’s motion preference."
								>
									<SegmentedControl<
										OsUserPreferences["accessibility"]["motion"]
									>
										ariaLabel="Motion"
										className="p-1"
										compact
										onValueChange={(motion) =>
											patch({
												accessibility: { ...draft.accessibility, motion },
											})
										}
										options={MOTION_OPTIONS}
										value={draft.accessibility.motion}
									/>
								</SettingsRow>
								<SettingsRow
									icon={Eye}
									title="Contrast"
									description="Make borders and secondary text easier to see."
								>
									<SegmentedControl<
										OsUserPreferences["accessibility"]["contrast"]
									>
										ariaLabel="Contrast"
										className="p-1"
										compact
										onValueChange={(contrast) =>
											patch({
												accessibility: { ...draft.accessibility, contrast },
											})
										}
										options={CONTRAST_OPTIONS}
										value={draft.accessibility.contrast}
									/>
								</SettingsRow>

								<SettingsRow
									icon={Globe}
									title="Language"
									description="Used for month names and number formatting."
								>
									<RegionalSelect
										label="Language"
										value={draft.locale}
										options={LOCALE_OPTIONS}
										onValueChange={(locale) => patch({ locale })}
									/>
								</SettingsRow>
								<SettingsRow
									icon={Globe}
									title="Time zone"
									description="Used for times. Calendar dates stay the same."
								>
									<RegionalSelect
										label="Time zone"
										value={draft.timezone}
										options={TIMEZONE_OPTIONS}
										onValueChange={(timezone) => patch({ timezone })}
									/>
								</SettingsRow>
							</>
						)}
					</SettingsRows>
					{draft && (
						<div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
							{state === "clean" && (
								<Text role="label" tone="secondary">
									No unsaved changes
								</Text>
							)}
							<Button
								disabled={!dirty || save.isPending}
								onClick={() => save.mutate(draft)}
								size="sm"
							>
								{save.isPending ? "Saving…" : "Save preferences"}
							</Button>
						</div>
					)}
				</div>
			</PageSection>

			{!localEvaluation && <WebPushSettings />}
			{!localEvaluation && <PersonalAgentValue />}
			{!localEvaluation &&
				operationalContext.data &&
				["owner", "admin"].includes(
					operationalContext.data.authority.role ?? "",
				) && (
					<PageSection>
						<WorkspaceAppRenderer
							manifest={{
								entry: ORGANIZATION_DOMAIN_ENTRY,
								capabilities: [],
								config: {
									organizationId: operationalContext.data.organization.id,
								},
							}}
						/>
					</PageSection>
				)}
			<OperationalContextSection
				localEvaluation={localEvaluation}
				localInferenceEnabled={__LOCAL_INFERENCE_ENABLED__}
				MembersLinkComponent={MembersLinkComponent}
			/>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Connected agents</SectionTitle>
						<SectionDescription>
							{localEvaluation
								? "CLI sessions and production connections are separate from this preview."
								: "External agents use the same gateway and permissions as this workspace."}
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<SettingsRows>
					<SettingsRow
						icon={Plug}
						title="Gateway connection"
						description={
							<>
								Run <CodeInline>tedix auth status</CodeInline> to see your CLI
								workspace and gateway.
								{localEvaluation
									? " This preview does not inherit its credentials."
									: " This page does not check gateway status."}
							</>
						}
					/>
				</SettingsRows>
			</PageSection>
		</Page>
	);
}
