import type {
	OsUserPreferences,
	OsUserPreferencesState,
} from "@tedix/api-contract/schemas/user-settings";
import type { AiGatewayAdmissionPolicy } from "@tedix/api-contract/schemas/tedi";
import { resolveOsTenant } from "@/shared/os-tenant";
import {
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
import { IconFrame } from "@/components/kumo/icon-frame";
import { OsRouterLink } from "@/components/kumo/link-provider";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
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
import {
	runtimeEntitlementsQueryOptions,
	userConnectionsQueryOptions,
} from "@/lib/os-query-options";
import { formatCount } from "@/lib/format";
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
] as const;

const FOLLOW_SYSTEM = "__system__";

function SettingRow({
	icon: Icon,
	title,
	description,
	children,
}: {
	icon: ComponentType<{ size?: number }>;
	title: string;
	description: string;
	children?: ReactNode;
}) {
	return (
		<div
			className="grid grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 px-4 py-4 sm:grid-cols-[2.25rem_minmax(0,1fr)_auto] sm:items-center"
			data-slot="setting-row"
		>
			<IconFrame appearance="fill">
				<Icon size={18} />
			</IconFrame>
			<div className="min-w-0 flex-1">
				<div className="font-medium text-kumo-default text-sm">{title}</div>
				<div className="mt-0.5 text-kumo-subtle text-xs leading-relaxed">
					{description}
				</div>
			</div>
			{children ? (
				<div
					className="col-span-2 min-w-0 justify-self-start sm:col-span-1 sm:shrink-0"
					data-slot="setting-row-control"
				>
					{children}
				</div>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * The save button's state, kept explicit so "nothing changed", "saving" and
 * "the store moved under you" never collapse into one disabled button with no
 * explanation.
 */
export type SaveState = "clean" | "dirty" | "saving" | "conflict" | "error";

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
	if (!input.active) return "inference BLOCKED";
	if (!input.localEvaluation) return "admitting inference";
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
			? `Model tiers: ${policy.allowedModelTiers.join(" · ")}`
			: "All model tiers allowed",
	];
	if (policy?.dailyTokenLimit !== undefined) {
		parts.push(`${formatCount(policy.dailyTokenLimit)} tokens/day`);
	}
	if (policy?.dailySpendLimitMicros !== undefined) {
		parts.push(`$${(policy.dailySpendLimitMicros / 1_000_000).toFixed(2)}/day`);
	}
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Read-only operational context
// ---------------------------------------------------------------------------

/** Injectable-link seam for tests that render without a RouterProvider. */
export type TeamMembersLinkProps = {
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

function OperationalContextSection({
	localEvaluation,
	localInferenceEnabled,
	MembersLinkComponent = DefaultTeamMembersLink,
}: {
	localEvaluation: boolean;
	localInferenceEnabled: boolean;
	MembersLinkComponent?: ComponentType<TeamMembersLinkProps>;
}) {
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
							? "Read-only deterministic seed state stored locally on this machine. It is not a production tenant, membership, or control-plane grant."
							: "Read-only. Tedix OS projects operational state here; every durable change belongs to the policy-checked control plane, which these links open for the workspace your credential resolved."}
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
				<Card className="divide-y divide-kumo-line overflow-hidden p-0">
					<SettingRow
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
					</SettingRow>

					<SettingRow
						icon={Key}
						title={
							localEvaluation
								? "Seeded local capabilities"
								: "Effective authority"
						}
						description={
							context.data.authority.permissions.length > 0
								? context.data.authority.permissions.join(" · ")
								: context.data.authority.machineScopes.length > 0
									? `Machine scopes: ${context.data.authority.machineScopes.join(" · ")}`
									: "No tenant permissions resolved for this credential."
						}
					>
						{context.data.authority.crossTenantOverrideActive && (
							<Badge variant="warning">Tenant override</Badge>
						)}
					</SettingRow>

					<SettingRow
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
					</SettingRow>

					<SettingRow
						icon={Globe}
						title="Runtime budgets and model policy"
						description={
							entitlement.isPending
								? "Reading the admission gate…"
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
										: "No runtime entitlement configured — runtime inference is not admitted."
						}
					>
						<Button
							render={<MembersLinkComponent to="/admin/billing" />}
							size="sm"
							variant="outline"
						>
							Billing
						</Button>
					</SettingRow>

					<SettingRow
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
					</SettingRow>

					<SettingRow
						icon={UserCircle}
						title="Members and roles"
						description="Invite people, assign roles, and manage permission overrides on the Team page. Sessions and secrets stay in the control plane."
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
					</SettingRow>
				</Card>
			)}
		</PageSection>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SettingsPage({
	MembersLinkComponent,
}: {
	MembersLinkComponent?: ComponentType<TeamMembersLinkProps>;
} = {}) {
	const identity = useOsIdentity();
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
		<Page width="md" className="os-settings-page">
			<PageHeader>
				<PageHeading>
					<PageTitle>Settings</PageTitle>
					<PageDescription>
						{localEvaluation
							? "Preferences are stored only locally on this machine."
							: "Preferences are stored on your Tedix profile for this workspace, so they follow you to any browser or harness."}
					</PageDescription>
				</PageHeading>
			</PageHeader>

			{localEvaluation && (
				<Alert>
					<AlertTitle>Isolated local evaluation</AlertTitle>
					<AlertDescription>
						This launcher uses a deterministic local identity and D1 dataset. It
						does not sign in with Descope, inherit a production tenant, or
						import production secrets and connections.
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
								: "Loading your stored preferences…"}
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
							Your save was refused so it could not overwrite the newer values.
							The surviving preferences have been reloaded — reapply your change
							and save again.
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

				<Card className="divide-y divide-kumo-line overflow-hidden p-0">
					<SettingRow
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
					</SettingRow>
				</Card>

				{draft && (
					<>
						<Card className="divide-y divide-kumo-line overflow-hidden p-0">
							<SettingRow
								icon={Desktop}
								title="Appearance"
								description="Use the system appearance or keep Tedix OS in a fixed mode."
							>
								<SegmentedControl<OsUserPreferences["theme"]>
									ariaLabel="Appearance"
									compact
									onValueChange={(theme) => patch({ theme })}
									options={THEME_OPTIONS}
									value={draft.theme}
								/>
							</SettingRow>
							<SettingRow
								icon={Rows}
								title="Density"
								description="Compact tightens the page rhythm. Control sizes and hit targets never shrink."
							>
								<SegmentedControl<OsUserPreferences["density"]>
									ariaLabel="Density"
									compact
									onValueChange={(density) => patch({ density })}
									options={DENSITY_OPTIONS}
									value={draft.density}
								/>
							</SettingRow>
							<SettingRow
								icon={Eye}
								title="Motion"
								description="System follows your operating system's reduced-motion setting."
							>
								<SegmentedControl<OsUserPreferences["accessibility"]["motion"]>
									ariaLabel="Motion"
									compact
									onValueChange={(motion) =>
										patch({ accessibility: { ...draft.accessibility, motion } })
									}
									options={MOTION_OPTIONS}
									value={draft.accessibility.motion}
								/>
							</SettingRow>
							<SettingRow
								icon={Eye}
								title="Contrast"
								description="High strengthens hairlines and muted text across the shell."
							>
								<SegmentedControl<
									OsUserPreferences["accessibility"]["contrast"]
								>
									ariaLabel="Contrast"
									compact
									onValueChange={(contrast) =>
										patch({
											accessibility: { ...draft.accessibility, contrast },
										})
									}
									options={CONTRAST_OPTIONS}
									value={draft.accessibility.contrast}
								/>
							</SettingRow>
						</Card>

						<Card className="divide-y divide-kumo-line overflow-hidden p-0">
							<SettingRow
								icon={Globe}
								title="Language"
								description="Selects the month names and number formatting Tedix OS renders. Dates stay month-name based."
							>
								<Select
									onValueChange={(value) =>
										patch({
											locale: value === FOLLOW_SYSTEM ? null : String(value),
										})
									}
									value={draft.locale ?? FOLLOW_SYSTEM}
								>
									<SelectTrigger
										aria-label="Language"
										className="w-56"
										size="sm"
									>
										<SelectValue>
											{(value) =>
												value === FOLLOW_SYSTEM
													? "Follow browser"
													: (LOCALE_OPTIONS.find(
															(option) => option.value === value,
														)?.label ?? String(value))
											}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={FOLLOW_SYSTEM}>
											Follow browser
										</SelectItem>
										{LOCALE_OPTIONS.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</SettingRow>
							<SettingRow
								icon={Globe}
								title="Time zone"
								description="Selects the wall clock for timestamps. Date-only values stay in UTC so they never shift a day."
							>
								<Select
									onValueChange={(value) =>
										patch({
											timezone: value === FOLLOW_SYSTEM ? null : String(value),
										})
									}
									value={draft.timezone ?? FOLLOW_SYSTEM}
								>
									<SelectTrigger
										aria-label="Time zone"
										className="w-56"
										size="sm"
									>
										<SelectValue>
											{(value) =>
												value === FOLLOW_SYSTEM
													? "Follow browser"
													: String(value)
											}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={FOLLOW_SYSTEM}>
											Follow browser
										</SelectItem>
										{TIMEZONE_OPTIONS.map((zone) => (
											<SelectItem key={zone} value={zone}>
												{zone}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</SettingRow>
						</Card>

						<div className="flex items-center justify-end gap-3">
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
					</>
				)}
			</PageSection>

			<OperationalContextSection
				localEvaluation={localEvaluation}
				localInferenceEnabled={__LOCAL_INFERENCE_ENABLED__}
				MembersLinkComponent={MembersLinkComponent}
			/>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>External harnesses</SectionTitle>
						<SectionDescription>
							{localEvaluation
								? "The isolated launcher does not reuse an installed CLI session or production MCP gateway."
								: "Codex, Claude, OpenCode, and the Tedix CLI use the same MCP gateway and governed contracts as this UI."}
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<Card>
					<CardHeader>
						<IconFrame appearance="fill" className="text-kumo-brand">
							<Plug size={18} />
						</IconFrame>
						<CardTitle>Gateway connection</CardTitle>
						<CardDescription>
							Discover apps, tools, skills, and OS actions from any MCP-capable
							harness.
						</CardDescription>
						<CardAction>
							<Badge variant="outline">Verify with the CLI</Badge>
						</CardAction>
					</CardHeader>
					<CardContent>
						<Text role="label" tone="secondary">
							{localEvaluation ? (
								<>
									Run{" "}
									<code className="rounded bg-kumo-fill px-1.5 py-1 text-kumo-default">
										tedix auth status
									</code>{" "}
									to inspect a separate live CLI session. Its workspace and
									credentials are not inherited by this local evaluation.
								</>
							) : (
								<>
									Run{" "}
									<code className="rounded bg-kumo-fill px-1.5 py-1 text-kumo-default">
										tedix auth status
									</code>{" "}
									to see the selected workspace, credential source, and gateway.
									This page does not probe the gateway, so it reports no status
									of its own.
								</>
							)}
						</Text>
					</CardContent>
				</Card>
			</PageSection>
		</Page>
	);
}
