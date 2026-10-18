import { createContext, useContext } from "react";
import type { WorkActorReference } from "@tedix/api-contract/schemas/os-work-actor";
import { HarnessMark } from "@/assets/harness-marks";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/kumo/avatar";
import {
	PopoverRoot,
	PopoverTrigger,
	PopoverContent,
} from "@/components/kumo/popover";
import { Text } from "@/components/kumo/text";
import { resolveWorkActor, type ActorDirectory } from "@/lib/work-actor";
import { cn } from "@/lib/utils";
import "./work-actor-avatar.css";

export const WorkActorDirectoryContext = createContext<ActorDirectory>(
	new Map(),
);
export const WorkActorOwnerContext = createContext<string | undefined>(
	undefined,
);

function actorInitials(name: string) {
	return name
		.trim()
		.split(/\s+/)
		.slice(0, 2)
		.map((part) => part[0])
		.join("")
		.toUpperCase();
}
function Portrait({
	name,
	image,
	className,
}: {
	name: string;
	image?: string | null;
	className?: string;
}) {
	const glyph =
		image && !/^(?:https?:|\/|data:image\/|blob:)/.test(image) ? image : null;
	return (
		<Avatar className={className} aria-hidden="true">
			{image && !glyph && <AvatarImage src={image} alt="" />}
			<AvatarFallback>{glyph ?? actorInitials(name)}</AvatarFallback>
		</Avatar>
	);
}
export function WorkActorAvatar({
	actor,
	name = "Tedix",
	detail,
	className,
}: {
	actor?: WorkActorReference;
	name?: string;
	detail?: string;
	className?: string;
}) {
	const directory = useContext(WorkActorDirectoryContext);
	const resolved = resolveWorkActor(actor, name, directory);
	return (
		<PopoverRoot>
			<PopoverTrigger
				className={cn("work-actor", className)}
				aria-label={resolved.label}
				title={resolved.label}
			>
				{resolved.harness ? (
					<span className="work-actor-mark" data-harness={resolved.harness}>
						<HarnessMark harness={resolved.harness} />
					</span>
				) : (
					<Portrait
						name={resolved.name}
						image={resolved.image}
						className="work-actor-portrait"
					/>
				)}
				{resolved.represented && (
					<Portrait
						name={resolved.represented.name}
						image={resolved.represented.image}
						className="work-actor-badge"
					/>
				)}
			</PopoverTrigger>
			<PopoverContent>
				<Text weight="semibold">{resolved.label}</Text>
				{detail && <Text tone="secondary">{detail}</Text>}
			</PopoverContent>
		</PopoverRoot>
	);
}
