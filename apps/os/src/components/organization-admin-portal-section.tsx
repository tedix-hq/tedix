/**
 * SSO / identity administration handoff. When the
 * plan lacks SSO this renders the upgrade prompt; otherwise it links (and can
 * embed) the Descope tenant administration portal.
 */

import { Empty, EmptyDescription } from "@/components/kumo/empty";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	SectionHeader,
	SectionTitle,
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";

interface AdminPortalSectionProps {
	/** Descope tenant ID */
	descopeTenantId?: string | null;
	ssoEnabled: boolean;
}

export function AdminPortalSection({
	descopeTenantId,
	ssoEnabled,
}: AdminPortalSectionProps) {
	const [isOpen, setIsOpen] = useState(false);

	if (!ssoEnabled) {
		return (
			<SettingsSection>
				<SectionHeader>
					<SectionTitle>SSO and authentication</SectionTitle>
				</SectionHeader>
				<SettingsSectionContent>
					<Empty appearance="quiet">
						<EmptyDescription>
							SSO and enterprise authentication features are available on the
							Enterprise plan.
						</EmptyDescription>
					</Empty>
				</SettingsSectionContent>
			</SettingsSection>
		);
	}

	// Generate Descope Admin Portal URL
	const adminPortalUrl = descopeTenantId
		? `https://app.descope.com/tenants/${descopeTenantId}`
		: null;

	return (
		<SettingsSection>
			<SectionHeader>
				<SectionTitle>SSO and authentication</SectionTitle>
			</SectionHeader>
			<SettingsSectionContent className="space-y-4">
				<div className="space-y-2">
					<Text>
						Configure Single Sign-On (SSO) and enterprise authentication
						settings through the identity administration portal.
					</Text>
					{adminPortalUrl && (
						<Button
							variant="outline"
							size="sm"
							nativeButton={false}
							render={
								<a
									href={adminPortalUrl}
									target="_blank"
									rel="noopener noreferrer"
								/>
							}
						>
							<ArrowSquareOut size={16} />
							Open administration portal
						</Button>
					)}
				</div>

				<Collapsible open={isOpen} onOpenChange={setIsOpen}>
					<CollapsibleDefaultTrigger>
						{/* Button already forces type-tedix-body !font-medium at this
						size, so the span's own type utilities were dead. */}
						<span>Embed administration portal (advanced)</span>
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent>
						{descopeTenantId ? (
							<Surface tier="panel" className="mt-4 overflow-hidden">
								<iframe
									src={`https://app.descope.com/embed/tenants/${descopeTenantId}`}
									className="h-[600px] w-full"
									title="Identity administration portal"
									sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
								/>
							</Surface>
						) : (
							<Empty appearance="quiet" className="mt-4">
								<EmptyDescription>
									Identity administration is not linked. Contact support to
									enable SSO features.
								</EmptyDescription>
							</Empty>
						)}
					</CollapsibleDefaultContent>
				</Collapsible>
			</SettingsSectionContent>
		</SettingsSection>
	);
}
