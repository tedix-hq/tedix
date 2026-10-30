import { createRoot } from "react-dom/client";
import { EntityAvatar } from "../src/shared/entity-avatar";
import { WorkActorAvatar } from "../src/components/work-actor-avatar";
import {
	ENTITY_AVATAR_PALETTE,
	entityAvatarIndex,
} from "../src/shared/entity-avatar-utils";
import "../src/styles.css";

const ids = ENTITY_AVATAR_PALETTE.map((_, index) => {
	let id = 0;
	while (entityAvatarIndex(`fixture-${id}`) !== index) id++;
	return `fixture-${id}`;
});

createRoot(document.getElementById("root")!).render(
	<main className="flex gap-4 p-6">
		{ids.map((id) => (
			<EntityAvatar key={id} id={id} name="Research" kind="workspace" />
		))}
		<EntityAvatar id="tedi-fixture" name="Support" kind="tedi" />
		<WorkActorAvatar
			actor={{ type: "tedi", id: "tedi-fixture" }}
			name="Support"
		/>
	</main>,
);
