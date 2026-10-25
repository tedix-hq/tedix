/**
 * Tedis whose tools a gateway exposes (`mcpConfig.aggregateTedis`), next to
 * "Assigned tedis". Each change saves the whole list through `apps.update`,
 * which merges `mcpConfig` and keeps every other setting; entry fields this
 * page does not edit (namespace, session, server URL) are carried over.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { App } from "@tedix/api-contract/schemas/app";
import { Plus, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { AppTabHeader } from "@/components/app-detail-tab-shared";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Empty, EmptyDescription } from "@/components/kumo/empty";
import { PageSection } from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { toast } from "@/components/kumo/toast";
import { osApi } from "@/lib/api";
import { APPS_MANAGE_DENIED_REASON } from "@/lib/app-permissions";
import {
	osQueryKeys,
	TEDI_ROSTER_LIMIT,
	tediRosterQueryOptions,
} from "@/lib/os-query-options";

export type AggregatedTediSurface = "full" | "collaboration";

export interface AggregatedTedi {
	slug: string;
	namespace?: string;
	sessionKey?: string;
	serverUrl?: string;
	surface?: AggregatedTediSurface;
	surfaceRev?: string;
}

const SURFACE_LABELS: Record<AggregatedTediSurface, string> = {
	full: "Full tools",
	collaboration: "Collaboration only",
};

/** The gateway's current list, tolerating older rows. */
export function readAggregatedTedis(app: Pick<App, "metadata">) {
	const raw = (app.metadata?.mcpConfig as { aggregateTedis?: unknown })
		?.aggregateTedis;
	return Array.isArray(raw)
		? raw.filter(
				(entry): entry is AggregatedTedi =>
					Boolean(entry) &&
					typeof entry === "object" &&
					typeof (entry as AggregatedTedi).slug === "string",
			)
		: [];
}

export function withAggregatedTedi(
	list: readonly AggregatedTedi[],
	slug: string,
	surface: AggregatedTediSurface,
): AggregatedTedi[] {
	return list.some((entry) => entry.slug === slug)
		? [...list]
		: [...list, { slug, surface }];
}

export function withoutAggregatedTedi(
	list: readonly AggregatedTedi[],
	slug: string,
): AggregatedTedi[] {
	return list.filter((entry) => entry.slug !== slug);
}

/** Changing the surface drops a cached surface revision built for the old one. */
export function withAggregatedTediSurface(
	list: readonly AggregatedTedi[],
	slug: string,
	surface: AggregatedTediSurface,
): AggregatedTedi[] {
	return list.map((entry) => {
		if (entry.slug !== slug) return entry;
		const { surfaceRev: _stale, ...rest } = entry;
		return { ...rest, surface };
	});
}

/** Trigger text for a surface value (the list items are not mounted while closed). */
function surfaceLabel(value: unknown): string {
	return value === "collaboration"
		? SURFACE_LABELS.collaboration
		: SURFACE_LABELS.full;
}

export function AppAggregatedTedis({
	app,
	canManage,
}: {
	app: App;
	canManage: boolean;
}) {
	const queryClient = useQueryClient();
	const included = readAggregatedTedis(app);
	const [addSlug, setAddSlug] = useState("");
	const [addSurface, setAddSurface] = useState<AggregatedTediSurface>("full");

	const roster = useQuery({
		...tediRosterQueryOptions(TEDI_ROSTER_LIMIT),
		staleTime: 60_000,
	});
	const tedis = roster.data?.data ?? [];
	const nameBySlug = new Map(
		tedis.map((tedi) => [tedi.slug, tedi.displayName || tedi.name]),
	);
	const includedSlugs = new Set(included.map((entry) => entry.slug));
	const available = tedis.filter((tedi) => !includedSlugs.has(tedi.slug));

	const save = useMutation({
		mutationFn: (next: AggregatedTedi[]) =>
			osApi.apps.update({
				appId: app.id,
				metadata: { mcpConfig: { aggregateTedis: next } },
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: osQueryKeys.apps() });
			toast.success("Gateway tedis saved");
		},
		onError: (error) => {
			toast.error(error.message || "Failed to save gateway tedis");
		},
	});
	const disabled = !canManage || save.isPending;
	const label = (slug: string) => nameBySlug.get(slug) ?? slug;

	return (
		<PageSection>
			<AppTabHeader
				title="Tedis on this gateway"
				description="Tedis whose tools this gateway exposes to connected agents"
			/>
			<div className="space-y-3">
				{!canManage ? (
					<Alert>
						<AlertDescription>{APPS_MANAGE_DENIED_REASON}</AlertDescription>
					</Alert>
				) : null}
				{roster.error ? (
					<Alert variant="destructive">
						<AlertDescription>
							Tedi names could not be loaded. Slugs are shown instead.
						</AlertDescription>
					</Alert>
				) : null}
				{included.length === 0 ? (
					<Empty appearance="quiet">
						<EmptyDescription>
							This gateway exposes no tedis yet.
						</EmptyDescription>
					</Empty>
				) : (
					<Table scrollLabel="Tedis on this gateway">
						<TableHeader>
							<TableRow>
								<TableHead>Tedi</TableHead>
								<TableHead className="w-48">Tools</TableHead>
								<TableHead className="w-20 text-right">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{included.map((entry) => (
								<TableRow key={entry.slug}>
									<TableCell className="font-medium">
										{label(entry.slug)}
										{entry.namespace && entry.namespace !== entry.slug ? (
											<span className="ml-2 text-kumo-subtle">
												{entry.namespace}
											</span>
										) : null}
									</TableCell>
									<TableCell>
										<Select
											value={entry.surface ?? "full"}
											onValueChange={(value) =>
												save.mutate(
													withAggregatedTediSurface(
														included,
														entry.slug,
														value === "collaboration"
															? "collaboration"
															: "full",
													),
												)
											}
											disabled={disabled}
										>
											<SelectTrigger
												aria-label={`Tools exposed for ${label(entry.slug)}`}
												className="w-44"
												size="sm"
											>
												<SelectValue>{surfaceLabel}</SelectValue>
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="full">
													{SURFACE_LABELS.full}
												</SelectItem>
												<SelectItem value="collaboration">
													{SURFACE_LABELS.collaboration}
												</SelectItem>
											</SelectContent>
										</Select>
									</TableCell>
									<TableCell className="text-right">
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`Remove ${label(entry.slug)} from this gateway`}
											disabled={disabled}
											onClick={() =>
												save.mutate(withoutAggregatedTedi(included, entry.slug))
											}
											icon={<Trash size={16} className="text-kumo-danger" />}
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
				<form
					className="flex flex-wrap items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (!addSlug) return;
						save.mutate(withAggregatedTedi(included, addSlug, addSurface), {
							onSuccess: () => setAddSlug(""),
						});
					}}
				>
					<Select
						value={addSlug}
						onValueChange={(value) => setAddSlug(value ?? "")}
						disabled={disabled || available.length === 0}
					>
						<SelectTrigger
							aria-label="Tedi to add"
							className="w-full sm:w-56"
							size="sm"
						>
							<SelectValue
								placeholder={
									roster.isLoading
										? "Loading tedis…"
										: available.length === 0
											? "No other tedis"
											: "Select a tedi…"
								}
							>
								{(value: unknown) =>
									typeof value === "string" && value
										? label(value)
										: roster.isLoading
											? "Loading tedis…"
											: available.length === 0
												? "No other tedis"
												: "Select a tedi…"
								}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{available.map((tedi) => (
								<SelectItem key={tedi.id} value={tedi.slug}>
									{tedi.displayName || tedi.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={addSurface}
						onValueChange={(value) =>
							setAddSurface(
								value === "collaboration" ? "collaboration" : "full",
							)
						}
						disabled={disabled}
					>
						<SelectTrigger
							aria-label="Tools to expose for the new tedi"
							className="w-full sm:w-44"
							size="sm"
						>
							<SelectValue>{surfaceLabel}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="full">{SURFACE_LABELS.full}</SelectItem>
							<SelectItem value="collaboration">
								{SURFACE_LABELS.collaboration}
							</SelectItem>
						</SelectContent>
					</Select>
					<Button
						type="submit"
						size="sm"
						disabled={disabled || !addSlug}
						icon={<Plus size={14} />}
					>
						Add tedi
					</Button>
				</form>
			</div>
		</PageSection>
	);
}
