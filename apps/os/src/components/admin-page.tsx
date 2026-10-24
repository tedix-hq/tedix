import {
	Buildings,
	CaretRight,
	Key,
	Plugs,
	Wallet,
} from "@phosphor-icons/react";
import { Link } from "@/components/kumo/link";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { IconFrame } from "@/components/kumo/icon-frame";
import {
	Collection,
	PageSection,
	SectionHeader,
	SectionTitle,
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
	SectionDescription,
	SectionHeading,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import {
	billingOverviewQueryOptions,
	connectionsOverviewQueryOptions,
} from "@/lib/os-query-options";
import { OS_SETTINGS_NAVIGATION } from "@/lib/os-navigation";
import { OS_COPY } from "@/shared/os-copy";
import { cn } from "@/lib/utils";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

export type AdminDestination = {
	to: string;
	title: string;
	description: string;
	icon?: ComponentType<{ size?: number }>;
};

const ADMIN_DESTINATIONS: AdminDestination[] = [
	{
		to: "/admin/organization",
		title: "Organization",
		description: "Profile, plan features, identity, and single sign-on",
		icon: Buildings,
	},
	{
		to: "/admin/connections",
		title: "Connections",
		description: "OAuth providers and organization credentials",
		icon: Plugs,
	},
	{
		to: "/admin/api-keys",
		title: "API keys",
		description: "Create, rotate, and revoke automation credentials",
		icon: Key,
	},
	{
		to: "/admin/payments",
		title: "Payments",
		description: "Paid tool spend, budget policies, and receipts",
		icon: Wallet,
	},
];

type OverviewStatus = {
	label: string;
	variant: BadgeVariant;
	detail: string;
};

export function AdminLinkRow({
	to,
	title,
	description,
	icon: Icon,
	status,
}: AdminDestination & { status?: OverviewStatus }) {
	return (
		<li>
			<Link
				variant="collection"
				className={cn(
					"flex w-full min-w-0 gap-3! px-4 py-3",
					status && "max-sm:flex-col max-sm:items-start max-sm:gap-2!",
				)}
				href={to}
			>
				{Icon && (
					<IconFrame appearance="fill" size="sm">
						<Icon size={16} />
					</IconFrame>
				)}
				<div className="min-w-0 flex-1">
					<Text weight="medium">{title}</Text>
					<Text
						role="label"
						tone="secondary"
						className="mt-1 max-sm:max-w-[18rem] break-words"
						data-row-description
					>
						{description}
					</Text>
				</div>
				{status ? (
					<Badge variant={status.variant} className="shrink-0">
						{status.label}
					</Badge>
				) : (
					<CaretRight className="shrink-0 text-kumo-subtle" size={14} />
				)}
			</Link>
		</li>
	);
}

export function AdminPage() {
	const context = useOsOperationalContext();
	const authority = context.data?.authority;
	const canReadConnections =
		authority?.permissions.includes("apps:read") ||
		authority?.machineScopes.includes("apps:read") ||
		false;
	const canReadBilling =
		authority?.permissions.includes("billing:read") ||
		authority?.machineScopes.includes("billing:read") ||
		false;
	const connections = useQuery({
		...connectionsOverviewQueryOptions({
			scope: "organization",
			q: "",
			status: "all",
			limit: 100,
			offset: 0,
		}),
		enabled: canReadConnections,
	});
	const billing = useQuery({
		...billingOverviewQueryOptions(),
		enabled: canReadBilling,
	});
	const organizationStatus: OverviewStatus = context.isPending
		? {
				label: "Loading",
				variant: "secondary",
				detail: "Loading organization identity and access…",
			}
		: context.isError || !context.data
			? {
					label: "Unavailable",
					variant: "warning",
					detail: "Organization context could not be read.",
				}
			: {
					label: "Current",
					variant: "outline",
					detail: `${context.data.organization.name} · ${authority?.role ?? authority?.authType ?? "Role unavailable"}`,
				};
	const missingCredentials =
		connections.data?.rows.filter(
			(row) => row.accountState === "missing" || row.accountState === "expired",
		).length ?? 0;
	const unknownCredentials =
		connections.data?.rows.filter((row) =>
			["restricted", "unknown"].includes(row.accountState),
		).length ?? 0;
	const partialConnections =
		connections.data?.hasMore ||
		!connections.data?.verificationComplete ||
		!connections.data?.referencesComplete ||
		unknownCredentials > 0;
	const connectionsStatus: OverviewStatus = context.isPending
		? {
				label: "Loading",
				variant: "secondary",
				detail: "Waiting for organization access…",
			}
		: context.isError || !context.data
			? {
					label: "Unknown",
					variant: "secondary",
					detail: "Connection status needs organization context.",
				}
			: !canReadConnections
				? {
						label: "Restricted",
						variant: "outline",
						detail: "Your credential cannot read organization connections.",
					}
				: connections.isPending
					? {
							label: "Loading",
							variant: "secondary",
							detail: "Checking credential inventory…",
						}
					: connections.isError || !connections.data
						? {
								label: "Unavailable",
								variant: "warning",
								detail: "Credential inventory could not be read.",
							}
						: missingCredentials > 0
							? {
									label: "Needs attention",
									variant: "warning",
									detail: `${missingCredentials} missing or expired among ${connections.data.rows.length} loaded accounts${partialConnections ? "; inventory is partial" : ""}.`,
								}
							: partialConnections
								? {
										label: "Partial",
										variant: "secondary",
										detail:
											"Credential or reference verification is incomplete; provider health is unknown.",
									}
								: connections.data.rows.length === 0
									? {
											label: "No accounts",
											variant: "outline",
											detail:
												"No organization accounts or app requirements are listed.",
										}
									: {
											label: "Checked",
											variant: "outline",
											detail: `No missing or expired credentials among ${connections.data.rows.length} listed accounts. Provider health was not checked.`,
										};
	const billingStatus: OverviewStatus = context.isPending
		? {
				label: "Loading",
				variant: "secondary",
				detail: "Waiting for billing access…",
			}
		: context.isError || !context.data
			? {
					label: "Unknown",
					variant: "secondary",
					detail: "Billing status needs organization context.",
				}
			: !canReadBilling
				? {
						label: "Restricted",
						variant: "outline",
						detail: "Your credential cannot read billing status.",
					}
				: billing.isPending
					? {
							label: "Loading",
							variant: "secondary",
							detail: "Checking plan and AI capacity…",
						}
					: billing.isError || !billing.data
						? {
								label: "Unavailable",
								variant: "warning",
								detail: "Plan and capacity could not be read.",
							}
						: billing.data.inferenceCapacity.available
							? {
									label: "Available",
									variant: "success",
									detail: `${billing.data.plan.name} plan · AI inference capacity available.`,
								}
							: {
									label: "Action needed",
									variant: "warning",
									detail: `${billing.data.plan.name} plan · AI inference capacity unavailable.`,
								};

	return (
		<Page width="md">
			<PageHeader>
				<PageHeading>
					<PageTitle>{OS_COPY.navigation.settings}</PageTitle>
					<PageDescription>
						Manage your organization, access, connected services, and billing.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>At a glance</SectionTitle>
						<SectionDescription>
							Check your organization, connected accounts and plan.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<Collection aria-label="At a glance">
					{[
						{
							title: "Workspace identity",
							to: "/admin/organization",
							status: organizationStatus,
						},
						{
							title: "Connection credentials",
							to: "/admin/connections",
							status: connectionsStatus,
						},
						{
							title: "AI capacity",
							to: "/admin/billing",
							status: billingStatus,
						},
					].map((item) => (
						<AdminLinkRow
							key={item.to}
							{...item}
							description={item.status.detail}
						/>
					))}
				</Collection>
			</PageSection>

			<PageSection>
				<SectionHeader>
					<SectionTitle>Manage settings</SectionTitle>
				</SectionHeader>
				<Collection aria-label="Manage settings">
					{[
						...OS_SETTINGS_NAVIGATION.map((item) => ({
							to: item.path,
							title: item.label,
							description: item.description,
							icon: Buildings,
						})),
						...ADMIN_DESTINATIONS,
					].map((destination) => (
						<AdminLinkRow key={destination.to} {...destination} />
					))}
				</Collection>
			</PageSection>
		</Page>
	);
}
