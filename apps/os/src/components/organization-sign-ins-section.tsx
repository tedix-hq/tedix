/**
 * Admin › Organization › Tedix sign-ins.
 *
 * Lists every live Connect sign-in whose organizations include this one, one
 * row per grant revision, with the member, agent, device, organizations,
 * creation and last use. Revoke ends exactly that sign-in; the member's other
 * sign-ins keep working. The API re-checks admin authority and tenant
 * selection on both calls.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrganizationMcpSignIn } from "@tedix/api-contract/schemas/mcp-grant";
import { LoadingArea } from "@/components/loading-area";
import { LoadError } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Collection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import { SettingsRow, SettingsRows } from "@/components/settings-row";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	organizationSignInsQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

function formatDate(value: string | null) {
	if (!value) return "Never";
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? value
		: date.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			});
}

function deviceLabel(device: string | null) {
	switch (device) {
		case "app":
			return "App";
		case "browser":
			return "Browser";
		default:
			return "Unknown device";
	}
}

function personLabel(row: OrganizationMcpSignIn) {
	return row.memberName ?? row.memberEmail ?? row.descopeUserId;
}

function signInDetails(row: OrganizationMcpSignIn) {
	return [
		row.clientName ?? "Unnamed agent",
		deviceLabel(row.device),
		row.serverSlug ?? row.mcpServerId,
		`created ${formatDate(row.createdAt)}`,
		`last used ${formatDate(row.lastUsedAt)}`,
	].join(" · ");
}

export function OrganizationSignInsSection({
	organizationId,
}: {
	organizationId: string;
}) {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const signIns = useQuery(organizationSignInsQueryOptions(organizationId));
	const revoke = useMutation({
		mutationFn: (row: OrganizationMcpSignIn) =>
			osApi.organizations.revokeOrganizationMcpSignIn({
				organizationId,
				descopeUserId: row.descopeUserId,
				mcpServerId: row.mcpServerId,
				clientId: row.clientId,
				revision: row.revision,
			}),
		onSuccess: async () => {
			setError(null);
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.organizationSignIns(),
			});
		},
		onError: () =>
			setError("Could not end that sign-in. Refresh the list and try again."),
	});
	if (signIns.isPending)
		return (
			<SettingsSection>
				<SectionHeader>
					<SectionTitle>Tedix sign-ins</SectionTitle>
				</SectionHeader>
				<SettingsSectionContent>
					<LoadingArea className="h-24" label="Loading sign-ins" />
				</SettingsSectionContent>
			</SettingsSection>
		);
	if (signIns.isError || !signIns.data)
		return (
			<SettingsSection>
				<SectionHeader>
					<SectionTitle>Tedix sign-ins</SectionTitle>
				</SectionHeader>
				<SettingsSectionContent>
					<LoadError
						error={signIns.error}
						onRetry={() => {
							void signIns.refetch();
						}}
						retrying={signIns.isFetching}
					/>
				</SettingsSectionContent>
			</SettingsSection>
		);
	return (
		<SettingsSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Tedix sign-ins</SectionTitle>
					<SectionDescription>
						Every sign-in members gave an agent to reach this organization, one
						row per installation. Ending a sign-in stops only that installation;
						the member's other sign-ins keep working.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<SettingsSectionContent className="space-y-4">
				{error ? (
					<Text role="label" tone="error">
						{error}
					</Text>
				) : null}
				{signIns.data.items.length === 0 ? (
					<Text role="label" tone="secondary">
						No member sign-ins reach this organization yet.
					</Text>
				) : (
					<SettingsRows>
						<Collection aria-label="Member sign-ins">
							{signIns.data.items.map((row) => (
								<li
									key={`${row.descopeUserId} ${row.mcpServerId} ${row.clientId} ${row.revision}`}
								>
									<SettingsRow
										title={
											<span className="flex flex-wrap items-center gap-2">
												{personLabel(row)}
											</span>
										}
										description={
											<>
												<span className="block">{signInDetails(row)}</span>
												<span className="block">
													Organizations:{" "}
													{row.selectedTenantIds.join(", ") || "None"}
												</span>
											</>
										}
									>
										<Button
											variant="secondary"
											disabled={revoke.isPending}
											aria-label={`End ${personLabel(row)}'s sign-in`}
											onClick={() => revoke.mutate(row)}
										>
											End sign-in
										</Button>
									</SettingsRow>
								</li>
							))}
						</Collection>
					</SettingsRows>
				)}
			</SettingsSectionContent>
		</SettingsSection>
	);
}
