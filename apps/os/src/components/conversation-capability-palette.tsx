import { Paperclip, PuzzlePiece, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Capability } from "@tedix/api-contract/contracts/capabilities";
import type { ConversationCapability } from "@tedix/api-contract/schemas/kernel-runtime";
import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	activeCapabilitiesQueryOptions,
	conversationArtifactPinsQueryOptions,
	conversationCapabilitiesQueryOptions,
} from "@/lib/os-query-options";

const REPLAY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

function replayNameFor(capability: Capability): string {
	const normalized = capability.slug.replaceAll("-", "_");
	return /^[a-z]/.test(normalized) ? normalized : `cap_${normalized}`;
}

function provenanceLabel(capability: ConversationCapability): string {
	const attachedAt = new Date(capability.whyPresent.attachedAt);
	const when = Number.isNaN(attachedAt.getTime())
		? capability.whyPresent.attachedAt
		: attachedAt.toLocaleString();
	return `Attached by ${capability.whyPresent.type} ${capability.whyPresent.actorId} on ${when}`;
}

export function ConversationCapabilityPalette({
	conversationId,
}: {
	conversationId: string;
}) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [selectedId, setSelectedId] = useState("");
	const [replayName, setReplayName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [artifactId, setArtifactId] = useState("");
	const [artifactReplayName, setArtifactReplayName] = useState("");
	const attachedQuery = useQuery(
		conversationCapabilitiesQueryOptions(conversationId),
	);
	const catalogQuery = useQuery(activeCapabilitiesQueryOptions());
	const pinsQuery = useQuery(
		conversationArtifactPinsQueryOptions(conversationId),
	);
	const pins = pinsQuery.data?.pins ?? [];
	const attached = attachedQuery.data?.capabilities ?? [];
	const attachedIds = useMemo(
		() => new Set(attached.map((capability) => capability.capabilityId)),
		[attached],
	);
	const available = (catalogQuery.data?.data ?? []).filter(
		(capability) => !attachedIds.has(capability.id),
	);

	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: conversationCapabilitiesQueryOptions(conversationId).queryKey,
		});
	const attach = useMutation({
		mutationFn: () =>
			osApi.kernelRuntime.attachConversationCapability({
				conversationId,
				capabilityId: selectedId,
				replayName,
			}),
		onSuccess: async () => {
			setSelectedId("");
			setReplayName("");
			setError(null);
			await refresh();
		},
		onError: (cause) =>
			setError(
				cause instanceof Error ? cause.message : "Could not attach capability.",
			),
	});
	const detach = useMutation({
		mutationFn: (referenceId: string) =>
			osApi.kernelRuntime.detachConversationCapability({
				conversationId,
				referenceId,
			}),
		onSuccess: refresh,
		onError: (cause) =>
			setError(
				cause instanceof Error ? cause.message : "Could not detach capability.",
			),
	});
	const refreshPins = () =>
		queryClient.invalidateQueries({
			queryKey: conversationArtifactPinsQueryOptions(conversationId).queryKey,
		});
	const pinArtifact = useMutation({
		mutationFn: () =>
			osApi.kernelRuntime.attachConversationArtifactPin({
				conversationId,
				artifactId,
				replayName: artifactReplayName,
			}),
		onSuccess: async () => {
			setArtifactId("");
			setArtifactReplayName("");
			setError(null);
			await refreshPins();
		},
		onError: (cause) =>
			setError(
				cause instanceof Error ? cause.message : "Could not pin artifact.",
			),
	});
	const unpinArtifact = useMutation({
		mutationFn: (pinId: string) =>
			osApi.kernelRuntime.detachConversationArtifactPin({
				conversationId,
				pinId,
			}),
		onSuccess: refreshPins,
		onError: (cause) =>
			setError(
				cause instanceof Error
					? cause.message
					: "Could not detach artifact pin.",
			),
	});

	const selectCapability = (capabilityId: string | null) => {
		if (!capabilityId) return;
		const capability = available.find(
			(candidate) => candidate.id === capabilityId,
		);
		setSelectedId(capabilityId);
		setReplayName(capability ? replayNameFor(capability) : "");
		setError(null);
	};
	const replayNameValid = REPLAY_NAME_PATTERN.test(replayName);

	return (
		<>
			<Button
				aria-label="Conversation capabilities"
				size="sm"
				variant="outline"
				onClick={() => setOpen(true)}
			>
				<PuzzlePiece aria-hidden className="size-4" />
				Capabilities
				{attached.length > 0 ? <Badge>{attached.length}</Badge> : null}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Conversation capabilities</DialogTitle>
						<DialogDescription>
							Attach named organizational capabilities as context for this
							conversation. They do not grant tools, MCP scopes, or FGA access;
							every action still passes the existing authorization and policy
							gates.
						</DialogDescription>
					</DialogHeader>

					{error ? (
						<Alert variant="destructive">
							<AlertTitle>Capability update failed</AlertTitle>
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					<div className="grid gap-3 rounded-lg border border-kumo-line p-3">
						<Label htmlFor="conversation-capability">Add capability</Label>
						<Select value={selectedId} onValueChange={selectCapability}>
							<SelectTrigger
								id="conversation-capability"
								aria-label="Capability"
							>
								<SelectValue placeholder="Choose an active capability" />
							</SelectTrigger>
							<SelectContent>
								{available.map((capability) => (
									<SelectItem key={capability.id} value={capability.id}>
										{capability.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Label htmlFor="conversation-capability-replay-name">
							Replay name
						</Label>
						<Input
							id="conversation-capability-replay-name"
							value={replayName}
							onChange={(event) => setReplayName(event.currentTarget.value)}
							placeholder="customer_research"
							aria-describedby="conversation-capability-replay-help"
						/>
						<Text
							id="conversation-capability-replay-help"
							role="caption"
							tone="secondary"
						>
							Stable lowercase name used when this conversation is replayed.
							Letters, numbers, and underscores only; start with a letter.
						</Text>
						<Button
							disabled={!selectedId || !replayNameValid || attach.isPending}
							onClick={() => attach.mutate()}
						>
							{attach.isPending ? "Attaching…" : "Attach capability"}
						</Button>
					</div>

					<div className="grid gap-2" aria-label="Attached capabilities">
						{attachedQuery.isPending ? (
							<Text tone="secondary">Loading capabilities…</Text>
						) : attached.length === 0 ? (
							<Empty>
								<EmptyHeader>
									<EmptyTitle>No capabilities attached</EmptyTitle>
									<EmptyDescription>
										This conversation currently uses ordinary organization
										context.
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : (
							attached.map((capability) => (
								<div
									key={capability.id}
									className="flex items-start justify-between gap-3 rounded-lg border border-kumo-line p-3"
								>
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-2">
											<Text weight="medium">{capability.name}</Text>
											<Badge>Context only</Badge>
										</div>
										<Text role="caption" tone="mono-secondary">
											{capability.replayName}
										</Text>
										<Text role="caption" tone="secondary">
											{provenanceLabel(capability)}
										</Text>
									</div>
									<Button
										aria-label={`Detach ${capability.name}`}
										disabled={detach.isPending}
										size="icon-sm"
										variant="ghost"
										onClick={() => detach.mutate(capability.id)}
									>
										<X aria-hidden className="size-4" />
									</Button>
								</div>
							))
						)}
					</div>

					<div className="border-t border-kumo-line pt-4">
						<div className="mb-3 flex items-center gap-2">
							<Paperclip aria-hidden className="size-4" />
							<Text weight="medium">Pinned artifact revisions</Text>
						</div>
						<Text role="caption" tone="secondary">
							Pins accept platform-published single-file artifacts with a
							SHA-256 revision. They add context only and never grant artifact
							access or execution authority.
						</Text>
						<div className="mt-3 grid gap-3 rounded-lg border border-kumo-line p-3">
							<Label htmlFor="conversation-artifact-id">Artifact ID</Label>
							<Input
								id="conversation-artifact-id"
								value={artifactId}
								onChange={(event) => setArtifactId(event.currentTarget.value)}
								placeholder="Artifact ID from run evidence"
							/>
							<Label htmlFor="conversation-artifact-replay-name">
								Replay name
							</Label>
							<Input
								id="conversation-artifact-replay-name"
								value={artifactReplayName}
								onChange={(event) =>
									setArtifactReplayName(event.currentTarget.value)
								}
								placeholder="approved_report"
							/>
							<Button
								disabled={
									!artifactId.trim() ||
									!REPLAY_NAME_PATTERN.test(artifactReplayName) ||
									pinArtifact.isPending
								}
								onClick={() => pinArtifact.mutate()}
							>
								{pinArtifact.isPending ? "Pinning…" : "Pin revision"}
							</Button>
						</div>
						<div
							className="mt-3 grid gap-2"
							aria-label="Pinned artifact revisions"
						>
							{pins.map((pin) => (
								<div
									key={pin.id}
									className="flex items-start justify-between gap-3 rounded-lg border border-kumo-line p-3"
								>
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-2">
											<Text weight="medium">{pin.artifact.name}</Text>
											<Badge>
												{pin.state === "active" ? "Pinned revision" : "Stale"}
											</Badge>
										</div>
										<Text role="caption" tone="mono-secondary">
											{pin.replayName} · sha256:
											{pin.revision.digest.slice(0, 12)}…
										</Text>
										<Text role="caption" tone="secondary">
											Attached by {pin.whyPresent.type} {pin.whyPresent.actorId}
										</Text>
									</div>
									<Button
										aria-label={`Detach ${pin.artifact.name} pin`}
										disabled={unpinArtifact.isPending}
										size="icon-sm"
										variant="ghost"
										onClick={() => unpinArtifact.mutate(pin.id)}
									>
										<X aria-hidden className="size-4" />
									</Button>
								</div>
							))}
							{!pinsQuery.isPending && pins.length === 0 ? (
								<Text tone="secondary">No artifact revisions pinned.</Text>
							) : null}
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
