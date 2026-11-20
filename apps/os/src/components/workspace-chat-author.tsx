import { useContext } from "react";
import { Text } from "@/components/kumo/text";
import { WorkActorDirectoryContext } from "@/components/work-actor-avatar";
import { EntityAvatar } from "@/shared/entity-avatar";

/** The name and picture of a person or tedi who wrote in a workspace chat. */
export function useWorkspaceChatAuthor(
	id: string,
	kind: "person" | "tedi",
	tediNames: Record<string, string>,
) {
	const directory = useContext(WorkActorDirectoryContext);
	const profile =
		kind === "tedi"
			? directory.get(`tedi:${id}`)
			: (directory.get(`user:${id}`) ?? directory.get(`external_agent:${id}`));
	return {
		name:
			profile?.name ??
			(kind === "tedi" ? (tediNames[id] ?? "Tedi") : "Workspace member"),
		image: profile?.image,
	};
}

export function WorkspaceChatAuthor({
	id,
	kind,
	tediNames,
}: {
	id: string;
	kind: "person" | "tedi";
	tediNames: Record<string, string>;
}) {
	const { name, image } = useWorkspaceChatAuthor(id, kind, tediNames);
	return (
		<div className="workspace-chat-author">
			<EntityAvatar
				id={id}
				kind={kind}
				name={name}
				image={image}
				className="size-6"
			/>
			<Text as="span" role="caption" tone="secondary">
				{name}
			</Text>
		</div>
	);
}
