import { RequestFilingReview } from "@/components/request-filing-review";
import {
	ATTENTION_COPY,
	attentionCopy,
	attentionSourceLabel,
} from "@tedix/api-contract/utils/attention-copy";
import { useEffect, useState } from "react";
import {
	CloudIcon,
	DesktopIcon,
	FactoryIcon,
	TimerIcon,
	QuestionIcon,
	PushPinIcon,
} from "@phosphor-icons/react";
import type { AttentionResult } from "@tedix/api-contract/schemas/work-attention";
import {
	DEFAULT_ATTENTION_LAYOUT,
	type AttentionLayout,
} from "@tedix/api-contract/schemas/attention-layout";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Empty } from "@/components/kumo/empty";
import { cn } from "@/lib/utils";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Input } from "@/components/kumo/input";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { Alert, AlertTitle, AlertDescription } from "@/components/kumo/alert";
import {
	Select,
	SelectTrigger,
	SelectValue,
	SelectContent,
	SelectItem,
} from "@/components/kumo/select";
import {
	ATTENTION_SOURCES,
	activityDuration,
	attentionSource,
	attentionUpdatesSince,
	attentionStatus,
	attentionTimestamp,
	duration,
	heartbeatAge,
	rankAttention,
	type AttentionCard,
} from "@/lib/attention";
import "./attention-live-view.css";

export const ATTENTION_COLUMNS = [
	["waiting", ATTENTION_COPY.waiting],
	["blocked", ATTENTION_COPY.blockedOrInactive],
	["moving", ATTENTION_COPY.running],
	["backlog", ATTENTION_COPY.backlog],
	["done", ATTENTION_COPY.doneToday],
] as const;
const WIDGET_LABELS = {
	now: ATTENTION_COPY.now,
	contributions: ATTENTION_COPY.contributions,
	cards: ATTENTION_COPY.work,
	gaps: ATTENTION_COPY.stalled,
	unfiled: ATTENTION_COPY.unfiled,
};
function SourceIcon({ source }: { source: keyof typeof ATTENTION_SOURCES }) {
	const Icon = source.startsWith("local_")
		? DesktopIcon
		: source === "cloud_tedi"
			? CloudIcon
			: source === "factory"
				? FactoryIcon
				: source === "coordinator"
					? TimerIcon
					: QuestionIcon;
	return (
		<Icon
			size={16}
			aria-hidden
			style={{ color: ATTENTION_SOURCES[source].color }}
		/>
	);
}
function LiveCard({
	card,
	now,
	project,
	compact,
}: {
	card: AttentionCard;
	now: number;
	project?: string;
	compact: boolean;
}) {
	const source = attentionSource(card);
	const age = heartbeatAge(card, now);
	const live = card.column !== "done" && card.column !== "backlog";
	const tracked = live && card.source !== "interaction";
	const stale = tracked && (age === null || age >= 300_000);
	const end =
		attentionTimestamp(card.finishedAt || "") ||
		(live || card.column === "backlog"
			? now
			: attentionTimestamp(card.heartbeatAt || ""));
	return (
		<Card
			className={cn(
				"attention-card min-w-0",
				card.column === "waiting" && "border-kumo-warning",
			)}
			data-stale={stale || undefined}
			data-column={card.column}
			size={compact ? "sm" : "default"}
		>
			<CardHeader>
				<div className="flex items-center gap-2">
					<SourceIcon source={source} />
					<Text role="label" tone="secondary" className="min-w-0 break-words">
						{card.column === "backlog"
							? ATTENTION_COPY.ready
							: attentionSourceLabel(
									source,
									source === "factory" ? card.factoryName : card.tediName,
								)}
					</Text>
					{tracked && (
						<span
							aria-label={
								age === null
									? ATTENTION_COPY.heartbeatUnknown
									: stale
										? ATTENTION_COPY.heartbeatStale
										: ATTENTION_COPY.heartbeatReceived
							}
							className={`ml-auto h-2 w-2 shrink-0 rounded-full ${!stale ? "attention-heartbeat" : ""}`}
							style={{
								background: ATTENTION_SOURCES[source].color,
								opacity:
									age === null ? 0.15 : Math.max(0.15, 1 - age / 300_000),
							}}
						/>
					)}
				</div>
				<CardTitle className={cn("break-words", stale && "text-kumo-subtle")}>
					<Link href={card.href} variant={stale ? "current" : "inline"}>
						{card.title}
					</Link>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-2 break-words">
				{project && (
					<Text role="label" tone="secondary">
						{project}
					</Text>
				)}
				<Text role="label">
					<time dateTime={card.startedAt}>
						{duration(end - attentionTimestamp(card.startedAt))}
					</time>{" "}
					· {attentionStatus(card, now)}
				</Text>
				<Text key={card.note} className="attention-note" tone="secondary">
					{card.note}
				</Text>
			</CardContent>
		</Card>
	);
}
function NowStrip({ cards, now }: { cards: AttentionCard[]; now: number }) {
	const start = now - 7_200_000;
	const lanes = cards
		.filter(
			(c) =>
				c.source !== "backlog" &&
				attentionTimestamp(c.startedAt) <= now &&
				attentionTimestamp(c.finishedAt || c.heartbeatAt || "") >= start,
		)
		.slice(0, 20);
	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<CardTitle>{ATTENTION_COPY.now}</CardTitle>
					<Text role="label" tone="secondary">
						{attentionCopy("recentLanes", { count: lanes.length })}
					</Text>
				</div>
			</CardHeader>
			<CardContent>
				<div
					className="attention-timeline flex h-12 items-end gap-1 sm:hidden"
					aria-label={ATTENTION_COPY.sparkline}
				>
					{Array.from({ length: 24 }, (_, i) => {
						const at = start + i * 300_000;
						const count = lanes.filter(
							(c) =>
								attentionTimestamp(c.startedAt) <= at &&
								attentionTimestamp(c.finishedAt || c.heartbeatAt || "") >= at,
						).length;
						return (
							<span
								key={i}
								className="flex-1 rounded-t bg-kumo-brand"
								style={{
									height: `${Math.max(4, (count / Math.max(1, lanes.length)) * 100)}%`,
								}}
							/>
						);
					})}
				</div>
				<div className="hidden max-h-64 space-y-2 overflow-y-auto sm:block">
					{lanes.map((c) => {
						const source = attentionSource(c);
						const sourceLabel = attentionSourceLabel(
							source,
							source === "factory" ? c.factoryName : c.tediName,
						);
						const left = Math.max(
							0,
							((attentionTimestamp(c.startedAt) - start) / 7_200_000) * 100,
						);
						const end = Math.min(
							now,
							attentionTimestamp(c.finishedAt || c.heartbeatAt || ""),
						);
						const width = Math.max(
							0.5,
							((end - Math.max(start, attentionTimestamp(c.startedAt))) /
								7_200_000) *
								100,
						);
						return (
							<div
								key={`${c.source}:${c.id}`}
								className="grid grid-cols-[minmax(0,12rem)_1fr] items-center gap-3"
							>
								<Link
									href={c.href}
									className="truncate"
									title={`${sourceLabel} · ${c.title}`}
								>
									<Text as="span" role="label" className="text-inherit">
										{sourceLabel} · {c.title}
									</Text>
								</Link>
								<div className="attention-timeline relative h-5 rounded bg-kumo-control">
									<div
										className="absolute inset-y-1 rounded transition-[left,width] duration-tedix-structural ease-tedix-standard motion-reduce:transition-none"
										style={{
											left: `${left}%`,
											width: `${width}%`,
											background: ATTENTION_SOURCES[attentionSource(c)].color,
										}}
										title={`${c.title} · ${attentionStatus(c, now)}`}
									/>
								</div>
							</div>
						);
					})}
				</div>
				{!lanes.length && (
					<Text tone="secondary">{ATTENTION_COPY.noRecentActivity}</Text>
				)}
				<Text
					as="p"
					role="label"
					tone="secondary"
					className="mt-2 flex justify-between"
				>
					<span>{ATTENTION_COPY.twoHoursAgo}</span>
					<span>{ATTENTION_COPY.oneHourAgo}</span>
					<span>{ATTENTION_COPY.now}</span>
				</Text>
				<Text role="label" tone="secondary">
					{ATTENTION_COPY.timelineHelp}
				</Text>
			</CardContent>
		</Card>
	);
}
export function AttentionBoard({
	data: allData,
	file,
	filing = false,
	layout = DEFAULT_ATTENTION_LAYOUT,
	saveLayout,
	saving = false,
	previousVisitAt = null,
}: {
	data: AttentionResult;
	file: (id: string, projectId: string) => void;
	filing?: boolean;
	layout?: AttentionLayout;
	saveLayout?: (layout: AttentionLayout) => void;
	saving?: boolean;
	previousVisitAt?: string | null;
}) {
	const [now, setNow] = useState(Date.now);
	const [editing, setEditing] = useState(false);
	const [focus, setFocus] = useState(layout.focusToday);
	const [contributor, setContributor] = useState<string | null>(null);
	const projects = allData.projects.filter(
		(p) => !layout.focusProjectId || p.id === layout.focusProjectId,
	);
	const scopes = new Set(
		projects.flatMap((p) => [p.id, ...(p.objectiveId ? [p.objectiveId] : [])]),
	);
	const data: AttentionResult = layout.focusProjectId
		? {
				...allData,
				cards: allData.cards.filter(
					(c) => c.projectId === layout.focusProjectId,
				),
				projects,
				unattendedObjectives: allData.unattendedObjectives?.filter((o) =>
					scopes.has(o.id),
				),
				stalls: allData.stalls?.filter((stall) => scopes.has(stall.scopeId)),
				cadencePromises: allData.cadencePromises?.filter((promise) =>
					scopes.has(promise.scopeId),
				),
			}
		: allData;
	useEffect(() => setContributor(null), [layout.focusProjectId]);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	useEffect(() => setFocus(layout.focusToday), [layout.focusToday]);
	const change = (patch: Partial<AttentionLayout>) =>
		saveLayout?.({ ...layout, ...patch });
	const cards = rankAttention(data.cards, layout).filter(
		(c) =>
			!contributor ||
			c.tediName === contributor ||
			c.factoryName === contributor,
	);
	const names = new Map(data.projects.map((p) => [p.id, p.name]));
	const total = data.cards.reduce(
		(sum, c) => sum + activityDuration(c, now),
		0,
	);
	const away = attentionUpdatesSince(data.cards, previousVisitAt);
	const widgets = {
		now: <NowStrip cards={cards} now={now} />,
		contributions: (
			<Card>
				<CardHeader>
					<CardTitle>{ATTENTION_COPY.contributions}</CardTitle>
					<Text role="label" tone="secondary">
						{ATTENTION_COPY.contributionHelp}
					</Text>
				</CardHeader>
				<CardContent className="space-y-3">
					<div
						className="flex h-2 overflow-hidden rounded-full bg-kumo-control"
						aria-label={ATTENTION_COPY.activityBySource}
					>
						{Object.entries(ATTENTION_SOURCES).map(([key, source]) => {
							const time = data.cards
								.filter((c) => attentionSource(c) === key)
								.reduce((n, c) => n + activityDuration(c, now), 0);
							return (
								<span
									key={key}
									style={{
										background: source.color,
										width: `${total ? (time / total) * 100 : 0}%`,
									}}
								/>
							);
						})}
					</div>
					<div className="flex flex-wrap gap-2">
						{Object.entries(ATTENTION_SOURCES)
							.filter(
								([key]) =>
									key !== "unknown" ||
									data.cards.some(
										(c) => attentionSource(c) === key && c.source !== "backlog",
									),
							)
							.map(([key, source]) => {
								const id = key as keyof typeof ATTENTION_SOURCES;
								const time = data.cards
									.filter((c) => attentionSource(c) === id)
									.reduce((n, c) => n + activityDuration(c, now), 0);
								return (
									<Button
										key={key}
										variant={
											layout.sourceFilters.includes(id) ? "secondary" : "ghost"
										}
										size="sm"
										disabled={!saveLayout || saving}
										aria-pressed={layout.sourceFilters.includes(id)}
										onClick={() =>
											change({
												sourceFilters: layout.sourceFilters.includes(id)
													? layout.sourceFilters.filter((s) => s !== id)
													: [...layout.sourceFilters, id],
											})
										}
									>
										<SourceIcon source={id} />
										{source.label} ·{" "}
										{total ? Math.round((time / total) * 100) : 0}%
									</Button>
								);
							})}
					</div>
					<SegmentedControl
						ariaLabel="Filter by contributor"
						compact
						value={contributor ?? ""}
						onValueChange={(value) => setContributor(value || null)}
						options={[
							{ value: "", label: "All" },
							...[
								...new Set(
									data.cards
										.flatMap((c) => [c.tediName, c.factoryName])
										.filter((n): n is string => !!n),
								),
							].map((name) => ({
								value: name,
								label: (
									<>
										{name} ·{" "}
										{
											data.cards.filter(
												(c) => c.tediName === name || c.factoryName === name,
											).length
										}
									</>
								),
							})),
						]}
					/>
				</CardContent>
			</Card>
		),
		cards: (
			<div className="space-y-6">
				{ATTENTION_COLUMNS.filter(
					([key]) => !layout.hiddenColumns.includes(key),
				).map(([key, title]) => {
					const group = cards.filter((c) => c.column === key);
					return (
						<section key={key} aria-label={title} className="space-y-3">
							<div className="flex items-center gap-2">
								<Text as="h2" role="section">
									{title}
								</Text>
								<Badge variant={key === "waiting" ? "warning" : "secondary"}>
									{group.length}
								</Badge>
							</div>
							<div
								className={`grid min-w-0 gap-3 ${key === "waiting" ? "lg:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3"}`}
							>
								{group.map((card) => (
									<LiveCard
										key={`${card.source}:${card.id}`}
										card={card}
										now={now}
										project={names.get(card.projectId ?? "")}
										compact={layout.density === "compact"}
									/>
								))}
							</div>
							{!group.length && (
								<Empty appearance="inline">
									{key === "waiting"
										? ATTENTION_COPY.noReplyNeeded
										: ATTENTION_COPY.nothingHere}
								</Empty>
							)}
						</section>
					);
				})}
				{!cards.length && (
					<Empty appearance="inline">{ATTENTION_COPY.noFocusMatches}</Empty>
				)}
			</div>
		),
		gaps: (
			<Card>
				<CardHeader>
					<CardTitle>{ATTENTION_COPY.stalled}</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					{(data.stalls ?? []).slice(0, 10).map((stall) => (
						<div key={stall.scopeId} className="min-w-0 space-y-1 break-words">
							<Link href={stall.href}>
								{stall.name}: {stall.reason}
							</Link>
							<Text role="label" tone="secondary">
								{attentionCopy("resumeRequested", {
									cause: stall.cause,
									duration: duration(
										now - attentionTimestamp(stall.requestedAt),
									),
								})}
							</Text>
						</div>
					))}
					{data.stalls === undefined ? (
						<Text tone="secondary">{ATTENTION_COPY.recoveryPending}</Text>
					) : !data.stalls.length ? (
						<Text tone="secondary">{ATTENTION_COPY.noStalls}</Text>
					) : null}
					{!!data.cadencePromises?.length && (
						<Text role="label" tone="secondary">
							{attentionCopy("schedulePromises", {
								kept: data.cadencePromises.filter((p) => p.status === "kept")
									.length,
								missed: data.cadencePromises.filter(
									(p) => p.status === "missed",
								).length,
							})}
						</Text>
					)}
				</CardContent>
			</Card>
		),
		unfiled: <RequestFilingReview data={allData} file={file} filing={filing} />,
	};
	return (
		<div className="min-w-0 space-y-5" data-attention-live>
			{data.stalls?.some((s) => s.needsYou) && (
				<Alert>
					<AlertTitle>{ATTENTION_COPY.waitingDecision}</AlertTitle>
					<AlertDescription>
						{data.stalls
							.filter((s) => s.needsYou)
							.map((s) => (
								<Link key={s.scopeId} href={s.href} className="block">
									{s.name}: {s.reason}
								</Link>
							))}
					</AlertDescription>
				</Alert>
			)}
			{away.length > 0 && (
				<Alert>
					<AlertTitle>{ATTENTION_COPY.away}</AlertTitle>
					<AlertDescription>
						{attentionCopy("awaySummary", {
							done: away.filter((c) => c.column === "done").length,
							waiting: away.filter((c) => c.column === "waiting").length,
							updated: away.length,
						})}
						<div className="mt-2 flex flex-wrap gap-2">
							{away.slice(0, 3).map((c) => (
								<Link key={`${c.source}:${c.id}`} href={c.href}>
									{c.title}
								</Link>
							))}
						</div>
					</AlertDescription>
				</Alert>
			)}
			{saveLayout && (
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<form
						className="flex min-w-0 flex-1 basis-full gap-2 sm:basis-auto"
						onSubmit={(e) => {
							e.preventDefault();
							change({ focusToday: focus });
						}}
					>
						<Input
							aria-label={ATTENTION_COPY.focusToday}
							placeholder="Focus today…"
							value={focus}
							maxLength={500}
							onChange={(e) => setFocus(e.target.value)}
						/>
						<Button
							type="submit"
							disabled={saving || focus === layout.focusToday}
						>
							{ATTENTION_COPY.setFocus}
						</Button>
					</form>
					<Button
						variant="outline"
						aria-expanded={editing}
						onClick={() => setEditing(!editing)}
					>
						{ATTENTION_COPY.arrange}
					</Button>
				</div>
			)}
			{editing && (
				<Card>
					<CardContent className="space-y-4 pt-4">
						<Text role="label">{ATTENTION_COPY.savedView}</Text>
						<Select
							value={layout.focusProjectId ?? "all"}
							onValueChange={(v) =>
								change({ focusProjectId: v === "all" ? null : v })
							}
							disabled={saving}
						>
							<SelectTrigger aria-label={ATTENTION_COPY.focusProject}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">
									{ATTENTION_COPY.allProjects}
								</SelectItem>
								{allData.projects.map((p) => (
									<SelectItem key={p.id} value={p.id}>
										{attentionCopy("onlyProject", { name: p.name })}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<div className="flex flex-wrap gap-2">
							{allData.projects.map((p) => (
								<Button
									key={p.id}
									size="sm"
									variant={
										layout.pinnedProjects.includes(p.id)
											? "secondary"
											: "outline"
									}
									className="h-auto max-w-full whitespace-normal [overflow-wrap:anywhere]"
									aria-pressed={layout.pinnedProjects.includes(p.id)}
									disabled={saving}
									onClick={() =>
										change({
											pinnedProjects: layout.pinnedProjects.includes(p.id)
												? layout.pinnedProjects.filter((id) => id !== p.id)
												: [...layout.pinnedProjects, p.id],
										})
									}
								>
									<PushPinIcon />
									{p.name}
								</Button>
							))}
						</div>
						<div className="flex flex-wrap gap-2">
							{ATTENTION_COLUMNS.map(([key, title]) => (
								<Button
									key={key}
									size="sm"
									variant="outline"
									aria-pressed={!layout.hiddenColumns.includes(key)}
									disabled={saving}
									onClick={() =>
										change({
											hiddenColumns: layout.hiddenColumns.includes(key)
												? layout.hiddenColumns.filter((k) => k !== key)
												: [...layout.hiddenColumns, key],
										})
									}
								>
									{layout.hiddenColumns.includes(key)
										? ATTENTION_COPY.show
										: ATTENTION_COPY.hide}{" "}
									{title}
								</Button>
							))}
							<Button
								size="sm"
								variant="outline"
								disabled={saving}
								onClick={() =>
									change({
										density:
											layout.density === "compact" ? "comfortable" : "compact",
									})
								}
							>
								{layout.density === "compact"
									? ATTENTION_COPY.comfortable
									: ATTENTION_COPY.compact}
							</Button>
						</div>
						<div className="flex flex-wrap gap-2">
							{layout.widgets.map((key, i) => (
								<Button
									key={key}
									size="sm"
									variant="outline"
									disabled={saving || i === 0}
									onClick={() => {
										const widgets = [...layout.widgets];
										[widgets[i - 1], widgets[i]] = [
											widgets[i]!,
											widgets[i - 1]!,
										];
										change({ widgets });
									}}
								>
									↑ {WIDGET_LABELS[key]}
								</Button>
							))}
						</div>
						<Button
							variant="ghost"
							disabled={saving}
							onClick={() => {
								setContributor(null);
								saveLayout?.(DEFAULT_ATTENTION_LAYOUT);
							}}
						>
							{ATTENTION_COPY.reset}
						</Button>
					</CardContent>
				</Card>
			)}
			{data.truncated && (
				<Alert>
					<AlertTitle>{ATTENTION_COPY.bounded}</AlertTitle>
					<AlertDescription>{ATTENTION_COPY.boundedHelp}</AlertDescription>
				</Alert>
			)}
			<div className="attention-widgets flex flex-col gap-5">
				{layout.widgets.map((widget) => (
					<div key={widget} data-attention-widget={widget}>
						{widgets[widget]}
					</div>
				))}
			</div>
		</div>
	);
}
