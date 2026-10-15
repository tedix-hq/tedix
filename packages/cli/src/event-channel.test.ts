import { describe, expect, test } from "bun:test";
import {
	channelNotice,
	handleChannelMessage,
	parseChannelFilters,
	planSubscriptions,
	pollOnce,
	runEventChannel,
	type ChannelSubscription,
} from "./event-channel";

const ORG = "00000000-0000-4000-8000-000000000001";
const ITEM = "00000000-0000-4000-8000-0000000000a1";

const listResult = {
	events: [
		{
			name: "work.interaction.responded",
			delivery: ["webhook"],
			inputSchema: { properties: { organization_id: {}, request_id: {} } },
		},
		{
			name: "work.item.commented",
			delivery: ["poll", "webhook"],
			inputSchema: {
				properties: { organization_id: {}, work_item_id: {}, author_type: {} },
			},
		},
		{
			name: "skill.run.failed",
			delivery: ["poll"],
			inputSchema: {
				properties: { organization_id: {}, tedi_id: {}, skill_id: {} },
			},
		},
	],
};

describe("planSubscriptions", () => {
	test("subscribes to every pollable event and passes only accepted filters", () => {
		const plan = planSubscriptions({
			listResult,
			organizationId: ORG,
			requested: [],
			filters: { work_item_id: ITEM },
		});
		expect(plan).toEqual([
			{
				name: "work.item.commented",
				cursor: null,
				arguments: { organization_id: ORG, work_item_id: ITEM },
			},
			{
				name: "skill.run.failed",
				cursor: null,
				arguments: { organization_id: ORG },
			},
		]);
	});

	test("rejects webhook-only events and filters no event accepts", () => {
		expect(() =>
			planSubscriptions({
				listResult,
				organizationId: ORG,
				requested: ["work.interaction.responded"],
				filters: {},
			}),
		).toThrow(/not offered for polling/);
		expect(() =>
			planSubscriptions({
				listResult,
				organizationId: ORG,
				requested: ["skill.run.failed"],
				filters: { work_item_id: ITEM },
			}),
		).toThrow(/No selected event accepts/);
	});
});

test("parseChannelFilters keeps the organization out of --param", () => {
	expect(parseChannelFilters(["work_item_id=abc"])).toEqual({
		work_item_id: "abc",
	});
	expect(() => parseChannelFilters(["organization_id=x"])).toThrow();
	expect(() => parseChannelFilters(["bad"])).toThrow();
});

describe("pollOnce", () => {
	test("bootstraps from now, then delivers each new event once", async () => {
		const calls: unknown[] = [];
		const pages = [
			{
				events: [
					{
						eventId: "old",
						name: "work.item.commented",
						timestamp: "1",
						data: {},
					},
				],
				cursor: "c1",
				hasMore: false,
				nextPollMs: 30_000,
			},
			{
				events: [
					{
						eventId: "e1",
						name: "work.item.commented",
						timestamp: "2",
						data: { work_item_id: ITEM },
					},
				],
				cursor: "c2",
				hasMore: false,
				nextPollMs: 30_000,
			},
			{
				events: [
					{
						eventId: "e1",
						name: "work.item.commented",
						timestamp: "2",
						data: {},
					},
				],
				cursor: "c3",
				hasMore: false,
				nextPollMs: 10_000,
			},
		];
		const client = {
			rawRequest: async (method: string, params: Record<string, unknown>) => {
				calls.push({ method, params });
				return pages.shift();
			},
		};
		const subscriptions: ChannelSubscription[] = [
			{
				name: "work.item.commented",
				arguments: { organization_id: ORG },
				cursor: null,
			},
		];
		const seen = new Set<string>();
		expect((await pollOnce(client, subscriptions, seen)).events).toEqual([]);
		const second = await pollOnce(client, subscriptions, seen);
		expect(second.events.map((e) => e.eventId)).toEqual(["e1"]);
		const third = await pollOnce(client, subscriptions, seen);
		expect(third.events).toEqual([]);
		expect(third.nextPollMs).toBe(10_000);
		expect(calls).toEqual([
			{
				method: "events/poll",
				params: {
					name: "work.item.commented",
					arguments: { organization_id: ORG },
					cursor: null,
				},
			},
			{
				method: "events/poll",
				params: {
					name: "work.item.commented",
					arguments: { organization_id: ORG },
					cursor: "c1",
				},
			},
			{
				method: "events/poll",
				params: {
					name: "work.item.commented",
					arguments: { organization_id: ORG },
					cursor: "c2",
				},
			},
		]);
	});
});

test("channelNotice carries IDs as tag attributes and never the organization", () => {
	const notice = channelNotice({
		eventId: "evt_comment_1",
		name: "work.item.commented",
		timestamp: "2026-10-16T00:00:00Z",
		data: {
			organization_id: ORG,
			work_item_id: ITEM,
			comment_id: "c-1",
			author_type: "user",
			author_id: null,
		},
	});
	expect(notice.content).toBe(
		`New user comment c-1 on Work Item ${ITEM}. Read the current record before acting.`,
	);
	expect(notice.meta).toEqual({
		event: "work.item.commented",
		work_item_id: ITEM,
		comment_id: "c-1",
		author_type: "user",
	});
});

test("initialize answers on a legacy revision and declares the channel", () => {
	const response = handleChannelMessage({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-06-18" },
	});
	expect(response?.result).toMatchObject({
		protocolVersion: "2025-06-18",
		capabilities: { experimental: { "claude/channel": {} } },
	});
	expect(
		handleChannelMessage({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		}),
	).toBeNull();
	expect(
		handleChannelMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" })
			?.error,
	).toMatchObject({ code: -32601 });
});

test("runEventChannel answers stdio and pushes a channel notification per event", async () => {
	const written: string[] = [];
	let polls = 0;
	const client = {
		rawRequest: async () => {
			polls++;
			return polls === 1
				? { events: [], cursor: "c1", hasMore: false, nextPollMs: 1 }
				: {
						events: [
							{
								eventId: `e${polls}`,
								name: "skill.run.failed",
								timestamp: String(polls),
								data: { run_id: `r${polls}`, error_class: "execution" },
							},
						],
						cursor: `c${polls}`,
						hasMore: false,
						nextPollMs: 1,
					};
		},
	};
	let release: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		release = resolve;
	});
	async function* input() {
		yield `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`;
		await closed;
	}
	const run = runEventChannel({
		client,
		resolveSubscriptions: async () => [
			{
				name: "skill.run.failed",
				arguments: { organization_id: ORG },
				cursor: null,
			},
		],
		io: { input: input(), write: (line) => written.push(line), log: () => {} },
		signal: new AbortController().signal,
		minPollMs: 1,
	});
	while (!written.some((line) => line.includes("notifications/claude/channel")))
		await new Promise((resolve) => setTimeout(resolve, 5));
	release();
	await run;
	expect(JSON.parse(written[0] as string).id).toBe(1);
	const notice = JSON.parse(
		written.find((line) => line.includes("notifications/claude/channel"))!,
	);
	expect(notice.params.meta).toMatchObject({
		event: "skill.run.failed",
		run_id: "r2",
	});
});
