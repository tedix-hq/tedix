import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "@/components/kumo/toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Checkbox } from "@/components/kumo/checkbox";
import { Textarea } from "@/components/kumo/textarea";
import { getAuthenticatedOsApi, osApi } from "@/lib/api";
import { artifactReleaseTargetQueryOptions } from "@/lib/os-query-options";
import { useStepUpAuth } from "@/lib/step-up-auth";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

export function ArtifactReleaseReview({
	tediId,
	artifactId,
}: {
	tediId: string;
	artifactId: string;
}) {
	const [open, setOpen] = useState(false);
	const [content, setContent] = useState("");
	const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
	const [targetArtifactId, setTargetArtifactId] = useState(artifactId);
	const [attestation, setAttestation] = useState("");
	const [acknowledged, setAcknowledged] = useState(false);
	const [decisionPending, setDecisionPending] = useState(false);
	const operationalContext = useOsOperationalContext();
	const descopeTenantId =
		operationalContext.data?.organization.descopeTenantId ?? null;
	const queryClient = useQueryClient();
	const options = artifactReleaseTargetQueryOptions(tediId, targetArtifactId);
	const query = useQuery({ ...options, enabled: open });
	useEffect(() => {
		setAcknowledged(false);
		setAttestation("");
	}, [
		targetArtifactId,
		query.data?.review?.reviewHeadId,
		query.data?.review?.childContentDigest,
	]);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: options.queryKey });
	const create = useMutation({
		mutationFn: () => {
			const source = query.data?.sourcePreview;
			if (!source)
				throw new Error("Reload the source preview before creating a revision");
			return osApi.cognitiveRuntime.createRedactedArtifactRevision({
				tediId,
				parentArtifactId: source.parentArtifactId,
				expectedParentDigest: source.parentContentDigest,
				content,
				idempotencyKey: draftKey,
			});
		},
		retry: false,
		onSuccess: ({ review }) => {
			setTargetArtifactId(review.childArtifactId);
			setContent("");
			setDraftKey(crypto.randomUUID());
			toast.success("Private redaction candidate created");
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Candidate creation failed",
			),
	});
	const { requireStepUp, StepUpDialog } = useStepUpAuth({
		tenantId: descopeTenantId ?? undefined,
		title: "Confirm artifact release decision",
		description:
			"Re-authenticate as the organization owner before approving or revoking these exact reviewed bytes. If authentication redirects, return and review the exact candidate again.",
		onFailure: (message) =>
			toast.error(
				`${message} Review the exact candidate again before retrying.`,
			),
	});
	const approve = (review: NonNullable<typeof query.data>["review"]) => {
		if (!review || !acknowledged || !attestation.trim()) return;
		const snapshot = {
			candidateId: review.candidateId,
			reviewHeadId: review.reviewHeadId,
			childContentDigest: review.childContentDigest,
			attestation: attestation.trim(),
		};
		requireStepUp(async (token) => {
			const current = query.data?.review;
			if (
				!current ||
				current.candidateId !== snapshot.candidateId ||
				current.reviewHeadId !== snapshot.reviewHeadId ||
				current.childContentDigest !== snapshot.childContentDigest
			) {
				toast.error("The reviewed artifact changed. Review it again.");
				return;
			}
			setDecisionPending(true);
			try {
				await getAuthenticatedOsApi(
					token,
				).cognitiveRuntime.approveArtifactRelease({
					tediId,
					candidateId: snapshot.candidateId,
					expectedReviewHeadId: snapshot.reviewHeadId,
					childContentDigest: snapshot.childContentDigest,
					acknowledgeIncompleteSourceHistory: true,
					attestation: snapshot.attestation,
				});
				await refresh();
				toast.success("Exact redacted revision approved");
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Approval failed");
			} finally {
				setDecisionPending(false);
			}
		});
	};
	const revoke = (review: NonNullable<typeof query.data>["review"]) => {
		if (!review?.recordedApprovalId || !attestation.trim()) return;
		const snapshot = {
			candidateId: review.candidateId,
			approvalId: review.recordedApprovalId,
			childContentDigest: review.childContentDigest,
			reason: attestation.trim(),
		};
		requireStepUp(async (token) => {
			setDecisionPending(true);
			try {
				await getAuthenticatedOsApi(
					token,
				).cognitiveRuntime.revokeArtifactRelease({
					tediId,
					candidateId: snapshot.candidateId,
					expectedApprovalId: snapshot.approvalId,
					childContentDigest: snapshot.childContentDigest,
					reason: snapshot.reason,
				});
				await refresh();
				toast.success("Artifact release revoked");
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Revocation failed",
				);
			} finally {
				setDecisionPending(false);
			}
		});
	};
	const copyReleaseLink = async (
		review: NonNullable<typeof query.data>["review"],
	) => {
		if (!review?.activeApprovalId) return;
		try {
			const result = await osApi.cognitiveRuntime.createArtifactShareLink({
				tediId,
				artifactId: review.childArtifactId,
			});
			await navigator.clipboard.writeText(result.url);
			toast.success("Approved release link copied");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Could not create release link",
			);
		}
	};
	if (!open)
		return (
			<Button size="xs" variant="outline" onClick={() => setOpen(true)}>
				Review private artifact
			</Button>
		);
	return (
		<Card size="sm" className="mt-2">
			<CardHeader>
				<CardTitle>Owner-reviewed redacted release</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				{query.isLoading ? <p>Loading bounded inert preview…</p> : null}
				{query.error ? (
					<Alert variant="destructive">
						<AlertTitle>Preview unavailable</AlertTitle>
						<AlertDescription>
							The private artifact could not be verified for review.
						</AlertDescription>
					</Alert>
				) : null}
				{open && !descopeTenantId ? (
					<Alert variant="destructive">
						<AlertTitle>Owner verification unavailable</AlertTitle>
						<AlertDescription>
							The organization authentication tenant could not be resolved.
							Release decisions remain disabled.
						</AlertDescription>
					</Alert>
				) : null}
				{query.data?.sourcePreview ? (
					<>
						<Alert>
							<AlertTitle>Incomplete source history</AlertTitle>
							<AlertDescription>
								{query.data.sourcePreview.sourceNotice}
							</AlertDescription>
						</Alert>
						<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-kumo-line p-3 text-sm">
							<strong>Original — always private</strong>
							{"\n"}
							<small>{query.data.sourcePreview.parentContentDigest}</small>
							{"\n\n"}
							{query.data.sourcePreview.parentPreview.text}
						</pre>
						<Textarea
							aria-label="Redacted candidate text"
							value={content}
							onChange={(event) => {
								setContent(event.target.value);
								setDraftKey(crypto.randomUUID());
							}}
						/>
						<Button
							disabled={!content || create.isPending}
							onClick={() => create.mutate()}
						>
							Create private candidate
						</Button>
					</>
				) : null}
				{query.data?.review ? (
					<>
						<div className="flex gap-2">
							<Badge variant="warning">Observed prefix only</Badge>
							{query.data.review.releaseActive ? (
								<Badge variant="success">Approved</Badge>
							) : (
								<Badge variant="secondary">Private</Badge>
							)}
						</div>
						<Alert>
							<AlertTitle>Review does not prove complete provenance</AlertTitle>
							<AlertDescription>
								{query.data.review.sourceNotice}
							</AlertDescription>
						</Alert>
						{query.data.review.reviewability === "unavailable" ? (
							<Alert variant="destructive">
								<AlertTitle>Preview unavailable</AlertTitle>
								<AlertDescription>
									Approval is disabled, but a recorded approval can still be
									revoked.
								</AlertDescription>
							</Alert>
						) : null}
						<div className="grid gap-3 md:grid-cols-2">
							<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-kumo-line p-3 text-sm">
								<strong>Original — always private</strong>
								{"\n"}
								<small>{query.data.review.parentContentDigest}</small>
								{"\n\n"}
								{query.data.review.parentPreview?.text ??
									"Private original preview unavailable."}
							</pre>
							<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-kumo-line p-3 text-sm">
								<strong>Redacted copy</strong>
								{"\n"}
								<small>{query.data.review.childContentDigest}</small>
								{"\n\n"}
								{query.data.review.candidatePreview?.text ??
									"Redacted candidate preview unavailable."}
							</pre>
						</div>
						<Textarea
							aria-label="Owner attestation or revocation reason"
							value={attestation}
							onChange={(event) => setAttestation(event.target.value)}
						/>
						<label className="flex items-center gap-2">
							<Checkbox
								checked={acknowledged}
								onCheckedChange={(value) => setAcknowledged(value === true)}
							/>
							I understand earlier or indirect source history may be missing.
						</label>
						<div className="flex gap-2">
							{query.data.review.recordedApprovalId ? (
								<Button
									variant="destructive"
									disabled={
										!descopeTenantId || !attestation.trim() || decisionPending
									}
									onClick={() => revoke(query.data!.review)}
								>
									Revoke
								</Button>
							) : (
								<Button
									disabled={
										!descopeTenantId ||
										query.data.review.reviewability !== "reviewable" ||
										!acknowledged ||
										!attestation.trim() ||
										decisionPending
									}
									onClick={() => approve(query.data!.review)}
								>
									Approve exact revision
								</Button>
							)}
							{query.data.review.activeApprovalId ? (
								<Button
									variant="outline"
									disabled={decisionPending}
									onClick={() => void copyReleaseLink(query.data!.review)}
								>
									Copy approved link
								</Button>
							) : null}
							<Button variant="ghost" onClick={() => setOpen(false)}>
								Close
							</Button>
						</div>
					</>
				) : null}
			</CardContent>
			<StepUpDialog />
		</Card>
	);
}
