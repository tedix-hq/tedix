import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DelegatedApprovalsPolicySchema } from "@tedix/api-contract/schemas/delegated-approvals";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { Button } from "@/components/kumo/button";
import { Switch } from "@/components/kumo/switch";
import { SectionTitle } from "@/components/kumo/page";

export function DelegatedApprovalSettingsApp({
	organizationId,
}: {
	organizationId: string;
}) {
	const context = useOsOperationalContext();
	if (
		context.data?.organization.id !== organizationId ||
		context.data.authority.role !== "owner"
	)
		return <p>Only the organization owner can manage delegated approvals.</p>;
	return (
		<DelegatedApprovalSettings
			key={organizationId}
			organizationId={organizationId}
		/>
	);
}

function DelegatedApprovalSettings({
	organizationId,
}: {
	organizationId: string;
}) {
	const cache = useQueryClient();
	const organization = useQuery(
		osQuery.organizations.get.queryOptions({ input: { organizationId } }),
	);
	const agents = useQuery(
		osQuery.externalAgentIdentity.listPrincipals.queryOptions({
			input: { organizationId, limit: 500 },
		}),
	);
	const [offset, setOffset] = useState(0);
	const members = useQuery(
		osQuery.members.listMembers.queryOptions({
			input: { organizationId, status: "active", limit: 100, offset },
		}),
	);
	const [draft, setDraft] = useState<{
		enabled: boolean;
		leadAgents: Record<string, string>;
	}>();
	const policy = draft ??
		DelegatedApprovalsPolicySchema.safeParse(
			organization.data?.metadata?.delegatedApprovals,
		).data ?? { enabled: false, leadAgents: {} };
	const save = useMutation({
		mutationFn: () =>
			osApi.organizations.update({
				organizationId,
				metadata: { delegatedApprovals: policy },
			}),
		onSuccess: async () => {
			await cache.invalidateQueries({ queryKey: osQuery.organizations.key() });
			setDraft(undefined);
		},
	});
	return (
		<section className="space-y-4" aria-label="Delegated approvals">
			<SectionTitle>Delegated approvals</SectionTitle>
			<p>
				Let a person’s own tedi or designated lead agent decide eligible,
				reversible internal approvals. Human-only steps still need the person.
				Turning this off restores the usual approval rules.
			</p>
			{organization.isPending ? (
				<p>Loading approval settings…</p>
			) : organization.isError ? (
				<p role="alert">Approval settings could not be loaded.</p>
			) : (
				<>
					<Switch
						label="Allow delegated approvals"
						checked={policy.enabled}
						onCheckedChange={(enabled) => setDraft({ ...policy, enabled })}
						disabled={save.isPending}
					/>
					<p>
						Choose a lead agent for each person. A lead must have independent
						credentials; an agent using that person’s own login cannot approve
						on their behalf.
					</p>
					{members.isError || agents.isError ? (
						<p role="alert">
							People or agents could not be loaded. Reload to edit lead agents.
						</p>
					) : members.isPending || agents.isPending ? (
						<p>Loading people and agents…</p>
					) : (
						members.data.data
							.filter(
								(member) =>
									member.userId && (!member.kind || member.kind === "human"),
							)
							.map((member) => {
								const ownerId = member.userId!;
								const selected = policy.leadAgents[ownerId] ?? "";
								const eligible = agents.data.filter(
									(agent) =>
										agent.status === "active" &&
										!(
											agent.credentialBindingType === "owner_user" &&
											agent.credentialBindingId === ownerId
										),
								);
								return (
									<label key={member.id} className="block space-y-1">
										<span>{member.name || member.email}</span>
										<select
											aria-label={`Lead agent for ${member.name || member.email}`}
											className="block w-full rounded-md border border-kumo-line bg-kumo-base p-2"
											value={selected}
											disabled={save.isPending}
											onChange={(event) => {
												const leadAgents = { ...policy.leadAgents };
												if (event.target.value)
													leadAgents[ownerId] = event.target.value;
												else delete leadAgents[ownerId];
												setDraft({ ...policy, leadAgents });
											}}
										>
											<option value="">No lead agent</option>
											{selected &&
												!eligible.some((agent) => agent.id === selected) && (
													<option value={selected}>
														Unavailable agent ({selected})
													</option>
												)}
											{eligible.map((agent) => (
												<option key={agent.id} value={agent.id}>
													{agent.displayName}
												</option>
											))}
										</select>
									</label>
								);
							})
					)}
					<div className="flex gap-2">
						{offset > 0 && (
							<Button onClick={() => setOffset(offset - 100)}>
								Previous people
							</Button>
						)}
						{members.data?.data.length === 100 && (
							<Button onClick={() => setOffset(offset + 100)}>
								More people
							</Button>
						)}
					</div>
					<Button
						disabled={!draft || save.isPending}
						onClick={() => save.mutate()}
					>
						{save.isPending ? "Saving…" : "Save approval settings"}
					</Button>
					{save.isSuccess && !draft && (
						<p role="status">Approval settings saved.</p>
					)}
					{save.isError && (
						<p role="alert">
							Approval settings could not be saved: {save.error.message}
						</p>
					)}
				</>
			)}
		</section>
	);
}
