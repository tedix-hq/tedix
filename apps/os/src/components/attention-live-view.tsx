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
	attentionStatus,
	attentionTimestamp,
	duration,
	heartbeatAge,
	rankAttention,
	type AttentionCard,
} from "@/lib/attention";
import "./attention-live-view.css";

export const ATTENTION_COLUMNS = [
	["waiting", "Waiting on you"],
	["blocked", "Blocked"],
	["moving", "Moving now"],
	["backlog", "Backlog"],
	["done", "Done today"],
] as const;
const WIDGET_LABELS = {
	now: "Now",
	contributions: "Today's contributions",
	cards: "Work",
	gaps: "Needs attention",
	unfiled: "Unfiled",
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
	const stale = live && (age === null || age >= 300_000);
	const end =
		attentionTimestamp(card.finishedAt || "") ||
		(live || card.column === "backlog"
			? now
			: attentionTimestamp(card.heartbeatAt || ""));
	return (
		<Card
			className={`attention-card min-w-0 ${stale ? "opacity-65" : ""} ${card.column === "waiting" ? "border-kumo-warning" : ""}`}
			size={compact ? "sm" : "default"}
		>
			<CardHeader>
				<div className="flex items-center gap-2">
					<SourceIcon source={source} />
					<Text role="label" tone="secondary">
						{card.column === "backlog" ? "Ready for someone" : card.who} ·{" "}
						{ATTENTION_SOURCES[source].label}
					</Text>
					{live && (
						<span
							aria-label={stale ? "Heartbeat stale" : "Heartbeat received"}
							className={`ml-auto h-2 w-2 shrink-0 rounded-full ${!stale ? "attention-heartbeat" : ""}`}
							style={{
								background: ATTENTION_SOURCES[source].color,
								opacity:
									age === null ? 0.15 : Math.max(0.15, 1 - age / 300_000),
							}}
						/>
					)}
				</div>
				<CardTitle
					className={`break-words ${card.column === "waiting" ? "text-lg" : ""}`}
				>
					<Link href={card.href}>{card.title}</Link>
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
				{stale && source.startsWith("local_") && (
					<Text role="label" tone="secondary">
						Local session paused or laptop offline · last reported state above
					</Text>
				)}
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
					<CardTitle>Now</CardTitle>
					<Text role="label" tone="secondary">
						Last 2 hours · {lanes.length} lanes
					</Text>
				</div>
			</CardHeader>
			<CardContent>
				<div
					className="attention-timeline flex h-12 items-end gap-1 sm:hidden"
					aria-label="Activity sparkline"
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
									className="truncate text-xs"
									title={`${c.who} · ${c.title}`}
								>
									{c.who} · {c.title}
								</Link>
								<div className="attention-timeline relative h-5 rounded bg-kumo-control">
									<div
										className="absolute inset-y-1 rounded transition-all duration-1000"
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
					<Text tone="secondary">
						No reported activity in the last two hours.
					</Text>
				)}
				<div className="mt-2 flex justify-between text-xs text-kumo-subtle">
					<span>2 hours ago</span>
					<span>1 hour ago</span>
					<span>Now</span>
				</div>
				<Text role="label" tone="secondary">
					Bars follow confirmed heartbeats. Cloud work can continue when your
					laptop closes.
				</Text>
			</CardContent>
		</Card>
	);
}
export function AttentionBoard({
	data,
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
	const since = attentionTimestamp(previousVisitAt || "");
	const away =
		Number.isFinite(since) && now - since > 60_000
			? data.cards.filter(
					(c) =>
						attentionTimestamp(c.finishedAt || c.heartbeatAt || c.startedAt) >
						since,
				)
			: [];
	const gaps = [
		...data.projects
			.filter((p) => p.status === "active" && !p.active && !p.recent)
			.map((p) => ({ ...p, title: p.name, href: `/work/projects/${p.id}` })),
		...(data.unattendedObjectives ?? []).map((o) => ({
			...o,
			href: "/work/portfolio",
		})),
	].sort(
		(a, b) =>
			(attentionTimestamp(a.lastAttentionAt || "") || 0) -
			(attentionTimestamp(b.lastAttentionAt || "") || 0),
	);
	const widgets = {
		now: <NowStrip cards={cards} now={now} />,
		contributions: (
			<Card>
				<CardHeader>
					<CardTitle>Today's contributions</CardTitle>
					<Text role="label" tone="secondary">
						Share of reported time in this overview · overlapping work counts
						separately
					</Text>
				</CardHeader>
				<CardContent className="space-y-3">
					<div
						className="flex h-2 overflow-hidden rounded-full bg-kumo-control"
						aria-label="Activity by source"
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
					<div className="flex flex-wrap gap-2">
						{[
							...new Set(
								data.cards
									.flatMap((c) => [c.tediName, c.factoryName])
									.filter((n): n is string => !!n),
							),
						].map((name) => (
							<Button
								key={name}
								variant={contributor === name ? "secondary" : "outline"}
								size="sm"
								aria-pressed={contributor === name}
								onClick={() =>
									setContributor(contributor === name ? null : name)
								}
							>
								{name} ·{" "}
								{
									data.cards.filter(
										(c) => c.tediName === name || c.factoryName === name,
									).length
								}
							</Button>
						))}
					</div>
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
								<Text tone="secondary">
									{key === "waiting"
										? "Nothing needs your reply."
										: "Nothing here right now."}
								</Text>
							)}
						</section>
					);
				})}
				{!cards.length && <Text>No work matches your current focus.</Text>}
			</div>
		),
		gaps: (
			<Card>
				<CardHeader>
					<CardTitle>Needs attention</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<Text as="h3" role="section">
						Stalled
					</Text>
					{(data.stalls ?? []).slice(0, 10).map((stall) => (
						<div key={stall.scopeId} className="min-w-0 space-y-1 break-words">
							<Link href={stall.href}>
								{stall.name}: {stall.reason}
							</Link>
							<Text role="label" tone="secondary">
								{stall.cause} · resume requested{" "}
								{duration(now - attentionTimestamp(stall.requestedAt))} ago
							</Text>
						</div>
					))}
					{!data.stalls?.length && (
						<Text tone="secondary">
							No stalls need your attention. Tedix handles recovery first.
						</Text>
					)}
					{!!data.cadencePromises?.length && (
						<Text role="label" tone="secondary">
							Cadence promises:{" "}
							{data.cadencePromises.filter((p) => p.status === "kept").length}{" "}
							kept ·{" "}
							{data.cadencePromises.filter((p) => p.status === "missed").length}{" "}
							missed
						</Text>
					)}

					{gaps.slice(0, 10).map((p) => {
						const days = p.lastAttentionAt
							? Math.max(
									1,
									Math.floor(
										(now - attentionTimestamp(p.lastAttentionAt)) / 86_400_000,
									),
								)
							: null;
						return (
							<div key={p.id} className="space-y-1">
								<Link href={p.href}>
									Nobody has touched {p.title}
									{days === null
										? " · no activity recorded"
										: ` for ${days} ${days === 1 ? "day" : "days"}`}
								</Link>
								<div className="h-1 rounded bg-kumo-control">
									<div
										className="h-1 rounded bg-kumo-warning"
										style={{
											width: `${Math.min(100, ((days ?? 14) / 14) * 100)}%`,
										}}
									/>
								</div>
							</div>
						);
					})}
					{!gaps.length && (
						<Text tone="secondary">
							Every tracked goal has recent attention.
						</Text>
					)}
				</CardContent>
			</Card>
		),
		unfiled: (
			<section
				id="attention-unfiled"
				aria-label="Unfiled"
				className="space-y-3"
			>
				<Text as="h2" role="section">
					Unfiled · {data.unfiled.length}
				</Text>
				{data.unfiled.map((row) => (
					<Card key={row.id} size="sm">
						<CardContent className="flex min-w-0 flex-col gap-3 pt-3 sm:flex-row sm:items-center">
							<Text className="min-w-0 flex-1 break-words">{row.text}</Text>
							<Select
								disabled={filing}
								value={null}
								onValueChange={(value) => {
									if (value) file(row.id, value);
								}}
							>
								<SelectTrigger
									aria-label={`File to project: ${row.text}`}
									className="w-full sm:w-64"
								>
									<SelectValue placeholder="File to project" />
								</SelectTrigger>
								<SelectContent>
									{data.projects
										.filter((p) => p.status === "active")
										.map((p) => (
											<SelectItem key={p.id} value={p.id}>
												{p.name}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
						</CardContent>
					</Card>
				))}
				{!data.unfiled.length && (
					<Text tone="secondary">All captured requests are filed.</Text>
				)}
			</section>
		),
	};
	return (
		<div className="min-w-0 space-y-5" data-attention-live>
			{data.stalls?.some((s) => s.needsYou) && (
				<Alert>
					<AlertTitle>Waiting on your decision</AlertTitle>
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
					<AlertTitle>While you were away</AlertTitle>
					<AlertDescription>
						{away.filter((c) => c.column === "done").length} finished ·{" "}
						{away.filter((c) => c.column === "waiting").length} waiting on you ·{" "}
						{away.length} updated since your last visit.
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
							aria-label="Focus today"
							placeholder="Focus today…"
							value={focus}
							maxLength={500}
							onChange={(e) => setFocus(e.target.value)}
						/>
						<Button
							type="submit"
							disabled={saving || focus === layout.focusToday}
						>
							Set focus
						</Button>
					</form>
					<Button
						variant="outline"
						aria-expanded={editing}
						onClick={() => setEditing(!editing)}
					>
						Arrange view
					</Button>
				</div>
			)}
			{editing && (
				<Card>
					<CardContent className="space-y-4 pt-4">
						<Text role="label">Your view · saved across devices</Text>
						<Select
							value={layout.focusProjectId ?? "all"}
							onValueChange={(v) =>
								change({ focusProjectId: v === "all" ? null : v })
							}
							disabled={saving}
						>
							<SelectTrigger aria-label="Focus project">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All projects</SelectItem>
								{data.projects.map((p) => (
									<SelectItem key={p.id} value={p.id}>
										Only {p.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<div className="flex flex-wrap gap-2">
							{data.projects.map((p) => (
								<Button
									key={p.id}
									size="sm"
									variant={
										layout.pinnedProjects.includes(p.id)
											? "secondary"
											: "outline"
									}
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
									{layout.hiddenColumns.includes(key) ? "Show" : "Hide"} {title}
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
									? "Comfortable spacing"
									: "Compact spacing"}
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
							Reset view
						</Button>
					</CardContent>
				</Card>
			)}
			{data.truncated && (
				<Alert>
					<AlertTitle>Showing a bounded overview</AlertTitle>
					<AlertDescription>
						Some older activity is outside this view. Counts and contributions
						describe the records shown.
					</AlertDescription>
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
