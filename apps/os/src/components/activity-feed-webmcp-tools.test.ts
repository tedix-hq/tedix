import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { webMcpError, webMcpResult } from "@tedix/webmcp-core/model-context";
import { ActivityFeedItemSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import {
	buildActivityFeedTools,
	type FeedController,
} from "./activity-feed-webmcp-tools";

const item = ActivityFeedItemSchema.parse({
	id: "factory:pine:1",
	actor: "Pine",
	sentence: "A supplier replied.",
	source: "/outputs/pine",
	projectId: null,
	tediId: null,
	workItemId: null,
	kind: "result",
	classId: "supplier",
	importance: "normal",
	at: "2026-10-17T12:00:00.000Z",
	dueAt: null,
	needsAction: false,
	stalled: false,
	done: false,
	explanation: "Source message",
	reactions: ["more", "why", "mute", "comment"],
});

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Feed tools must use the visible controller, not fetch");
		}),
	);
});

afterEach(() => {
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});

it("uses the visible card's reaction callback and rejects stale ids and empty corrections", async () => {
	const react = vi.fn(async () => true);
	const tools = buildActivityFeedTools(() => ({
		items: [item],
		busy: false,
		react,
	}));
	const write = tools.find((t) => t.name === "react_activity_feed")!;
	const stale = await write.execute({ itemId: "gone", reaction: "mute" });
	expect(stale.isError).toBe(true);
	expect(
		(await write.execute({ itemId: item.id, reaction: "comment", text: " " }))
			.isError,
	).toBe(true);
	expect(react).not.toHaveBeenCalled();
	await write.execute({ itemId: item.id, reaction: "more" });
	expect(react).toHaveBeenCalledExactlyOnceWith(item, "more", "");
	expect(tools.map((tool) => tool.name)).toEqual([
		"read_activity_feed",
		"react_activity_feed",
	]);
});

it.each(["read_activity_feed", "react_activity_feed"])(
	"resolves %s controller failures without exposing diagnostics",
	async (name) => {
		const react = vi.fn(async () => true);
		let available = true;
		const current = vi.fn(() => {
			if (!available) throw new Error("private controller diagnostic");
			return { items: [item], busy: false, react };
		});
		const tool = buildActivityFeedTools(current).find((t) => t.name === name)!;
		expect(current).not.toHaveBeenCalled();
		available = false;
		await expect(
			tool.execute({ itemId: item.id, reaction: "more" }),
		).resolves.toEqual(
			webMcpError(
				name === "read_activity_feed"
					? "The feed could not be read. Read the feed again."
					: "The reaction could not be saved.",
			),
		);
		expect(current).toHaveBeenCalledTimes(1);
		expect(react).not.toHaveBeenCalled();
		if (name === "read_activity_feed") {
			expect(tool.annotations).toEqual({
				readOnlyHint: true,
				untrustedContentHint: true,
			});
		}
	},
);

it("reads execute-time items and uses only the replacement controller's callback", async () => {
	const oldReact = vi.fn(async () => true);
	const react = vi.fn(async () => true);
	let state: FeedController = { items: [item], busy: false, react: oldReact };
	const current = vi.fn(() => state);
	const tools = buildActivityFeedTools(current);
	const read = tools.find((tool) => tool.name === "read_activity_feed")!;
	const write = tools.find((tool) => tool.name === "react_activity_feed")!;
	expect(current).not.toHaveBeenCalled();
	const replacement = { ...item, id: "factory:pine:2" };
	state = { items: [replacement], busy: false, react };
	await expect(read.execute({})).resolves.toEqual(
		webMcpResult({ items: [replacement] }),
	);
	await expect(
		write.execute({ itemId: item.id, reaction: "mute" }),
	).resolves.toEqual(
		webMcpError(
			"The item is no longer visible or a write is pending. Read the feed again.",
		),
	);
	expect(react).not.toHaveBeenCalled();
	await expect(
		write.execute({ itemId: replacement.id, reaction: "mute" }),
	).resolves.toEqual(webMcpResult({ saved: true, itemId: replacement.id }));
	expect(react).toHaveBeenCalledExactlyOnceWith(replacement, "mute", "");
	expect(oldReact).not.toHaveBeenCalled();
	expect(current).toHaveBeenCalledTimes(3);
});

it("checks busy state at execution, allows reads, and rejects writes", async () => {
	const react = vi.fn(async () => true);
	let state = { items: [item], busy: false, react };
	const tools = buildActivityFeedTools(() => state);
	const read = tools.find((tool) => tool.name === "read_activity_feed")!;
	const write = tools.find((tool) => tool.name === "react_activity_feed")!;
	state = { ...state, busy: true };
	await expect(read.execute({})).resolves.toEqual(
		webMcpResult({ items: [item] }),
	);
	await expect(
		write.execute({ itemId: item.id, reaction: "more" }),
	).resolves.toEqual(
		webMcpError(
			"The item is no longer visible or a write is pending. Read the feed again.",
		),
	);
	expect(react).not.toHaveBeenCalled();
});

it.each(["why", "approve", "execute_work", ""])(
	"rejects unsupported reaction %j without calling the controller callback",
	async (reaction) => {
		const react = vi.fn(async () => true);
		const tools = buildActivityFeedTools(() => ({
			items: [item],
			busy: false,
			react,
		}));
		const write = tools.find((tool) => tool.name === "react_activity_feed")!;
		await expect(write.execute({ itemId: item.id, reaction })).resolves.toEqual(
			webMcpError("Unknown reaction."),
		);
		expect(react).not.toHaveBeenCalled();
	},
);

it.each(["false", "rejected", "throwing"])(
	"bounds %s callback failures and calls the callback only once",
	async (failure) => {
		const react = vi.fn(() => {
			if (failure === "throwing")
				throw new Error("private callback diagnostic");
			return failure === "rejected"
				? Promise.reject(new Error("private callback diagnostic"))
				: Promise.resolve(false);
		});
		const tools = buildActivityFeedTools(() => ({
			items: [item],
			busy: false,
			react,
		}));
		const write = tools.find((tool) => tool.name === "react_activity_feed")!;
		await expect(
			write.execute({
				itemId: item.id,
				reaction: "comment",
				text: " correction ",
			}),
		).resolves.toEqual(webMcpError("The reaction could not be saved."));
		expect(react).toHaveBeenCalledExactlyOnceWith(
			item,
			"comment",
			"correction",
		);
	},
);

it("saves a trimmed correction through exactly one visible callback", async () => {
	const react = vi.fn(async () => true);
	const tools = buildActivityFeedTools(() => ({
		items: [item],
		busy: false,
		react,
	}));
	const write = tools.find((tool) => tool.name === "react_activity_feed")!;
	await expect(
		write.execute({
			itemId: item.id,
			reaction: "comment",
			text: " \n Already replied. \t ",
		}),
	).resolves.toEqual(webMcpResult({ saved: true, itemId: item.id }));
	expect(react).toHaveBeenCalledExactlyOnceWith(
		item,
		"comment",
		"Already replied.",
	);
});
