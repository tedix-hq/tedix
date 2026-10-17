import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { SupportReport } from "@tedix/api-contract/schemas/support";
import {
	redactSupportReport,
	redactSupportText,
	supportPayloadDigest,
} from "@tedix/api-contract/utils/support-report";
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
import { Textarea } from "@/components/kumo/textarea";
import { Link } from "@/components/kumo/link";

export function SupportGetHelp({ organization }: { organization: string }) {
	const client = useQueryClient();
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
			<Button variant="ghost" onClick={start}>
				Get help
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-w-xl">
					<DialogHeader>
						<DialogTitle>Get help</DialogTitle>
						<DialogDescription>
							Share a short report with your organization and Tedix Support.
							Review exactly what is shared before filing. Leave out private
							messages, customer data and credentials.
						</DialogDescription>
					</DialogHeader>
					{receipt ? (
						<p role="status">
							Request filed:{" "}
							<Link href={receipt.statusUrl}>{receipt.ticketId}</Link>. Support
							will review it; this receipt is not an answer.
						</p>
					) : report ? (
						<>
							<p>Organization: {organization}</p>
							<label>
								Summary
								<Input
									value={report.title}
									aria-label="Summary"
									maxLength={200}
									onChange={(e) => update("title", e.target.value)}
								/>
							</label>
							<label>
								What did you expect?
								<Textarea
									value={report.expected}
									aria-label="What did you expect?"
									maxLength={2000}
									onChange={(e) => update("expected", e.target.value)}
								/>
							</label>
							<label>
								What happened?
								<Textarea
									value={report.actual}
									aria-label="What happened?"
									maxLength={2000}
									onChange={(e) => update("actual", e.target.value)}
								/>
							</label>
							<label>
								Steps to reproduce
								<Textarea
									value={report.steps}
									aria-label="Steps to reproduce"
									maxLength={2000}
									onChange={(e) => update("steps", e.target.value)}
								/>
							</label>
							<label>
								Impact
								<Input
									value={report.impact}
									aria-label="Impact"
									maxLength={500}
									onChange={(e) => update("impact", e.target.value)}
								/>
							</label>
							<label>
								Page
								<Input
									value={report.page}
									aria-label="Page"
									maxLength={500}
									onChange={(e) => update("page", e.target.value)}
								/>
							</label>
							<label>
								Last error, if known
								<Input
									value={report.lastError}
									aria-label="Last error, if known"
									maxLength={500}
									onChange={(e) => update("lastError", e.target.value)}
								/>
							</label>
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
							{error ? <p role="alert">{error}</p> : null}
							<DialogFooter>
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
							</DialogFooter>
						</>
					) : null}
				</DialogContent>
			</Dialog>
		</>
	);
}
