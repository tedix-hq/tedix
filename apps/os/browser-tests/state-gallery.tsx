import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { StatusLine } from "../src/components/account-list";
import {
	ConversationRow,
	ConversationsEmpty,
} from "../src/components/chat-sidebar";
import {
	DeckCardSkeleton,
	DeckCompletion,
	DeckProgress,
} from "../src/components/deck-progress";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "../src/components/kumo/alert";
import { Button } from "../src/components/kumo/button";
import { Empty } from "../src/components/kumo/empty";
import { Surface } from "../src/components/kumo/surface";
import { Text } from "../src/components/kumo/text";
import { ListSkeleton } from "../src/components/list-skeleton";
import { KnowledgeMapEmpty } from "../src/components/memory-explorer";
import { SkillsEmpty } from "../src/components/skills-page";
import {
	TeamEmpty,
	TediRow,
	type TediDetailLinkProps,
} from "../src/components/team-page";
import { FeedCard } from "../src/components/focus-feed-card";
import { WorkReadNotice } from "../src/components/work-read-region";
import "../src/components/feed-timeline.css";
import "../src/components/focus-feed.css";
import "../src/styles.css";

const FRAME_NOW = "2026-01-15T09:00:00Z";
// This document is a fixture, including relative-time helpers without a clock prop.
globalThis.Date = class extends Date {
	constructor(value: string | number = FRAME_NOW) {
		super(value);
	}
	static now() {
		return Date.parse(FRAME_NOW);
	}
} as DateConstructor;

function TediLink({ children, className, params }: TediDetailLinkProps) {
	return (
		<a className={className} href={`/team/${params.tediId}`}>
			{children}
		</a>
	);
}

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const surfaces: {
	id: string;
	name: string;
	empty: ReactNode;
	partial?: ReactNode;
	gap?: string;
}[] = [
	{
		id: "feed",
		name: "Work Feed row list",
		empty: (
			<Empty
				appearance="quiet"
				title="Nothing waiting in Feed"
				description="New work will appear here."
			/>
		),
		partial: (
			<FeedCard
				actor="Mira"
				busy={false}
				onReact={async () => true}
				onWork={async () => {}}
				item={{
					id: "sample-result",
					actor: "Mira",
					sentence: "Morning review is ready",
					source: "/work?view=feed",
					projectId: null,
					tediId: null,
					workItemId: null,
					kind: "result",
					classId: "sample",
					importance: "normal",
					at: FRAME_NOW,
					dueAt: null,
					needsAction: false,
					stalled: false,
					done: true,
					explanation: "Saved result; one source is unavailable.",
					reactions: [],
					score: 1,
					unseen: false,
					deadline: false,
					factors: {},
				}}
			/>
		),
		gap: "Feed list requires workspace context; shared Empty/ListSkeleton, FeedCard and WorkReadNotice branches are shown.",
	},
	{
		id: "deck",
		name: "Deck card",
		empty: (
			<DeckCompletion
				total={0}
				filtered={false}
				saving={false}
				onClearFilters={() => {}}
			/>
		),
		partial: (
			<DeckProgress
				total={3}
				completed={1}
				position={2}
				filtered={false}
				saving={false}
			/>
		),
		gap: "Deck card data and actions require workspace context; completion, skeleton, progress and WorkReadNotice are rendered directly.",
	},
	{
		id: "connections",
		name: "Connections list",
		empty: (
			<Empty
				appearance="quiet"
				title="No connections in this view"
				description="Connect an account to get started."
			/>
		),
		partial: (
			<StatusLine
				status={{
					kind: "attention",
					reason: "Couldn't check this account",
					label: "Needs attention: Couldn't check this account",
					action: "reconnect",
				}}
			/>
		),
		gap: "Connection list branches are embedded in the admin page; shared Empty/ListSkeleton/Alert and the per-row needs-attention status are shown.",
	},
	{
		id: "team",
		name: "Team tedi list",
		empty: <TeamEmpty />,
		partial: (
			<ul>
				<TediRow
					tedi={{
						id: "11111111-1111-4111-8111-111111111111",
						organizationId: "22222222-2222-4222-8222-222222222222",
						ownerUserId: null,
						scope: "organization",
						name: "mira",
						slug: "mira",
						displayName: "Mira",
						externalRef: null,
						tags: [],
						personality: "Review assistant",
						avatar: null,
						timezone: "UTC",
						language: "en",
						installedSkills: [],
						installedPlugins: null,
						status: "active",
						billingState: "active",
						workerName: null,
						r2BucketName: null,
						runtimeState: "active",
						runtimeStatus: "unknown",
						lastActivityAt: FRAME_NOW,
						lastSeenAt: FRAME_NOW,
						lastSyncAt: null,
						createdAt: FRAME_NOW,
						updatedAt: FRAME_NOW,
					}}
					expanded
					summaryFailed
					LinkComponent={TediLink}
				/>
			</ul>
		),
		gap: "Roster queries require workspace context; a fixed TediRow with unavailable operations detail, TeamEmpty and shared loading/error components are shown.",
	},
	{
		id: "skills",
		name: "Skills list",
		empty: <SkillsEmpty />,
		gap: "Catalog rows require router and workspace context; exported SkillsEmpty and shared loading/error components are shown.",
	},
	{
		id: "memory",
		name: "Memory list",
		empty: <KnowledgeMapEmpty />,
		gap: "Memory lists require tedi/query context; the exported knowledge empty branch and shared loading/error components are shown.",
	},
	{
		id: "chat",
		name: "Chat list",
		empty: <ConversationsEmpty />,
		partial: (
			<ul>
				<ConversationRow
					conversation={{
						id: "sample-chat",
						organizationId: "22222222-2222-4222-8222-222222222222",
						title: "Morning review",
						status: "active",
						channel: "home",
						lastMessageAt: FRAME_NOW,
						messageCount: 2,
						createdAt: FRAME_NOW,
						updatedAt: FRAME_NOW,
						pinnedAt: null,
						origin: "human",
					}}
					optimistic
					now={new Date(FRAME_NOW)}
				/>
			</ul>
		),
		gap: "Chat list queries require router context; fixed optimistic ConversationRow, ConversationsEmpty and shared loading/error components are shown.",
	},
];
const states = ["empty", "loading", "error", "partial"] as const;

function StateBranch({
	surface,
	state,
}: {
	surface: (typeof surfaces)[number];
	state: (typeof states)[number];
}) {
	const [attempts, setAttempts] = useState(0);
	const retry = () => setAttempts((count) => count + 1);
	if (state === "empty") return surface.empty;
	if (state === "loading")
		return (
			<div className="grid gap-3" role="status" aria-busy="true">
				<Text>Loading {surface.name.toLowerCase()}…</Text>
				{surface.id === "deck" ? (
					<DeckCardSkeleton />
				) : (
					<ListSkeleton rows={3} />
				)}
			</div>
		);
	if (state === "error")
		return (
			<div className="grid gap-3">
				{surface.id === "feed" || surface.id === "deck" ? (
					<WorkReadNotice failed partial={false} retry={retry} />
				) : (
					<Alert variant="destructive">
						<AlertTitle>Could not load {surface.name.toLowerCase()}</AlertTitle>
						<AlertDescription>
							The sample service is unavailable. Your saved data is safe.
						</AlertDescription>
						<Button variant="outline" onClick={retry}>
							Try again
						</Button>
					</Alert>
				)}
				{attempts > 0 && <Text role="label">Retry requested ({attempts})</Text>}
			</div>
		);
	return (
		<div className="grid gap-3">
			{surface.partial}
			{!surface.partial && <Text>Saved sample: Morning review</Text>}
			<Text role="label">
				Last updated <time dateTime={FRAME_NOW}>15 Jan 2026, 09:00 UTC</time>
			</Text>
			<WorkReadNotice failed partial retry={retry} />
			{attempts > 0 && <Text>Retry requested ({attempts})</Text>}
		</div>
	);
}

const client = new QueryClient({
	defaultOptions: { queries: { enabled: false, retry: false } },
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<main className="grid gap-6 p-4 text-kumo-default">
			<header>
				<Text as="h1" role="title">
					OS UI state gallery
				</Text>
				<Text>
					Fixed sample data · {FRAME_NOW} · {dark ? "Dark" : "Light"}
				</Text>
			</header>
			{surfaces.map((surface) => (
				<section
					key={surface.id}
					aria-labelledby={`${surface.id}-heading`}
					className="grid min-w-0 gap-3"
				>
					<Text as="h2" role="section" id={`${surface.id}-heading`}>
						{surface.name}
					</Text>
					<div className="grid min-w-0 gap-3 lg:grid-cols-4">
						{states.map((state) => (
							<Surface
								key={state}
								tier="panel"
								className="relative isolate grid min-w-0 content-start gap-3 p-3"
								render={
									<article
										id={`${surface.id}-${state}`}
										data-state-frame
										aria-labelledby={`${surface.id}-${state}-heading`}
									/>
								}
							>
								<Text
									as="h3"
									role="control"
									id={`${surface.id}-${state}-heading`}
								>
									{state}
								</Text>
								<div data-state-content className="grid min-w-0 gap-3">
									<StateBranch surface={surface} state={state} />
								</div>
							</Surface>
						))}
					</div>
					<Text role="caption">Coverage gap: {surface.gap}</Text>
				</section>
			))}
		</main>
	</QueryClientProvider>,
);
