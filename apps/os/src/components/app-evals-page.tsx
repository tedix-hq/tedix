/**
 * /apps/$appId/evals — widget evaluation runs. The runs list keys on the app SLUG (the
 * contract's input), which comes from the layout's app-detail cache entry.
 * The list refetches every 30s while mounted so fresh runs land on their own.
 *
 * "Run Eval" mirrors the server's `platform:admin` gate on `mcpEval.run`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
	Camera,
	CheckCircle,
	CursorClick,
	Flask,
	Play,
	XCircle,
} from "@phosphor-icons/react";
import { toast } from "@/components/kumo/toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Card } from "@/components/kumo/card";
import { Loader } from "@/components/kumo/loader";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import {
	PageActions,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { osApi } from "@/lib/api";
import { EVALS_RUN_DENIED_REASON, useCanRunEvals } from "@/lib/app-permissions";
import {
	appDetailQueryOptions,
	osQueryKeys,
	widgetTestRunsQueryOptions,
} from "@/lib/os-query-options";
import { relativeTime } from "@/lib/time";

function RunEvalButton({ appSlug }: { appSlug: string }) {
	const queryClient = useQueryClient();
	const canRun = useCanRunEvals();

	const runEval = useMutation({
		mutationFn: () => osApi.mcpEval.run({ appSlug }),
		onSuccess: (result) => {
			toast.success(`Eval started — job ${result.jobId}`);
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.appWidgetTestRuns(),
			});
		},
		onError: (error) => {
			toast.error(`Failed to start eval: ${error.message}`);
		},
	});

	return (
		<Button
			size="sm"
			onClick={() => runEval.mutate()}
			disabled={!canRun || runEval.isPending}
			title={canRun ? undefined : EVALS_RUN_DENIED_REASON}
			icon={
				runEval.isPending ? (
					<Loader aria-label="Starting eval" size={14} />
				) : (
					<Play size={14} />
				)
			}
		>
			{runEval.isPending ? "Starting..." : "Run Eval"}
		</Button>
	);
}

export function AppEvalsPage() {
	const params = useParams({ from: "/_session/_tenant/apps_/$appId" });
	const appId = params.appId ?? "";

	const detail = useQuery({
		...appDetailQueryOptions(appId),
		enabled: appId.length > 0,
	});
	const appSlug = detail.data?.app?.slug ?? "";

	const runsQuery = useQuery({
		...widgetTestRunsQueryOptions(appSlug),
		enabled: appSlug.length > 0,
		refetchInterval: 30_000,
	});

	if (detail.isPending || (appSlug.length > 0 && runsQuery.isPending)) {
		return (
			<div aria-hidden="true" className="grid gap-4">
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<Skeleton className="h-24" />
					<Skeleton className="h-24" />
					<Skeleton className="h-24" />
					<Skeleton className="h-24" />
				</div>
				<Skeleton className="h-64" />
			</div>
		);
	}
	if (runsQuery.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Evaluation runs are unavailable</AlertTitle>
				<AlertDescription>
					{(runsQuery.error as Error).message}
				</AlertDescription>
			</Alert>
		);
	}

	const runs = runsQuery.data?.runs ?? [];
	const passCount = runs.filter((run) => run.passed).length;
	const failCount = runs.length - passCount;
	const avgDuration =
		runs.length > 0
			? runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0) / runs.length
			: 0;

	return (
		<PageSection aria-labelledby="app-widget-evals-title">
			<SectionHeader>
				<SectionHeading>
					<span className="flex flex-wrap items-center gap-2">
						<SectionTitle id="app-widget-evals-title">
							Widget evals
						</SectionTitle>
						<Badge variant="secondary">{runs.length}</Badge>
					</span>
					<SectionDescription>
						Visual and interaction evidence from governed widget tests.
					</SectionDescription>
				</SectionHeading>
				<PageActions>
					<RunEvalButton appSlug={appSlug} />
				</PageActions>
			</SectionHeader>

			{runs.length === 0 && (
				<Empty appearance="quiet">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Flask size={20} />
						</EmptyMedia>
						<EmptyTitle>No evaluations yet</EmptyTitle>
						<EmptyDescription>
							Run widget evaluations via the{" "}
							<Text
								as="code"
								role="label"
								className="rounded bg-kumo-fill px-1.5 py-0.5"
							>
								run_widget_test
							</Text>{" "}
							or{" "}
							<Text
								as="code"
								role="label"
								className="rounded bg-kumo-fill px-1.5 py-0.5"
							>
								run_interactive_widget_test
							</Text>{" "}
							MCP tools. Results will appear here automatically.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}

			{runs.length > 0 && (
				<>
					<MetricGrid aria-label="Evaluation summary" columns={4}>
						<MetricItem
							emphasis="metric"
							label="Total runs"
							value={String(runs.length)}
						/>
						<MetricItem
							emphasis="metric"
							label="Passed"
							value={String(passCount)}
						/>
						<MetricItem
							emphasis="metric"
							label="Failed"
							value={String(failCount)}
						/>
						<MetricItem
							emphasis="metric"
							label="Avg duration"
							value={`${(avgDuration / 1000).toFixed(1)}s`}
						/>
					</MetricGrid>

					<Card className="overflow-hidden p-0">
						<Table scrollLabel="Widget evaluation runs">
							<TableHeader>
								<TableRow>
									<TableHead>Status</TableHead>
									<TableHead>Tool</TableHead>
									<TableHead>Mode</TableHead>
									<TableHead>Steps</TableHead>
									<TableHead>Screenshots</TableHead>
									<TableHead>Duration</TableHead>
									<TableHead>When</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{runs.map((run) => {
									const screenshots = Array.isArray(run.screenshots)
										? (run.screenshots as unknown as Array<{
												label: string;
												url: string;
											}>)
										: [];
									return (
										<TableRow key={run.id}>
											<TableCell>
												<Link
													to="/apps/$appId/evals/$evalId"
													params={{ appId, evalId: run.id }}
													preload="intent"
													className="inline-flex no-underline"
												>
													{run.passed ? (
														<Badge variant="success" className="gap-1">
															<CheckCircle size={12} aria-hidden />
															Pass
														</Badge>
													) : (
														<Badge variant="destructive" className="gap-1">
															<XCircle size={12} aria-hidden />
															Fail
														</Badge>
													)}
												</Link>
											</TableCell>
											<TableCell className="font-mono">
												{run.toolName}
											</TableCell>
											<TableCell>
												<Badge variant="secondary" className="gap-1">
													{run.mode === "interactive" ? (
														<>
															<CursorClick size={12} aria-hidden />
															Interactive
														</>
													) : (
														"Static"
													)}
												</Badge>
											</TableCell>
											<TableCell>
												{run.stepCount != null ? (
													<Text as="span" role="body">
														{run.stepsPassedCount}/{run.stepCount}
													</Text>
												) : (
													<Text as="span" role="body" tone="secondary">
														--
													</Text>
												)}
											</TableCell>
											<TableCell>
												{screenshots.length > 0 ? (
													<Text
														as="span"
														role="body"
														className="flex items-center gap-1"
													>
														<Camera
															size={12}
															aria-hidden
															className="text-kumo-subtle"
														/>
														{screenshots.length}
													</Text>
												) : (
													<Text as="span" role="body" tone="secondary">
														--
													</Text>
												)}
											</TableCell>
											<TableCell className="">
												{run.durationMs != null
													? `${(run.durationMs / 1000).toFixed(1)}s`
													: "--"}
											</TableCell>
											<TableCell className="text-kumo-subtle">
												{run.createdAt ? relativeTime(run.createdAt) : "--"}
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</Card>
				</>
			)}
		</PageSection>
	);
}
