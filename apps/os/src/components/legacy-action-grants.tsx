import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";

export function LegacyActionGrants({ canChange }: { canChange: boolean }) {
	const client = useQueryClient();
	const inventory = useQuery(
		osQuery.mcpGovernance.listLegacyActionTypeInventory.queryOptions(),
	);
	const [confirm, setConfirm] = useState("");
	const disable = useMutation({
		mutationFn: (
			actionType: Parameters<
				typeof osApi.mcpGovernance.setActionTypeOptIn
			>[0]["actionType"],
		) => osApi.mcpGovernance.setActionTypeOptIn({ actionType, enabled: false }),
		onSuccess: async () => {
			setConfirm("");
			await client.invalidateQueries({
				queryKey: osQuery.mcpGovernance.listLegacyActionTypeInventory.key({
					type: "query",
				}),
			});
		},
	});
	return (
		<section
			className="grid gap-3 border-t border-kumo-hairline px-4 py-3"
			aria-label="Legacy action grants"
		>
			<h3>Legacy action grants</h3>
			<Text as="p" role="label" tone="secondary">
				These older grants apply to an action class, including tools that later
				declare that class. Review the source tools below and create exact tool
				policies before turning off a grant. This list is an inventory, not a
				promise that every tool can run automatically; it excludes shared and
				mounted tools and may be incomplete.
			</Text>
			{inventory.isLoading ? <p>Loading legacy grants…</p> : null}
			{inventory.isError ? (
				<p role="alert">Could not load legacy grants.</p>
			) : null}
			{inventory.data?.truncated ? (
				<p role="alert">
					The inventory is limited; additional grants or tools may exist.
				</p>
			) : null}
			{inventory.data && inventory.data.grants.length === 0 ? (
				<p>No active legacy grants were returned.</p>
			) : null}
			<ul>
				{(inventory.data?.grants ?? []).map((grant) => (
					<li key={grant.grantId}>
						<strong>{grant.actionType.replaceAll("_", " ")}</strong>
						<p>
							Grant {grant.grantId} · created {grant.createdAt}
						</p>
						<ul>
							{(inventory.data?.tools ?? [])
								.filter((tool) => tool.actionType === grant.actionType)
								.map((tool) => (
									<li key={tool.toolRowId}>
										{tool.appName} ({tool.appSlug}) · {tool.title} (
										{tool.toolId}){tool.enabled ? "" : " · disabled"}
									</li>
								))}
						</ul>
						{canChange ? (
							confirm === grant.grantId ? (
								<div>
									<p>
										Turn off this broad grant? Calls without another applicable
										approval will ask again.
									</p>
									<Button
										size="sm"
										disabled={disable.isPending}
										onClick={() =>
											disable.mutate(
												grant.actionType as Parameters<
													typeof osApi.mcpGovernance.setActionTypeOptIn
												>[0]["actionType"],
											)
										}
									>
										Turn off legacy grant
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => setConfirm("")}
									>
										Cancel
									</Button>
								</div>
							) : (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setConfirm(grant.grantId)}
								>
									Review turning off
								</Button>
							)
						) : null}
					</li>
				))}
			</ul>
			{disable.error ? <p role="alert">{disable.error.message}</p> : null}
		</section>
	);
}
