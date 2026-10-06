/**
 * /apps/$appId/evals/$evalId — a single widget evaluation run: screenshots
 * gallery, step
 * timeline, widget analysis, tool result, and DOM summary.
 */

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
	ArrowLeft,
	ArrowSquareOut,
	Camera,
	CheckCircle,
	Clock,
	Code,
	CursorClick,
	Warning,
	XCircle,
} from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { CodeBlock } from "@/components/kumo/code";
import { Separator } from "@/components/kumo/separator";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { widgetTestRunDetailQueryOptions } from "@/lib/os-query-options";
import { relativeTime } from "@/lib/time";

interface StepResult {
	step: number;
	action: string;
	label?: string;
	success: boolean;
	error?: string;
	screenshotUrl?: string;
	durationMs: number;
}

interface Screenshot {
	label: string;
	url: string;
	mimeType: string;
}

interface ToolResult {
	contentSummary: string;
	dataKeys: string[];
	itemCount?: number;
	isError?: boolean;
}

interface DomSummary {
	title?: string;
	elementCount: number;
	textContent: string;
	errors: string[];
}

interface WidgetAnalysis {
	componentTree: string;
	totalElements: number;
	stateKeys: string[];
	dataBindings: string[];
	issues: Array<{ severity: "error" | "warning"; message: string }>;
}

export function AppEvalDetailPage() {
	const { appId, evalId } = useParams({
		from: "/_session/_tenant/apps_/$appId/evals/$evalId",
	});

	const runQuery = useQuery({
		...widgetTestRunDetailQueryOptions(evalId ?? ""),
		enabled: Boolean(evalId),
	});

	if (runQuery.isPending) {
		return (
			<div aria-hidden="true" className="grid gap-4">
				<Skeleton className="h-5 w-24" />
				<Skeleton className="h-7 w-64" />
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Skeleton className="h-64" />
					<Skeleton className="h-64" />
				</div>
			</div>
		);
	}
	if (runQuery.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Evaluation run is unavailable</AlertTitle>
				<AlertDescription>{(runQuery.error as Error).message}</AlertDescription>
			</Alert>
		);
	}

	const run = runQuery.data;
	const steps = Array.isArray(run.stepResults)
		? (run.stepResults as unknown as StepResult[])
		: [];
	const screenshots = Array.isArray(run.screenshots)
		? (run.screenshots as unknown as Screenshot[])
		: [];
	const toolResult = run.toolResult as ToolResult | null;
	const domSummary = run.domSummary as DomSummary | null;
	const widgetAnalysis = run.widgetAnalysis as WidgetAnalysis | null;

	return (
		<div className="space-y-6">
			{/* Back link + header */}
			<div className="space-y-4">
				<Link
					to="/apps/$appId/evals"
					params={{ appId }}
					className="inline-flex items-center gap-1.5 text-kumo-subtle text-sm no-underline transition-colors duration-150 hover:text-kumo-default"
				>
					<ArrowLeft size={14} />
					Back to Evals
				</Link>

				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-3">
							<Text
								as="h2"
								role="dialog"
								weight="semibold"
								className="m-0 break-words"
							>
								{run.toolName}
							</Text>
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
						</div>
						<Text
							as="p"
							role="body"
							tone="secondary"
							className="mt-1 mb-0 flex flex-wrap items-center gap-x-4 gap-y-1"
						>
							<span className="flex items-center gap-1">
								<Clock size={14} aria-hidden />
								{run.durationMs != null
									? `${(run.durationMs / 1000).toFixed(1)}s`
									: "--"}
							</span>
							{run.stepCount != null && (
								<span>
									Steps: {run.stepsPassedCount}/{run.stepCount}
								</span>
							)}
							<span>{run.createdAt ? relativeTime(run.createdAt) : ""}</span>
						</Text>
					</div>
					{run.previewUrl && (
						<a
							href={run.previewUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex shrink-0 items-center gap-1.5 text-kumo-subtle text-sm no-underline transition-colors duration-150 hover:text-kumo-default"
						>
							<ArrowSquareOut size={14} aria-hidden />
							Live Preview
						</a>
					)}
				</div>
			</div>

			{/* Screenshots Gallery */}
			{screenshots.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Camera size={16} aria-hidden />
							Screenshots ({screenshots.length})
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							{screenshots.map((screenshot) => (
								<div key={screenshot.label} className="space-y-2">
									<a
										href={screenshot.url}
										target="_blank"
										rel="noopener noreferrer"
										className="block overflow-hidden rounded-lg border border-kumo-line transition-colors hover:border-kumo-hairline"
									>
										<img
											src={screenshot.url}
											alt={screenshot.label}
											className="w-full"
											loading="lazy"
										/>
									</a>
									<Text
										as="p"
										role="label"
										tone="secondary"
										weight="medium"
										className="m-0 text-center"
									>
										{screenshot.label}
									</Text>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Step Timeline */}
			{steps.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>
							Step Timeline ({steps.filter((step) => step.success).length}/
							{steps.length} passed)
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="space-y-0">
							{steps.map((step, index) => (
								<div key={step.step}>
									<div className="flex items-center gap-3 py-2.5">
										<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-medium text-xs">
											{step.success ? (
												<CheckCircle
													size={16}
													aria-hidden
													className="text-kumo-success"
												/>
											) : (
												<XCircle
													size={16}
													aria-hidden
													className="text-kumo-danger"
												/>
											)}
										</div>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<Text as="span" role="body" tone="mono" weight="medium">
													{step.action}
												</Text>
												{step.label && (
													<Badge variant="outline">{step.label}</Badge>
												)}
											</div>
											{step.error && (
												<Text
													as="p"
													role="label"
													tone="error"
													className="mt-0.5 mb-0"
												>
													{step.error}
												</Text>
											)}
										</div>
										<Text
											as="span"
											role="label"
											tone="secondary"
											className="shrink-0"
										>
											{step.durationMs}ms
										</Text>
									</div>
									{index < steps.length - 1 && <Separator />}
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Widget Analysis */}
			{widgetAnalysis && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Code size={16} aria-hidden />
							Widget Analysis
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						{widgetAnalysis.issues.length > 0 && (
							<div className="space-y-2">
								<Text
									as="p"
									role="label"
									tone="secondary"
									weight="medium"
									className="m-0"
								>
									Issues ({widgetAnalysis.issues.length})
								</Text>
								<div className="space-y-1.5">
									{widgetAnalysis.issues.map((issue, index) => (
										<div
											key={`issue-${index}`}
											className="flex items-start gap-2 text-xs"
										>
											{issue.severity === "error" ? (
												<XCircle
													size={12}
													aria-hidden
													className="mt-0.5 shrink-0 text-kumo-danger"
												/>
											) : (
												<Warning
													size={12}
													aria-hidden
													className="mt-0.5 shrink-0 text-kumo-warning"
												/>
											)}
											<Text
												as="span"
												role="label"
												tone={issue.severity === "error" ? "error" : "warning"}
											>
												{issue.message}
											</Text>
										</div>
									))}
								</div>
							</div>
						)}
						{widgetAnalysis.issues.length === 0 && (
							<div className="flex items-center gap-2 text-kumo-success text-xs">
								<CheckCircle size={12} aria-hidden />
								No issues found
							</div>
						)}

						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<div>
								<Text
									as="p"
									role="label"
									tone="secondary"
									weight="medium"
									className="m-0"
								>
									State Keys ({widgetAnalysis.stateKeys.length})
								</Text>
								<div className="mt-1 flex flex-wrap gap-1">
									{widgetAnalysis.stateKeys.map((key) => (
										<Badge key={key} variant="secondary">
											{key}
										</Badge>
									))}
								</div>
							</div>

							<div>
								<Text
									as="p"
									role="label"
									tone="secondary"
									weight="medium"
									className="m-0"
								>
									Data Bindings ({widgetAnalysis.dataBindings.length})
								</Text>
								<div className="mt-1 flex flex-wrap gap-1">
									{widgetAnalysis.dataBindings.map((binding) => (
										<Badge
											key={binding}
											variant="outline"
											className="font-mono"
										>
											{binding}
										</Badge>
									))}
								</div>
							</div>
						</div>

						{widgetAnalysis.componentTree && (
							<div>
								<Text
									as="p"
									role="label"
									tone="secondary"
									weight="medium"
									className="m-0"
								>
									Component Tree ({widgetAnalysis.totalElements} elements)
								</Text>
								<CodeBlock
									className="mt-1 max-h-60 overflow-y-auto"
									code={widgetAnalysis.componentTree}
									lang="text"
								/>
							</div>
						)}
					</CardContent>
				</Card>
			)}

			{/* Tool Result + DOM Summary */}
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
				{toolResult && (
					<Card>
						<CardHeader>
							<CardTitle>Tool Result</CardTitle>
						</CardHeader>
						<CardContent className="space-y-3">
							<div>
								<Text
									as="p"
									role="label"
									tone="secondary"
									weight="medium"
									className="m-0"
								>
									Data Keys
								</Text>
								<div className="mt-1 flex flex-wrap gap-1">
									{toolResult.dataKeys.map((key) => (
										<Badge key={key} variant="secondary">
											{key}
										</Badge>
									))}
								</div>
							</div>
							{toolResult.itemCount != null && (
								<div>
									<Text
										as="p"
										role="label"
										tone="secondary"
										weight="medium"
										className="m-0"
									>
										Items
									</Text>
									<Text as="p" role="body" className="m-0">
										{toolResult.itemCount}
									</Text>
								</div>
							)}
							{toolResult.isError && (
								<Badge variant="destructive">Tool returned error</Badge>
							)}
						</CardContent>
					</Card>
				)}

				{domSummary && (
					<Card>
						<CardHeader>
							<CardTitle>DOM Summary</CardTitle>
						</CardHeader>
						<CardContent className="space-y-3">
							{domSummary.title && (
								<div>
									<Text
										as="p"
										role="label"
										tone="secondary"
										weight="medium"
										className="m-0"
									>
										Title
									</Text>
									<Text as="p" role="body" className="m-0">
										{domSummary.title}
									</Text>
								</div>
							)}
							<div>
								<Text
									as="p"
									role="label"
									tone="secondary"
									weight="medium"
									className="m-0"
								>
									Elements
								</Text>
								<Text as="p" role="body" className="m-0">
									{domSummary.elementCount}
								</Text>
							</div>
							{domSummary.errors.length > 0 && (
								<div>
									<Text
										as="p"
										role="label"
										tone="secondary"
										weight="medium"
										className="m-0"
									>
										Console Errors
									</Text>
									<div className="mt-1 space-y-1">
										{domSummary.errors.map((err, index) => (
											<Text
												key={`err-${index}`}
												as="p"
												role="label"
												tone="error"
												className="m-0"
											>
												{err}
											</Text>
										))}
									</div>
								</div>
							)}
							{domSummary.textContent && (
								<div>
									<Text
										as="p"
										role="label"
										tone="secondary"
										weight="medium"
										className="m-0"
									>
										Text Content
									</Text>
									<Text
										as="p"
										role="label"
										tone="secondary"
										className="mt-1 mb-0 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-kumo-fill p-2"
									>
										{domSummary.textContent.slice(0, 1000)}
										{domSummary.textContent.length > 1000 && "..."}
									</Text>
								</div>
							)}
						</CardContent>
					</Card>
				)}
			</div>
		</div>
	);
}
