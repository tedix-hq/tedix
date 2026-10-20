import { Question } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { SupportReport } from "@tedix/api-contract/schemas/support";
import {
	redactSupportReport,
	redactSupportText,
	supportPayloadDigest,
} from "@tedix/api-contract/utils/support-report";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Checkbox } from "@/components/kumo/checkbox";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@/components/kumo/dialog";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { Link } from "@/components/kumo/link";

export function SupportGetHelp({ organization }: { organization: string }) {
	const client = useQueryClient();
	const id = useId();
	const [open, setOpen] = useState(false);
	const [report, setReport] = useState<SupportReport | null>(null);
	const [preview, setPreview] = useState<SupportReport | null>(null);
	const [approved, setApproved] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [receipt, setReceipt] = useState<{
		ticketId: string;
		statusUrl: string;
	} | null>(null);
	const [key, setKey] = useState("");
	function start() {
		const recent = client
			.getQueryCache()
			.getAll()
			.filter((q) => q.state.error)
			.sort((a, b) => b.state.errorUpdatedAt - a.state.errorUpdatedAt)[0]
			?.state.error;
		setReport({
			title: "",
			expected: "",
			actual: "",
			steps: "",
			impact: "",
			diagnosticRefs: [],
			page: window.location.pathname,
			lastError:
				recent instanceof Error
					? redactSupportText(recent.message).slice(0, 500)
					: "",
			observedAt: new Date().toISOString(),
			origin: "os",
			language: document.documentElement.lang.startsWith("es") ? "es" : "en",
		});
		setPreview(null);
		setApproved(false);
		setError("");
		setReceipt(null);
		setKey(crypto.randomUUID());
		setOpen(true);
	}
	function update(field: keyof SupportReport, value: string) {
		if (report) setReport({ ...report, [field]: value });
		setPreview(null);
		setApproved(false);
	}
	async function send() {
		if (!preview || !approved) return;
		setBusy(true);
		setError("");
		try {
			const { osApi } = await import("@/lib/api");
			const digest = await supportPayloadDigest(preview);
			setReceipt(
				await osApi.support.file({
					idempotencyKey: key,
					report: preview,
					consent: {
						approved: true,
						reference: `OS preview ${preview.observedAt}`,
						payloadDigest: digest,
					},
				}),
			);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not file support request",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<Button
				variant="ghost"
				onClick={start}
				aria-label="Get help"
				title="Get help"
				className="max-sm:size-11 max-sm:p-0"
			>
				<Question aria-hidden size={20} className="sm:hidden" />
				<span className="max-sm:sr-only">Get help</span>
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent size="xl" className="min-[900px]:w-[52rem]">
					<DialogHeader>
						<DialogTitle>Get help</DialogTitle>
						<DialogDescription>
							Share a short report with your organization and Tedix Support.
							Review exactly what is shared before filing.
						</DialogDescription>
					</DialogHeader>
					{receipt ? (
						<Text as="p" role="body" tone="secondary" aria-live="polite">
							Request filed:{" "}
							<Link href={receipt.statusUrl}>{receipt.ticketId}</Link>. Support
							will review it; this receipt is not an answer.
						</Text>
					) : report ? (
						<>
							<p>Organization: {organization}</p>
							<div className="support-report-fields grid gap-4">
								<div className="grid content-start gap-3">
									<div className="grid gap-1">
										<Label htmlFor={`${id}-title`}>Summary</Label>
										<Input
											id={`${id}-title`}
											autoFocus
											value={report.title}
											aria-label="Summary"
											maxLength={200}
											onChange={(e) => update("title", e.target.value)}
										/>
									</div>
									<div className="grid gap-1">
										<Label htmlFor={`${id}-expected`}>
											What did you expect?
										</Label>
										<Textarea
											id={`${id}-expected`}
											value={report.expected}
											aria-label="What did you expect?"
											maxLength={2000}
											onChange={(e) => update("expected", e.target.value)}
										/>
									</div>
									<div className="grid gap-1">
										<Label htmlFor={`${id}-actual`}>What happened?</Label>
										<Textarea
											id={`${id}-actual`}
											value={report.actual}
											aria-label="What happened?"
											maxLength={2000}
											onChange={(e) => update("actual", e.target.value)}
										/>
									</div>
								</div>
								<div className="grid content-start gap-3">
									<div className="grid gap-1">
										<Label htmlFor={`${id}-steps`}>Steps to reproduce</Label>
										<Textarea
											id={`${id}-steps`}
											value={report.steps}
											aria-label="Steps to reproduce"
											maxLength={2000}
											onChange={(e) => update("steps", e.target.value)}
										/>
									</div>
									<div className="grid gap-1">
										<Label htmlFor={`${id}-impact`}>Impact</Label>
										<Input
											id={`${id}-impact`}
											value={report.impact}
											aria-label="Impact"
											maxLength={500}
											onChange={(e) => update("impact", e.target.value)}
										/>
									</div>
									<div className="grid gap-1">
										<Label htmlFor={`${id}-page`}>Page</Label>
										<Input
											id={`${id}-page`}
											value={report.page}
											aria-label="Page"
											maxLength={500}
											onChange={(e) => update("page", e.target.value)}
										/>
									</div>
									<div className="grid gap-1">
										<Label htmlFor={`${id}-lastError`}>
											Last error, if known
										</Label>
										<Input
											id={`${id}-lastError`}
											value={report.lastError}
											aria-label="Last error, if known"
											maxLength={500}
											onChange={(e) => update("lastError", e.target.value)}
										/>
									</div>
								</div>
							</div>
							{preview ? (
								<>
									<pre className="whitespace-pre-wrap break-words text-sm">
										{JSON.stringify(preview, null, 2)}
									</pre>
									<Checkbox
										label="I approve sharing this exact report with my organization and Tedix Support"
										checked={approved}
										onCheckedChange={(value) => setApproved(value === true)}
									/>
								</>
							) : null}
							{error ? (
								<Alert variant="destructive">
									<AlertDescription>{error}</AlertDescription>
								</Alert>
							) : null}
							<DialogFooter className="flex-col sm:flex-col">
								<p className="text-kumo-subtle type-tedix-caption">
									Leave out private messages, customer data and credentials.
								</p>
								<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
									<Button
										variant="secondary"
										onClick={() => {
											try {
												setPreview(redactSupportReport(report));
												setError("");
											} catch {
												setError(
													"Add a summary, expected behavior and actual behavior before previewing.",
												);
											}
										}}
									>
										Preview report
									</Button>
									<Button
										disabled={!approved || !preview || busy}
										onClick={() => void send()}
									>
										{busy ? "Filing…" : "File support request"}
									</Button>
								</div>
							</DialogFooter>
						</>
					) : null}
				</DialogContent>
			</Dialog>
		</>
	);
}
