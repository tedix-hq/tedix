import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SupportAttention } from "@/components/support-attention";
import type { AttentionResult } from "@tedix/api-contract/schemas/work-attention";
import { useEffect, useState } from "react";
import { Alert, AlertTitle, AlertDescription } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Link } from "@/components/kumo/link";
import {
	Page,
	PageHeader,
	PageHeading,
	PageTitle,
	PageDescription,
} from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { workAttentionQueryOptions, osQueryKeys } from "@/lib/os-query-options";
import {
	getSharedCapnSessionHub,
	type CapnSessionLeaseHandle,
} from "@/lib/capn-session-hub";
import { connectCapnSocket } from "@/lib/capn-chat-machine";
import { relativeTime, absoluteTime } from "@/lib/time";
import { useDocumentTitle } from "@/lib/use-document-title";

export const ATTENTION_COLUMNS = [
	["moving", "Moving now"],
	["waiting", "Waiting on you"],
	["blocked", "Blocked"],
	["done", "Done today"],
	["backlog", "Backlog"],
] as const;

function When({ label, at }: { label: string; at: string | null }) {
	return (
		<Text as="span" role="label" tone="secondary">
			{label}:{" "}
			{at ? (
				<time dateTime={at} title={absoluteTime(at)}>
					{relativeTime(at, new Date())}
				</time>
			) : (
				"Not reported"
			)}
		</Text>
	);
}

export function AttentionBoard({
	data,
	file,
	filing = false,
}: {
	data: AttentionResult;
	file: (id: string, projectId: string) => void;
	filing?: boolean;
}) {
	const names = new Map(data.projects.map((p) => [p.id, p.name]));
	const missing = data.projects.filter(
		(p) => p.status === "active" && p.active === 0 && p.recent === 0,
	);
	return (
		<>
			{data.truncated && (
				<Alert>
					<AlertTitle>Showing a bounded overview</AlertTitle>
					<AlertDescription>
						Some older records are outside this view. Open Projects or Activity
						for the complete ledgers.
					</AlertDescription>
				</Alert>
			)}
			<div className="grid min-w-0 gap-4 md:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Attention by project</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-wrap gap-2">
						{data.projects
							.filter((p) => p.active > 0)
							.map((p) => (
								<Badge
									key={p.id}
									variant="info"
									className="max-w-full whitespace-normal [&_a]:min-w-0 [&_a]:break-words"
								>
									<Link href={`/work/projects/${p.id}`}>
										{p.name} · {p.active}
									</Link>
								</Badge>
							))}
						{!data.projects.some((p) => p.active > 0) && (
							<Text tone="secondary">No active registered lanes</Text>
						)}
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Nobody is on</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-wrap gap-2">
						{missing.slice(0, 6).map((p) => (
							<Badge
								key={p.id}
								variant="outline"
								className="max-w-full whitespace-normal [&_a]:min-w-0 [&_a]:break-words"
							>
								<Link href={`/work/projects/${p.id}`}>{p.name}</Link>
							</Badge>
						))}
						{data.unattendedObjectives?.slice(0, 4).map((objective) => (
							<Badge
								key={objective.id}
								variant="outline"
								className="max-w-full whitespace-normal [&_a]:min-w-0 [&_a]:break-words"
							>
								<Link href="/work/portfolio">{objective.title}</Link>
							</Badge>
						))}
						<Text role="label" tone="secondary" className="w-full">
							Active projects and objectives with no registered lane in 24
							hours. Showing up to six projects and four objectives.
						</Text>
						<Link href="/work/portfolio">
							Projects without attention: {missing.length} · Objectives:{" "}
							{data.unattendedObjectives?.length ?? 0}
						</Link>
					</CardContent>
				</Card>
			</div>
			<div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-5">
				{ATTENTION_COLUMNS.map(([key, title]) => {
					const cards = data.cards.filter((c) => c.column === key);
					return (
						<section
							key={key}
							aria-label={title}
							className="max-h-[70vh] min-w-0 space-y-3 overflow-y-auto"
						>
							<Text
								as="h2"
								role="section"
								className="flex items-center justify-between"
							>
								{title}
								<Badge variant="secondary">{cards.length}</Badge>
							</Text>
							{cards.map((card) => (
								<Card key={`${card.source}:${card.id}`} size="sm">
									<CardHeader>
										<Text role="label" tone="secondary">
											{card.who} · {card.source.replaceAll("_", " ")}
										</Text>
										<CardTitle className="break-words">
											<Link href={card.href}>{card.title}</Link>
										</CardTitle>
									</CardHeader>
									<CardContent className="flex flex-col gap-2 break-words">
										<Text role="label" tone="secondary">
											{card.projectId
												? names.get(card.projectId) || "Project"
												: "No project filed"}
										</Text>
										<Text>{card.note}</Text>
										<When label="Started" at={card.startedAt || null} />
										<When label="Last heartbeat" at={card.heartbeatAt} />
										<Link href={card.href}>View proof and activity</Link>
									</CardContent>
								</Card>
							))}
							{!cards.length && <Text tone="secondary">Nothing here</Text>}
						</section>
					);
				})}
			</div>
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
		</>
	);
}

export function WorkAttentionPage() {
	useDocumentTitle("Attention · Work");
	const cache = useQueryClient();
	const [lease, setLease] = useState<CapnSessionLeaseHandle | null>(null);
	useEffect(() => {
		const current = getSharedCapnSessionHub({
			connect: connectCapnSocket,
		}).lease();
		setLease(current);
		return () => current.release();
	}, []);
	const query = useQuery({
		...workAttentionQueryOptions(),
		queryFn: async () => {
			if (!lease) throw new Error("Attention connection is starting");
			const { root } = await lease.session();
			return root.readAttention(new Date().getTimezoneOffset());
		},
		enabled: !!lease,
		refetchInterval: 2000,
		retry: false,
	});
	const filing = useMutation({
		mutationFn: ({ id, projectId }: { id: string; projectId: string }) =>
			osApi.workAgentSessions.fileRequest({ id, projectId }),
		onSuccess: async () => {
			await Promise.all([
				cache.invalidateQueries(workAttentionQueryOptions()),
				cache.invalidateQueries({
					queryKey: osQueryKeys.agentSessionRequests(),
				}),
			]);
		},
	});
	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<PageTitle>Attention</PageTitle>
					<PageDescription>
						Where agent attention is going, what needs you, and what is missing.
					</PageDescription>
				</PageHeading>
				<Link href="#attention-unfiled">
					Unfiled · {query.data?.unfiled.length ?? 0}
				</Link>
				<Badge variant={query.isError ? "warning" : "info"}>
					{query.isError
						? "Live updates paused"
						: !query.data
							? "Connecting…"
							: "Live · every 2 seconds"}
				</Badge>
			</PageHeader>
			{query.isError && (
				<Alert variant="destructive">
					<AlertTitle>Live updates paused</AlertTitle>
					<AlertDescription>
						Last received state stays visible. Reconnecting to Tedix…
					</AlertDescription>
				</Alert>
			)}
			{filing.isError && (
				<Alert variant="destructive">
					<AlertTitle>Request could not be filed</AlertTitle>
					<AlertDescription>{filing.error.message}</AlertDescription>
				</Alert>
			)}
			{query.data ? (
				<AttentionBoard
					data={query.data}
					filing={filing.isPending}
					file={(id, projectId) => filing.mutate({ id, projectId })}
				/>
			) : (
				<Text>Loading attention…</Text>
			)}
			<SupportAttention />
		</Page>
	);
}
