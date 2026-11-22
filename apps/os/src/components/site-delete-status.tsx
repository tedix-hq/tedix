import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Alert,
	AlertTitle,
	AlertDescription,
	LoadError,
} from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SectionDescription,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { sentenceCase } from "@/lib/format";
import {
	sitesQueryOptions,
	sitesReconciliationQueryOptions,
	siteDeprovisionPlanQueryOptions,
	siteDeprovisionStatusQueryOptions,
} from "@/lib/os-query-options";
const DISABLED_SITE_QUERY_ID = "00000000-0000-4000-8000-000000000000";
export type DeprovisionReceipt = {
	operationId: string;
	siteId: string;
	slug: string;
	name: string;
	status: "checking" | "queued" | "running" | "succeeded" | "failed";
	stage: string;
	deleted: string[];
	errors: string[];
};

const DEPROVISION_RECEIPT_KEY = "tedix:sites:last-deprovision";

export function readDeprovisionReceipt(): DeprovisionReceipt | null {
	try {
		const value: unknown = JSON.parse(
			window.sessionStorage.getItem(DEPROVISION_RECEIPT_KEY) ?? "null",
		);
		if (!value || typeof value !== "object") return null;
		const receipt = value as Partial<DeprovisionReceipt>;
		if (
			typeof receipt.siteId !== "string" ||
			typeof receipt.slug !== "string" ||
			typeof receipt.name !== "string" ||
			typeof receipt.operationId !== "string" ||
			!["checking", "queued", "running", "succeeded", "failed"].includes(
				receipt.status ?? "",
			) ||
			!Array.isArray(receipt.deleted) ||
			typeof receipt.stage !== "string" ||
			!Array.isArray(receipt.errors)
		)
			return null;
		return receipt as DeprovisionReceipt;
	} catch {
		return null;
	}
}

export function storeDeprovisionReceipt(receipt: DeprovisionReceipt | null) {
	try {
		if (receipt) {
			window.sessionStorage.setItem(
				DEPROVISION_RECEIPT_KEY,
				JSON.stringify(receipt),
			);
		} else {
			window.sessionStorage.removeItem(DEPROVISION_RECEIPT_KEY);
		}
	} catch {
		// Browser storage is optional; the current page can still poll the receipt.
	}
}

export function SiteDeleteStatus() {
	const queryClient = useQueryClient();
	const [lastDeprovision, setLastDeprovision] = useState(
		readDeprovisionReceipt,
	);
	const deprovisionStatus = useQuery({
		...siteDeprovisionStatusQueryOptions(
			lastDeprovision?.siteId ?? DISABLED_SITE_QUERY_ID,
		),
		enabled: lastDeprovision !== null,
		refetchInterval: (query) => {
			const current = query.state.data;
			return !current ||
				current.operationId !== lastDeprovision?.operationId ||
				["queued", "running"].includes(current.status)
				? 3_000
				: false;
		},
	});
	const receipt =
		lastDeprovision &&
		deprovisionStatus.data &&
		(!lastDeprovision.operationId ||
			deprovisionStatus.data.operationId === lastDeprovision.operationId)
			? { ...deprovisionStatus.data, name: lastDeprovision.name }
			: lastDeprovision;
	useEffect(() => {
		if (
			!lastDeprovision ||
			lastDeprovision.operationId ||
			!deprovisionStatus.data
		)
			return;
		const resolved = { ...deprovisionStatus.data, name: lastDeprovision.name };
		storeDeprovisionReceipt(resolved);
		setLastDeprovision(resolved);
	}, [lastDeprovision, deprovisionStatus.data]);
	const lastTerminalReceipt = useRef("");
	useEffect(() => {
		if (!receipt || !["succeeded", "failed"].includes(receipt.status)) return;
		const terminalKey = `${receipt.operationId}:${receipt.status}`;
		if (lastTerminalReceipt.current === terminalKey) return;
		lastTerminalReceipt.current = terminalKey;
		storeDeprovisionReceipt(receipt);
		void queryClient.invalidateQueries(sitesQueryOptions());
		void queryClient.invalidateQueries(sitesReconciliationQueryOptions());
		if (receipt.status === "failed") {
			void queryClient.invalidateQueries(
				siteDeprovisionPlanQueryOptions(receipt.siteId),
			);
		}
	}, [receipt, queryClient]);
	return (
		<>
			{" "}
			{receipt ? (
				<PageSection>
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>Cleanup — {receipt.name}</SectionTitle>
							<SectionDescription>
								{receipt.operationId
									? `Operation ${receipt.operationId}. This receipt remains available after the site record is removed.`
									: "Checking whether the cleanup request started. This status remains available after a reload."}
							</SectionDescription>
						</SectionHeading>
						<Badge
							variant={
								receipt.status === "failed"
									? "destructive"
									: receipt.status === "succeeded"
										? "outline"
										: "warning"
							}
						>
							{sentenceCase(receipt.status)}
						</Badge>
						{receipt.status === "succeeded" || receipt.status === "failed" ? (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									storeDeprovisionReceipt(null);
									setLastDeprovision(null);
								}}
							>
								Dismiss
							</Button>
						) : null}
					</SectionHeader>
					{deprovisionStatus.isError ? (
						<LoadError
							title="Cleanup status is unavailable"
							error={deprovisionStatus.error}
							onRetry={() => {
								void deprovisionStatus.refetch();
							}}
							retrying={deprovisionStatus.isFetching}
						/>
					) : null}
					{receipt.status === "checking" ? (
						<Text as="p" role="body" tone="secondary">
							The request did not return a receipt. Checking the server before
							another attempt.
						</Text>
					) : null}
					{receipt.status === "queued" || receipt.status === "running" ? (
						<Text as="p" role="body" tone="secondary">
							{receipt.stage}. This page checks for the final result
							automatically.
						</Text>
					) : null}
					{receipt.status === "succeeded" ? (
						<Text as="p" role="body">
							{receipt.slug} was deleted. {receipt.deleted.length} resource(s)
							removed.
						</Text>
					) : null}
					{receipt.status === "failed" ? (
						<Alert variant="destructive">
							<AlertTitle>Cleanup needs attention</AlertTitle>
							<AlertDescription>
								{receipt.errors.join("; ") || "No failure detail was returned."}
							</AlertDescription>
						</Alert>
					) : null}
					{receipt.deleted.length ? (
						<Text as="p" role="caption" tone="secondary">
							Removed: {receipt.deleted.join(", ")}
						</Text>
					) : null}
				</PageSection>
			) : null}
		</>
	);
}
