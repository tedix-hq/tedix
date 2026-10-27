import {
	WorkPageHeader,
	WorkListSkeleton,
	WorkReadFailure,
	WorkEmpty,
} from "@/components/work-surface-primitives";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Link } from "@/components/kumo/link";
import { Page } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import {
	tediRosterQueryOptions,
	workExecutionClustersQueryOptions,
} from "@/lib/os-query-options";
import {
	OperationPicker,
	ReadinessOverview,
	SchedulerTruncationWarnings,
} from "./work-operations-shared";

const clusterLookupSchema = z.object({
	tediId: z.string().trim().uuid("Enter a canonical tedi UUID."),
});

export function WorkClustersPage() {
	const tedis = useQuery(tediRosterQueryOptions(100));
	const [executorId, setExecutorId] = useState("");
	const clusters = useQuery({
		...workExecutionClustersQueryOptions(
			executorId || "00000000-0000-4000-8000-000000000000",
		),
		enabled: Boolean(executorId),
	});
	const form = useZodForm({
		schema: clusterLookupSchema,
		defaultValues: { tediId: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => setExecutorId(value.tediId),
	});
	return (
		<Page width="full">
			<WorkPageHeader
				title="Execution clusters"
				description="Plan groups of Work that can run together for one tedi. Each item is checked again before it starts."
			/>
			<Card>
				<CardHeader>
					<CardTitle>Executor snapshot</CardTitle>
					<CardDescription>
						Choose an existing tedi to view advisory waves. This does not start
						any Work.
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-3">
					{tedis.isPending ? (
						<WorkListSkeleton />
					) : tedis.isError ? (
						<WorkReadFailure
							title="Tedi roster unavailable"
							error={tedis.error}
							onRetry={() => tedis.refetch()}
							retrying={tedis.isFetching}
						/>
					) : tedis.data?.data.length ? (
						<>
							<Text as="p" role="label" tone="secondary">
								Showing up to 100 tedis in this snapshot.
							</Text>
							<OperationPicker
								label="Choose a tedi"
								value={executorId}
								options={tedis.data.data.map((tedi) => ({
									value: tedi.id,
									label: tedi.displayName || tedi.name,
								}))}
								onSelect={setExecutorId}
							/>
						</>
					) : (
						<WorkEmpty
							title="No tedis available"
							description="No executor appears in this roster snapshot."
						/>
					)}
					<Collapsible>
						<CollapsibleTrigger>Advanced: tedi UUID</CollapsibleTrigger>
						<CollapsibleContent>
							<form
								className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
								onSubmit={(event) => {
									event.preventDefault();
									void form.handleSubmit();
								}}
							>
								<FormField form={form} name="tediId" label="Executor tedi id">
									{(field, meta) => (
										<FormInput
											field={field}
											{...meta}
											placeholder="Tedi UUID"
										/>
									)}
								</FormField>
								<Button type="submit" variant="outline">
									Plan waves
								</Button>
							</form>
						</CollapsibleContent>
					</Collapsible>
				</CardContent>
			</Card>
			<ReadinessOverview />
			{clusters.isPending && executorId ? <WorkListSkeleton /> : null}
			{clusters.isError ? (
				<WorkReadFailure
					title="Execution cluster plan unavailable"
					error={clusters.error}
					onRetry={() => clusters.refetch()}
					retrying={clusters.isFetching}
				/>
			) : clusters.data ? (
				<>
					<SchedulerTruncationWarnings {...clusters.data} />
					<Alert>
						<AlertTitle>Advisory execution plan</AlertTitle>
						<AlertDescription>
							Launch items within one wave in parallel. Re-read the plan before
							advancing to the next wave; admission remains authoritative.
						</AlertDescription>
					</Alert>
					{clusters.data.clusters.length ? (
						<div className="grid gap-3 lg:grid-cols-2">
							{clusters.data.clusters.map((cluster) => (
								<Card key={cluster.index}>
									<CardHeader>
										<CardTitle>Wave {cluster.index}</CardTitle>
										<CardDescription>
											{cluster.recommendedMaxParallelism} parallel ·{" "}
											{cluster.resourceKeys.length
												? cluster.resourceKeys.join(", ")
												: "no declared resource collision"}
										</CardDescription>
									</CardHeader>
									<CardContent>
										<ol className="m-0 grid gap-2 pl-5">
											{cluster.items.map((item) => (
												<li key={item.workItemId}>
													<Link href={`/work/items/${item.workItemId}`}>
														{item.title}
													</Link>{" "}
													· score {item.score}
												</li>
											))}
										</ol>
									</CardContent>
								</Card>
							))}
						</div>
					) : (
						<WorkEmpty
							title="No eligible execution waves"
							description="No Work Item passed every hard gate for this tedi in the bounded snapshot."
						/>
					)}
				</>
			) : null}
		</Page>
	);
}
