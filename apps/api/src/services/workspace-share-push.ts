/**
 * Push for sharing: tell a person in the browser that a workspace was shared
 * with them. It goes to the invited person only, on every device they turned
 * notifications on for, and carries no more than who shared which workspace.
 * The caller decides that access was really granted before asking for this.
 */

import {
	WebPushPreferencesSchema,
	workspaceMuteState,
} from "@tedix/api-contract/schemas/web-push";
import { listTedixPersonMemberships } from "@tedix/db/queries/os-collaborators";
import { listPushConfigs } from "@tedix/db/queries/web-push";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { BaseContext } from "../rpc/context";
import { sendPushToDevices, webPushKeys } from "./web-push";
import { workspacePushVisibilityKey } from "./workspace-chat-push";

export async function notifyWorkspaceShared(
	context: BaseContext,
	db: DbQueryClient,
	input: {
		workspace: { id: string; name: string };
		/** The invited person and the person who added them, by sign-in id. */
		inviteeUserId: string;
		sharerUserId: string;
		sharerName: string | null;
	},
): Promise<{ notified: number }> {
	const keys = webPushKeys(context.env);
	if (!keys || input.inviteeUserId === input.sharerUserId)
		return { notified: 0 };
	const { workspace } = input;
	let notified = 0;
	// Devices are registered per organization, so each one the person belongs
	// to is asked.
	for (const scope of await listTedixPersonMemberships(
		db,
		input.inviteeUserId,
	)) {
		const preferences = WebPushPreferencesSchema.safeParse(
			(await listPushConfigs(db, scope, "preferences"))[0]?.value,
		);
		if (
			preferences.success &&
			workspaceMuteState(preferences.data, workspace.id, Date.now()).muted
		)
			continue;
		await sendPushToDevices(context, scope, keys, {
			title: `${input.sharerName ?? "Someone"} shared ${workspace.name} with you`,
			body: "Open it in Tedix under Workspaces, Shared with you.",
			url: `/shared/workspace/${workspace.id}`,
			conversationId: workspacePushVisibilityKey(workspace.id),
			tag: `share:${workspace.id}`,
		});
		notified += 1;
	}
	return { notified };
}
