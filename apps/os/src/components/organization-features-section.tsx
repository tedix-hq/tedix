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
	Collection,
	SectionHeader,
	SectionTitle,
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import { Badge } from "@/components/kumo/badge";
import { SettingsRow, SettingsRows } from "@/components/settings-row";

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
				<SettingsRows>
					<Collection appearance="inline" aria-label="Plan features">
						{featuresList.map((feature) => (
							<li key={feature.name}>
								<SettingsRow
									icon={feature.icon}
									title={feature.name}
									description={feature.description}
								>
									<Badge
										variant={feature.enabled ? "success" : "secondary"}
										className="w-fit gap-1"
									>
										{feature.enabled ? (
											<Check className="size-3" aria-hidden />
										) : (
											<X className="size-3" aria-hidden />
										)}
										{feature.enabled ? "Included" : "Not included"}
									</Badge>
								</SettingsRow>
							</li>
						))}
					</Collection>
				</SettingsRows>
			</SettingsSectionContent>
		</SettingsSection>
	);
}
