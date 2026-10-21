import {
	WorkListSkeleton,
	WorkReadFailure,
	WorkEmpty,
} from "@/components/work-surface-primitives";
import {
	decisionCaptureSummary,
	urgentReasons,
} from "@/lib/work-interaction-display";
import { useQuery } from "@tanstack/react-query";
import { useContext, useMemo, useState } from "react";
import * as z from "zod";
import {
	WorkActorAvatar,
	WorkActorDirectoryContext,
} from "@/components/work-actor-avatar";
import { resolveWorkActor } from "@/lib/work-actor";
import { Combobox } from "@/components/kumo/combobox";
import { WorkInteractionDeliveryOverlaySchema } from "@tedix/api-contract/schemas/work-interactions";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Empty } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import { Collection } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { sentenceCase } from "@/lib/format";
import { normalizeD1Timestamp } from "@/lib/time";
import {
	membersListQueryOptions,
	tediRosterQueryOptions,
	workExternalPrincipalsQueryOptions,
	workReadinessProjectionQueryOptions,
} from "@/lib/os-query-options";
import { workPrincipalLabel } from "@/lib/work-display";

export function namedWorkPrincipal(
	type: string | undefined,
	id: string | null | undefined,
	names: ReadonlyMap<string, string>,
) {
	return (
		names.get(`${type}:${id}`) ??
		workPrincipalLabel(id ?? null, type ? sentenceCase(type) : "Recipient")
	);
}

export function useWorkPrincipalNames(organizationId?: string) {
	const tedis = useQuery({
		...tediRosterQueryOptions(100),
		enabled: Boolean(organizationId),
		retry: false,
	});
	const members = useQuery({
		...membersListQueryOptions({
			organizationId: organizationId ?? "",
			limit: 100,
			offset: 0,
		}),
		enabled: Boolean(organizationId),
		retry: false,
	});
	const external = useQuery({
		...workExternalPrincipalsQueryOptions(organizationId ?? ""),
		enabled: Boolean(organizationId),
		retry: false,
	});
	return useMemo(() => {
		const names = new Map<string, string>();
		for (const tedi of tedis.data?.data ?? [])
			names.set(`tedi:${tedi.id}`, tedi.displayName || tedi.name);
		for (const member of members.data?.data ?? [])
			names.set(`user:${member.descopeUserId}`, member.name || member.email);
		for (const principal of external.data ?? [])
			names.set(`external_agent:${principal.id}`, principal.displayName);
		return names;
	}, [tedis.data, members.data, external.data]);
}

export function OperationActor({ type, id }: { type: string; id: string }) {
	const directory = useContext(WorkActorDirectoryContext);
	const actor = { type, id };
	const resolved = resolveWorkActor(actor, "Name unavailable", directory);
	return (
		<span className="inline-flex min-w-0 max-w-full items-center gap-2">
			<WorkActorAvatar
				actor={actor}
				name="Name unavailable"
				detail={`${type}: ${id}`}
				className="max-sm:min-h-11 max-sm:min-w-11 coarse:min-h-11 coarse:min-w-11"
			/>
			<span className="min-w-0">
				<Text as="span" role="label" className="block truncate">
					{resolved.label}
				</Text>
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="block truncate"
					title={`${type}: ${id}`}
				>
					{sentenceCase(type)} · {id.slice(0, 8)}
				</Text>
			</span>
		</span>
	);
}

export function OperationPicker({
	label,
	options,
	value,
	onSelect,
}: {
	label: string;
	options: { value: string; label: string }[];
	value: string;
	onSelect: (id: string) => void;
}) {
	return (
		<Combobox
			items={options}
			value={options.find((option) => option.value === value) ?? null}
			isItemEqualToValue={(a, b) => a.value === b.value}
			onValueChange={(option) => {
				if (option) onSelect(option.value);
			}}
		>
			<Combobox.Trigger
				render={
					<Button
						variant="outline"
						className="min-h-11 max-w-full justify-start whitespace-normal text-left"
					/>
				}
				aria-label={label}
			>
				{options.find((option) => option.value === value)?.label ?? label}
			</Combobox.Trigger>
			<Combobox.Content className="max-w-[calc(100vw-2rem)]">
				<Combobox.Input
					aria-label={label.replace(/^Choose /, "Find ")}
					placeholder="Search by name…"
				/>
				<Combobox.Empty>No matches in this snapshot</Combobox.Empty>
				<Combobox.List>
					{(option: { value: string; label: string }) => (
						<Combobox.Item
							key={option.value}
							value={option}
							className="min-h-11 whitespace-normal"
						>
							{option.label}
						</Combobox.Item>
					)}
				</Combobox.List>
			</Combobox.Content>
		</Combobox>
	);
}

export function ReadinessOverview({
	selectedId = "",
	onSelect,
}: {
	selectedId?: string;
	onSelect?: (id: string) => void;
}) {
	const paging = useCursorPaging<{ at: string; id: string }>();
	const query = useQuery(workReadinessProjectionQueryOptions(paging.cursor));
	const rows = query.data?.data ?? [];
	return (
		<Card>
			<CardHeader>
				<CardTitle>Readiness and leases</CardTitle>
				<CardDescription>
					Read-only snapshot of Work and admission gates. Inspecting an item
					never starts work. Readiness depends on the executor.
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-3">
				{query.isPending ? (
					<WorkListSkeleton />
				) : query.isError ? (
					<WorkReadFailure
						title="Readiness overview unavailable"
						error={query.error}
					/>
				) : rows.length === 0 ? (
					<WorkEmpty
						title="No Work in this snapshot"
						description="New Work will appear here when it is available."
					/>
				) : (
					<>
						{onSelect && (
							<OperationPicker
								label="Choose Work"
								value={selectedId}
								options={rows.map(({ workItem }) => ({
									value: workItem.id,
									label: workItem.title,
								}))}
								onSelect={onSelect}
							/>
						)}
						<Collection appearance="inline" aria-label="Work readiness">
							{rows.map(({ workItem, readiness }) => (
								<li key={workItem.id} className="grid min-w-0 gap-2 py-3">
									<div className="flex flex-wrap items-center gap-2">
										{onSelect ? (
											<Button
												variant="ghost"
												className="min-h-11 max-w-full whitespace-normal text-left"
												onClick={() => onSelect(workItem.id)}
											>
												{workItem.title}
											</Button>
										) : (
											<Link
												href={`/work/items/${workItem.id}`}
												className="min-h-11 py-3"
											>
												{workItem.title}
											</Link>
										)}
										<Badge variant={readiness.ready ? "success" : "warning"}>
											{sentenceCase(readiness.state)}
										</Badge>
									</div>
									{readiness.gates
										.filter(
											(gate) =>
												gate.gate === "attempt" || gate.evaluation !== "passed",
										)
										.map((gate) => (
											<Text
												key={gate.gate}
												as="p"
												role="label"
												tone="secondary"
											>
												{sentenceCase(gate.gate)}: {gate.detail}
											</Text>
										))}
								</li>
							))}
						</Collection>
					</>
				)}
				<PageControls
					hasPrevious={paging.hasPrevious}
					hasNext={Boolean(query.data?.hasMore && query.data.nextCursor)}
					onPrevious={paging.reset}
					onBack={paging.previous}
					onNext={() => {
						if (query.data?.nextCursor) paging.next(query.data.nextCursor);
					}}
				/>
			</CardContent>
		</Card>
	);
}

export function MutationError({ error }: { error: unknown }) {
	return error ? (
		<WorkReadFailure title="Write rejected" error={error} />
	) : null;
}

export function ApprovalRequestError({ error }: { error: unknown }) {
	if (
		error instanceof Error &&
		error.message === "Requester cannot approve its own proposal"
	) {
		return (
			<WorkReadFailure
				title="Choose a different approver"
				fallback="You cannot request approval from yourself. Choose another approver, or use the inbox above to approve an existing request assigned to you."
			/>
		);
	}
	return <MutationError error={error} />;
}

export function useCursorPaging<T>() {
	const [cursor, setCursor] = useState<T | undefined>();
	const [history, setHistory] = useState<(T | undefined)[]>([]);
	return {
		cursor,
		hasPrevious: history.length > 0,
		next(nextCursor: T) {
			setHistory((current) => [...current, cursor]);
			setCursor(nextCursor);
		},
		previous() {
			setCursor(history.at(-1));
			setHistory(history.slice(0, -1));
		},
		reset() {
			setCursor(undefined);
			setHistory([]);
		},
	};
}

export function PageControls({
	hasPrevious,
	hasNext,
	onPrevious,
	onBack,
	onNext,
	label,
}: {
	label?: string;
	hasPrevious: boolean;
	hasNext: boolean;
	onPrevious: () => void;
	onBack?: () => void;
	onNext: () => void;
}) {
	if (!hasPrevious && !hasNext) return null;
	return (
		<div className="flex gap-2">
			<Button variant="outline" disabled={!hasPrevious} onClick={onPrevious}>
				{label ? `First ${label} page` : "First page"}
			</Button>
			{onBack ? (
				<Button variant="outline" disabled={!hasPrevious} onClick={onBack}>
					{label ? `Previous ${label} page` : "Back"}
				</Button>
			) : null}
			<Button variant="outline" disabled={!hasNext} onClick={onNext}>
				{label ? `Next ${label} page` : "Next page"}
			</Button>
		</div>
	);
}

const urgentInteractionMetadataSchema = z.object({
	host: z.string().optional(),
	sessionId: z.string().optional(),
	repository: z.string().optional(),
	triage: z.object({ urgentLabels: z.array(z.string()).optional() }).optional(),
});

/** Local hour and minute, e.g. "18:21". */
function clockTime(iso: string) {
	const at = new Date(normalizeD1Timestamp(iso));
	return Number.isNaN(at.getTime())
		? ""
		: at.toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
}

/**
 * Whether your answer to a session question reached that session, in plain
 * words, or null when there is nothing to tell (`metadata.delivery`).
 * `pending` is true while the answer has not reached the session itself.
 */
export function answerDeliveryLine(
	metadata: unknown,
): { text: string; pending: boolean } | null {
	const parsed = WorkInteractionDeliveryOverlaySchema.safeParse(
		(metadata as { delivery?: unknown } | null | undefined)?.delivery,
	);
	if (!parsed.success) return null;
	const delivery = parsed.data;
	switch (delivery.state) {
		case "saved":
			return { text: "Saved", pending: true };
		case "delivered": {
			const time = delivery.deliveredAt ? clockTime(delivery.deliveredAt) : "";
			return {
				text: `Delivered to your session${time ? ` ${time}` : ""}`,
				pending: false,
			};
		}
		case "acknowledged":
			return { text: "Acknowledged", pending: false };
		case "not_needed":
			return { text: "Closed (no delivery)", pending: false };
		case "handed_off":
			return {
				text: `Couldn't reach the session — handed to ${delivery.handoffTo ?? "another session"}`,
				pending: true,
			};
	}
}

/** Plain-language reasons and origin for one triaged agent-turn request. */
export function urgentInteractionSummary(metadata: unknown) {
	const parsed = urgentInteractionMetadataSchema.safeParse(metadata);
	const value = parsed.success ? parsed.data : {};
	return {
		reasons: urgentReasons(value.triage?.urgentLabels),
		origin: [
			value.repository,
			value.host,
			value.sessionId ? `session ${value.sessionId.slice(0, 8)}` : undefined,
		].filter((part): part is string => Boolean(part)),
		sessionId: value.sessionId,
	};
}

/**
 * Each turn end of a captured agent session opens a new question, so one busy
 * session floods the inbox. Within the loaded page, an open decision-capture
 * question shows only as the newest of its session, at that row's position;
 * the older open ones from the same session travel with it as `earlier`
 * (newest first). Every other row passes through unchanged and alone.
 */
export function groupSessionQuestions<
	T extends {
		request: { id: string; requestedAt: string; metadata?: unknown };
		effectiveState: string;
	},
>(rows: readonly T[]): Array<{ row: T; earlier: T[] }> {
	const sessionOf = (row: T) =>
		row.effectiveState === "open"
			? decisionCaptureSummary(row.request.metadata)?.sessionId
			: undefined;
	const sessions = new Map<string, T[]>();
	for (const row of rows) {
		const session = sessionOf(row);
		if (session) sessions.set(session, [...(sessions.get(session) ?? []), row]);
	}
	for (const members of sessions.values())
		members.sort((a, b) =>
			b.request.requestedAt.localeCompare(a.request.requestedAt),
		);
	return rows.flatMap((row) => {
		const session = sessionOf(row);
		if (!session) return [{ row, earlier: [] }];
		const [newest, ...earlier] = sessions.get(session) ?? [row];
		return newest === row ? [{ row, earlier }] : [];
	});
}

export function SchedulerTruncationWarnings({
	factsTruncated,
	truncatedFacts,
	graphTruncated,
}: {
	factsTruncated: boolean;
	truncatedFacts: (
		| "dependencies"
		| "capabilities"
		| "approvals"
		| "resources"
		| "budgets"
		| "cases"
	)[];
	graphTruncated: boolean;
}) {
	return (
		<>
			{factsTruncated ? (
				<Alert variant="destructive">
					<AlertTitle>Admission facts incomplete</AlertTitle>
					<AlertDescription>
						Bounded {truncatedFacts.map(sentenceCase).join(", ")} reads
						overflowed. Affected candidates are withheld as evaluation required;
						the ready queue is partial and absence is not an eligibility
						decision.
					</AlertDescription>
				</Alert>
			) : null}
			{graphTruncated ? (
				<Alert>
					<AlertTitle>Dependency ranking is approximate</AlertTitle>
					<AlertDescription>
						Bounded graph traversal was truncated. Emitted candidates passed
						hard admission gates, but downstream and critical-path scores may be
						partial.
					</AlertDescription>
				</Alert>
			) : null}
		</>
	);
}
