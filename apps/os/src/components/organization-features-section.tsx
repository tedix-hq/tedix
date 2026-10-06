/**
 * Read-only view of the organization's effective plan features
 * (`organizations.getFeatures`).
 */

import type { OrganizationFeatures } from "@tedix/api-contract/schemas/organization";
import {
	AppWindow,
	ChartBar,
	Check,
	Globe,
	Headphones,
	Key,
	Sparkle,
	Users,
	X,
} from "@phosphor-icons/react";
import {
	SectionHeader,
	SectionTitle,
	SettingsSection,
	SettingsSectionContent,
	Collection,
} from "@/components/kumo/page";
import { Badge } from "@/components/kumo/badge";
import { IconFrame } from "@/components/kumo/icon-frame";
import { Text } from "@/components/kumo/text";

interface Feature {
	name: string;
	description: string;
	enabled: boolean;
	icon: React.ElementType;
}

export function FeaturesSection({
	features,
}: {
	features: OrganizationFeatures;
}) {
	const featuresList: Feature[] = [
		{
			name: "AI apps",
			description:
				features.maxApps === -1
					? "Unlimited apps"
					: `Up to ${features.maxApps} apps`,
			enabled: true,
			icon: AppWindow,
		},
		{
			name: "Team members",
			description:
				features.maxTeamMembers === -1
					? "Unlimited team members"
					: `Up to ${features.maxTeamMembers} members`,
			enabled: true,
			icon: Users,
		},
		{
			name: "Custom domain",
			description: "Use your own domain for app endpoints",
			enabled: features.customDomain || false,
			icon: Globe,
		},
		{
			name: "SSO / SAML",
			description: "Single sign-on with enterprise providers",
			enabled: features.sso || false,
			icon: Key,
		},
		{
			name: "API access",
			description: "Programmatic access to manage your apps",
			enabled: features.apiAccess || false,
			icon: ChartBar,
		},
		{
			name: "Priority support",
			description: "Dedicated support channel with faster response",
			enabled: features.prioritySupport || false,
			icon: Headphones,
		},
		{
			name: "Advanced analytics",
			description: "Detailed insights and usage analytics",
			enabled: features.advancedAnalytics || false,
			icon: ChartBar,
		},
		{
			name: "White label",
			description: "Remove Tedix branding from your apps",
			enabled: features.whiteLabel || false,
			icon: Sparkle,
		},
	];

	return (
		<SettingsSection>
			<SectionHeader>
				<SectionTitle>Plan features</SectionTitle>
			</SectionHeader>
			<SettingsSectionContent>
				<Collection aria-label="Plan features">
					{featuresList.map((feature) => (
						<li
							key={feature.name}
							className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 px-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
						>
							<IconFrame
								appearance="fill"
								size="sm"
								className="row-span-2 sm:row-span-1"
							>
								<feature.icon className="h-4 w-4" />
							</IconFrame>
							<div className="min-w-0 space-y-0.5">
								<Text weight="medium">{feature.name}</Text>
								<Text role="label" tone="secondary">
									{feature.description}
								</Text>
							</div>
							<Badge
								variant={feature.enabled ? "success" : "secondary"}
								className="col-start-2 w-fit gap-1 sm:col-start-3 sm:row-start-1"
							>
								{feature.enabled ? (
									<Check className="size-3" aria-hidden />
								) : (
									<X className="size-3" aria-hidden />
								)}
								{feature.enabled ? "Included" : "Not included"}
							</Badge>
						</li>
					))}
				</Collection>
			</SettingsSectionContent>
		</SettingsSection>
	);
}
