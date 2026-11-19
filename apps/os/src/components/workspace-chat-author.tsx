import { useContext } from "react";
import { Text } from "@/components/kumo/text";
import { WorkActorDirectoryContext } from "@/components/work-actor-avatar";
import { EntityAvatar } from "@/shared/entity-avatar";

export function WorkspaceChatAuthor({
	id,
	kind,
	tediNames,
}: {
	id: string;
	kind: "person" | "tedi";
	tediNames: Record<string, string>;
}) {
	const directory = useContext(WorkActorDirectoryContext);
	const profile =
		kind === "tedi"
			? directory.get(`tedi:${id}`)
			: (directory.get(`user:${id}`) ?? directory.get(`external_agent:${id}`));
	const name =
		profile?.name ??
		(kind === "tedi" ? (tediNames[id] ?? "Tedi") : "Workspace member");
	return (
		<div className="workspace-chat-author">
			<EntityAvatar
				id={id}
				kind={kind}
				name={name}
				image={profile?.image}
				className="size-5"
			/>
			<Text as="span" role="caption" tone="secondary">
				{name}
			</Text>
		</div>
	);
}
