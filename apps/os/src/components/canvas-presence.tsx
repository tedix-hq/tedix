import type { CollabParticipant } from "@/collab/presence";
import { Avatar, AvatarFallback } from "@/components/kumo/avatar";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { EntityAvatar } from "@/components/entity-avatar";
import { Popover, PopoverContent } from "@/components/kumo/popover";
import { Text } from "@/components/kumo/text";
import { sentenceCase } from "@/lib/format";
import "./canvas-page.css";

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

/** Stable per-collaborator colour for document carets and sheet selections. */
export function collabParticipantColor(key: string): string {
	let value = 0;
	for (const character of key)
		value = (value * 31 + character.charCodeAt(0)) | 0;
	return AVATAR_COLORS[Math.abs(value) % AVATAR_COLORS.length] as string;
}

/** The item open on this screen, so the roster can mark who is in it too. */
export interface CanvasPresenceOpenItem {
	kind: "gadget" | "output";
	label: string;
}

/** One short line saying where a collaborator is. */
export function presenceWhereLabel(
	participant: CollabParticipant,
	openItem?: CanvasPresenceOpenItem | null,
): string {
	const location = participant.location;
	if (
		openItem &&
		location?.artifactKind === openItem.kind &&
		location.artifactLabel === openItem.label
	) {
		return openItem.kind === "gadget" ? "In this app" : "In this file";
	}
	return location?.artifactLabel
		? `Viewing ${location.artifactLabel}`
		: "In this workspace";
}

function avatar(participant: CollabParticipant, size: "large" | "small") {
	return (
		<EntityAvatar
			kind="person"
			id={participant.key}
			name={participant.displayName}
			className={
				size === "small" ? "size-(--tedix-topbar-avatar-size)" : "size-7"
			}
		/>
	);
}

/** Compact roster backed by the room's server-asserted presence projection. */
export function CanvasPresence({
	participants,
	openItem,
}: {
	participants: CollabParticipant[];
	openItem?: CanvasPresenceOpenItem | null;
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
						className="canvas-presence-trigger !w-auto !px-1"
						aria-label={`${label}. Open collaborator details.`}
						size="icon-sm"
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
								<Avatar
									size="sm"
									className="size-(--tedix-topbar-avatar-size) flex-none ring-0"
								>
									<AvatarFallback className="font-semibold text-kumo-default type-tedix-caption">
										+{overflow}
									</AvatarFallback>
								</Avatar>
							)}
							<span className="canvas-presence-online" aria-hidden="true" />
						</span>
					</Button>
				}
			/>
			<PopoverContent
				align="end"
				sideOffset={6}
				/* The adapter layers the positioner above the editor toolbar. Keep
				 * this popup on PopoverContent rather than Kumo's compound Content. */
				className="!w-[280px] !min-w-0 max-h-[min(60dvh,420px,var(--available-height))] overflow-hidden rounded-2xl bg-kumo-base p-1 shadow-tedix-floating"
			>
				<Popover.Title className="px-2.5 pt-1.5 pb-1 text-kumo-subtle text-xs">
					{label}
				</Popover.Title>
				<div className="min-h-0 max-h-[350px] overflow-y-auto overscroll-contain">
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
									{presenceWhereLabel(participant, openItem)}
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
