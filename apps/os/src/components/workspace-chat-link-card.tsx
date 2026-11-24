import { Plugs } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { AvailableWorkspaceConnection } from "@tedix/api-contract/schemas/workspace-available-connections";
import { Button } from "@/components/kumo/button";
import { Checkbox } from "@/components/kumo/checkbox";
import { Text } from "@/components/kumo/text";
import { ChatCard } from "@/components/workspace-chat-card";
import { osApi } from "@/lib/api";
import {
	osQuery,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";

type LinkResult = {
	added: Array<{ id: string; name: string }>;
	failed: Array<{ id: string; message: string }>;
};

/** Presenting this card has no write effect. Only its button invokes onAdd. */
export function ConnectionLinkCard({
	connections,
	reason,
	added = [],
	onAdd,
}: {
	connections: AvailableWorkspaceConnection[];
	reason: string;
	added?: Array<{ id: string; name: string }>;
	onAdd: (ids: string[]) => Promise<LinkResult>;
}) {
	const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
	const [result, setResult] = useState<LinkResult>({ added: [], failed: [] });
	const [busy, setBusy] = useState(false);
	const inFlight = useRef(false);
	const [error, setError] = useState("");
	const successes = new Map(
		[...added, ...result.added].map((item) => [item.id, item]),
	);
	const remaining = connections.filter(
		(connection) => !successes.has(connection.id),
	);
	const selected = remaining
		.filter(
			(connection) =>
				connection.connectedForYou === true && !unchecked.has(connection.id),
		)
		.map((connection) => connection.id);
	async function add() {
		if (inFlight.current || !selected.length) return;
		inFlight.current = true;
		setBusy(true);
		setError("");
		try {
			const next = await onAdd(selected);
			setResult((previous) => ({
				added: [...previous.added, ...next.added],
				failed: next.failed,
			}));
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: "The connections could not be added",
			);
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	}
	return (
		<ChatCard
			data-testid="workspace-chat-link"
			icon={<Plugs />}
			title="Add connections to workspace"
			actions={
				remaining.length ? (
					<Button
						size="sm"
						disabled={busy || !selected.length}
						onClick={() => void add()}
					>
						{busy ? "Adding…" : "Add to workspace"}
					</Button>
				) : undefined
			}
		>
			<Text role="body">{reason}</Text>
			<div className="grid gap-2">
				{remaining.map((connection) => (
					<Checkbox
						key={connection.id}
						label={`${connection.service}${connection.label !== connection.service ? ` · ${connection.label}` : ""} (${connection.connectionScope}${connection.hybrid ? ", hybrid" : ""})`}
						checked={!unchecked.has(connection.id)}
						disabled={busy || connection.connectedForYou !== true}
						onCheckedChange={(checked) =>
							setUnchecked((previous) => {
								const next = new Set(previous);
								if (checked) next.delete(connection.id);
								else next.add(connection.id);
								return next;
							})
						}
					/>
				))}
			</div>
			{[...successes.values()].map((item) => (
				<Text role="caption" key={item.id}>
					Added {item.name}
				</Text>
			))}
			{result.failed.map((item) => (
				<Text role="caption" tone="error" key={item.id}>
					{item.message}
				</Text>
			))}
			{error ? (
				<Text role="caption" tone="error">
					{error}
				</Text>
			) : null}
			{!remaining.length && !successes.size ? (
				<Text role="caption" tone="secondary">
					These choices are no longer available to you. Ask the agent to check
					your connections again.
				</Text>
			) : null}
		</ChatCard>
	);
}

export function WorkspaceConnectionLinkCard({
	workspaceId,
	request,
}: {
	workspaceId: string;
	request: { connections: string[]; reason: string };
}) {
	const queryClient = useQueryClient();
	const inventory = useQuery(
		osQuery.osWorkspaces.resources.availableConnections.queryOptions({
			input: { workspaceId },
		}),
	);
	const sources = useQuery(workspaceResourcesQueryOptions(workspaceId));
	if (inventory.isPending || sources.isPending)
		return <Text role="caption">Checking connection choices…</Text>;
	if (inventory.isError || sources.isError)
		return (
			<Text role="caption" tone="error">
				Connection choices could not be checked. You need workspace edit access.
			</Text>
		);
	const ids = new Set(request.connections);
	const added = (sources.data?.items ?? [])
		.filter(
			(source) =>
				source.status === "active" &&
				source.resourceType === "account" &&
				ids.has(source.providerResourceId),
		)
		.map((source) => ({ id: source.providerResourceId, name: source.name }));
	return (
		<ConnectionLinkCard
			connections={(inventory.data ?? []).filter((connection) =>
				ids.has(connection.id),
			)}
			reason={request.reason}
			added={added}
			onAdd={async (connections) => {
				const result = await osApi.osWorkspaces.resources.linkConnections({
					workspaceId,
					connections,
				});
				await queryClient.invalidateQueries({
					queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
				});
				return result;
			}}
		/>
	);
}
