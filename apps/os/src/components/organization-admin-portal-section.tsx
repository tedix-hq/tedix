/**
 * SSO / identity administration handoff. When the
 * plan lacks SSO this renders the upgrade prompt; otherwise it links (and can
 * embed) the Descope tenant administration portal.
 */

import { ArrowSquareOut, CaretDown } from "@phosphor-icons/react";
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
	CollapsibleContent,
	CollapsibleTrigger,
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
					<Surface tier="panel" className="border-dashed p-6 text-center">
						<Text tone="secondary">
							SSO and enterprise authentication features are available on the
							Enterprise plan.
						</Text>
					</Surface>
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
							<ArrowSquareOut className="mr-2 h-4 w-4" />
							Open administration portal
						</Button>
					)}
				</div>

				<Collapsible open={isOpen} onOpenChange={setIsOpen}>
					<CollapsibleTrigger
						render={
							<Button variant="ghost" className="w-full justify-between p-4" />
						}
					>
						{/* Button already forces type-tedix-body !font-medium at this
						size, so the span's own type utilities were dead. */}
						<span>Embed administration portal (advanced)</span>
						<CaretDown
							className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
						/>
					</CollapsibleTrigger>
					<CollapsibleContent>
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
							<Surface
								tier="panel"
								className="mt-4 border-dashed p-6 text-center"
							>
								<Text tone="secondary">
									Identity administration is not linked. Contact support to
									enable SSO features.
								</Text>
							</Surface>
						)}
					</CollapsibleContent>
				</Collapsible>
			</SettingsSectionContent>
		</SettingsSection>
	);
}
