import type { CollabParticipant } from "@/collab/presence";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Popover, PopoverContent } from "@/components/kumo/popover";
import { Text } from "@/components/kumo/text";
import { sentenceCase } from "@/lib/format";

const MAX_VISIBLE = 3;
const AVATAR_COLORS = [
	"#2563eb",
	"#7c3aed",
	"#c026d3",
	"#dc2626",
	"#d97706",
	"#059669",
	"#0891b2",
] as const;

function initials(name: string): string {
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toLocaleUpperCase())
		.join("");
}

function colorFor(key: string): string {
	let value = 0;
	for (const character of key)
		value = (value * 31 + character.charCodeAt(0)) | 0;
	return AVATAR_COLORS[Math.abs(value) % AVATAR_COLORS.length] as string;
}

function locationLabel(participant: CollabParticipant): string {
	const location = participant.location;
	if (!location) return "Canvas";
	return location.artifactLabel
		? `Canvas · ${location.artifactLabel}`
		: location.artifactKind
			? `Canvas · ${sentenceCase(location.artifactKind)}`
			: "Canvas";
}

function avatar(participant: CollabParticipant, size: "large" | "small") {
	return (
		<span
			className={
				size === "small"
					? "canvas-presence-avatar canvas-presence-avatar-small"
					: "canvas-presence-avatar"
			}
			style={{ backgroundColor: colorFor(participant.key) }}
			aria-hidden="true"
		>
			{initials(participant.displayName)}
		</span>
	);
}

/** Compact roster backed by the room's server-asserted presence projection. */
export function CanvasPresence({
	participants,
}: {
	participants: CollabParticipant[];
}) {
	if (participants.length === 0) return null;
	const visible = participants.slice(0, MAX_VISIBLE);
	const overflow = participants.length - visible.length;
	const label = `${participants.length} ${participants.length === 1 ? "collaborator" : "collaborators"} here now`;

	return (
		<Popover>
			<Popover.Trigger
				render={
					<Button
						className="canvas-presence-trigger"
						aria-label={`${label}. Open collaborator details.`}
						multiline
						variant="ghost"
					>
						<span className="canvas-presence-stack">
							{visible.map((participant) => (
								<span
									key={participant.key}
									className="canvas-presence-pop"
									title={`${participant.displayName} · ${sentenceCase(participant.kind)}`}
								>
									{avatar(participant, "small")}
								</span>
							))}
							{overflow > 0 && (
								<span className="canvas-presence-overflow">+{overflow}</span>
							)}
						</span>
						<span className="canvas-presence-online" aria-hidden="true" />
					</Button>
				}
			/>
			<PopoverContent
				align="end"
				sideOffset={6}
				/* The adapter layers the positioner above the editor toolbar. Keep
				 * this popup on PopoverContent rather than Kumo's compound Content. */
				className="!w-[280px] !min-w-0 max-h-[min(60vh,420px)] overflow-hidden rounded-2xl bg-kumo-base p-1 shadow-tedix-floating"
			>
				<Popover.Title className="px-2.5 pt-1.5 pb-1 text-kumo-subtle text-xs">
					{label}
				</Popover.Title>
				<div className="max-h-[350px] overflow-y-auto">
					{participants.map((participant) => (
						<div
							key={participant.key}
							className="flex items-center gap-2.5 rounded-xl px-2.5 py-2"
						>
							{avatar(participant, "large")}
							<span className="min-w-0 flex-1">
								<Text
									as="span"
									role="label"
									weight="medium"
									className="block truncate"
								>
									{participant.displayName}
								</Text>
								<Text
									as="span"
									className="block truncate"
									role="caption"
									tone="secondary"
								>
									{sentenceCase(participant.kind)} ·{" "}
									{locationLabel(participant)}
									{participant.sessions > 1
										? ` · ${participant.sessions} sessions`
										: ""}
								</Text>
							</span>
							<Badge variant="secondary">
								{sentenceCase(participant.role)}
							</Badge>
						</div>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
