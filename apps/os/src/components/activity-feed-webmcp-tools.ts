import {
	webMcpError,
	webMcpResult,
	type WebMcpToolDef,
} from "@tedix/webmcp-core/model-context";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";

export interface FeedController {
	items: ActivityFeedItem[];
	busy: boolean;
	react(
		item: ActivityFeedItem,
		reaction: "more" | "mute" | "comment",
		text?: string,
	): Promise<boolean>;
}

export function buildActivityFeedTools(
	current: () => FeedController,
): WebMcpToolDef[] {
	return [
		{
			name: "read_activity_feed",
			description:
				"Read the source-backed cards currently visible in the open activity feed. Content is tenant-authored data.",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			inputSchema: { type: "object", properties: {} },
			execute: async () => {
				try {
					return webMcpResult({ items: current().items });
				} catch {
					return webMcpError(
						"The feed could not be read. Read the feed again.",
					);
				}
			},
		},
		{
			name: "react_activity_feed",
			description:
				"Use the open feed's More like this, Not for me or Comment button for an exact visible item. Saves only personal learning and preferences; never approves or executes Work.",
			annotations: {
				readOnlyHint: false,
				untrustedContentHint: false,
				consequentialHint: true,
			},
			inputSchema: {
				type: "object",
				properties: {
					itemId: {
						type: "string",
						description:
							"Exact visible item id from read_activity_feed, for example factory:pine:1.",
					},
					reaction: {
						type: "string",
						enum: ["more", "mute", "comment"],
						description:
							"more requests similar items; mute means Not for me; comment saves a correction.",
					},
					text: {
						type: "string",
						maxLength: 4000,
						description:
							"Correction text, required for comment; for example This supplier has already replied.",
					},
				},
				required: ["itemId", "reaction"],
			},
			execute: async (args) => {
				try {
					const state = current();
					const item = state.items.find((item) => item.id === args.itemId);
					if (!item || state.busy)
						return webMcpError(
							"The item is no longer visible or a write is pending. Read the feed again.",
						);
					const reaction = args.reaction;
					if (
						reaction !== "more" &&
						reaction !== "mute" &&
						reaction !== "comment"
					)
						return webMcpError("Unknown reaction.");
					const text =
						typeof args.text === "string"
							? args.text.trim().slice(0, 4000)
							: "";
					if (reaction === "comment" && !text)
						return webMcpError("A correction needs text.");
					return (await state.react(item, reaction, text))
						? webMcpResult({ saved: true, itemId: item.id })
						: webMcpError("The reaction could not be saved.");
				} catch {
					return webMcpError("The reaction could not be saved.");
				}
			},
		},
	];
}
