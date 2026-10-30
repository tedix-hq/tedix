import type { ApprovalRequest } from "@tedix/api-contract/contracts/tedi-approvals";
import type { ApprovalEditableField } from "@tedix/api-contract/schemas/approval-edits";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	applyApprovalEdits,
	approvalEditableFieldKind,
	approvalPayloadEditableFields,
} from "@tedix/api-contract/utils/approval-edits";
import { useQueryClient } from "@tanstack/react-query";
import { useContext, useId, useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { toast } from "@/components/kumo/toast";
import { osApi } from "@/lib/api";
import { OptimisticDeckDecisionContext } from "@/lib/optimistic-deck-decision";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";

type FormValue = string | boolean;

function formValue(value: unknown): FormValue {
	if (typeof value === "boolean") return value;
	if (value === undefined || value === null) return "";
	return typeof value === "string" ? value : String(value);
}

function enumOptions(field: ApprovalEditableField): string[] {
	return Array.isArray(field.schema.enum)
		? field.schema.enum.map((option) => String(option))
		: [];
}

/** Convert form text back to the JSON type the tool schema expects. */
export function approvalEditValue(
	field: ApprovalEditableField,
	value: FormValue,
): JsonValue {
	const kind = approvalEditableFieldKind(field);
	if (kind === "boolean") return value === true;
	const text = String(value).trim() === "" ? "" : String(value);
	if (text === "") return null;
	if (kind === "number" || kind === "integer") {
		const number = Number(text);
		return Number.isFinite(number) ? number : text;
	}
	if (kind === "choice") {
		const original = (field.schema.enum as JsonValue[]).find(
			(option) => String(option) === text,
		);
		return original ?? text;
	}
	return text;
}

/**
 * "Change before approving" form for an approval that declares editable
 * fields. It sends the changed values with the approval; the server checks
 * them against the tool schema and records what changed.
 */
export function ApprovalFieldEdits({
	approval,
	active,
}: {
	approval: Pick<ApprovalRequest, "id" | "payload">;
	active: boolean;
}) {
	const fields = approvalPayloadEditableFields(approval.payload);
	const args = (approval.payload.args ?? {}) as Record<string, unknown>;
	const client = useQueryClient();
	const optimistic = useContext(OptimisticDeckDecisionContext);
	const formId = useId();
	const [values, setValues] = useState<Record<string, FormValue>>(() =>
		Object.fromEntries(
			fields.map((field) => [field.name, formValue(args[field.name])]),
		),
	);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	if (!active || fields.length === 0) return null;

	const edits: Record<string, JsonValue> = {};
	for (const field of fields) {
		const value = values[field.name] ?? "";
		if (value === formValue(args[field.name])) continue;
		edits[field.name] = approvalEditValue(field, value);
	}
	const changed = Object.keys(edits);

	const submit = async () => {
		const checked = applyApprovalEdits({ fields, args, edits });
		if (!checked.ok) {
			setError(checked.error);
			return;
		}
		setError("");
		setSaving(true);
		const write = () =>
			osApi.tediApprovals.resolve({
				id: approval.id,
				status: "approved",
				edits,
				resolution: `Approved with changes to ${checked.changes
					.map(
						(change) =>
							fields.find((field) => field.name === change.field)?.label ??
							change.field,
					)
					.join(", ")}`,
			});
		try {
			await (optimistic ? optimistic(write) : write());
			toast.success("Approved with your changes");
			if (!optimistic)
				await Promise.all([
					client.invalidateQueries({ queryKey: osQueryKeys.approvals() }),
					client.invalidateQueries({
						queryKey: osQuery.learningFeedback.key(),
					}),
				]);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Your changes could not be saved. Try again.",
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Collapsible data-approval-field-edits>
			<CollapsibleDefaultTrigger className="group/disclosure">
				Change before approving
			</CollapsibleDefaultTrigger>
			<CollapsibleDefaultContent>
				<form
					className="grid gap-4 pt-2"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					{fields.map((field) => {
						const id = `${formId}-${field.name}`;
						const kind = approvalEditableFieldKind(field);
						const value = values[field.name] ?? "";
						const set = (next: FormValue) =>
							setValues((current) => ({ ...current, [field.name]: next }));
						const label = (
							<Label htmlFor={id}>
								{field.label}
								{field.required ? "" : " (optional)"}
							</Label>
						);
						return (
							<div key={field.name} className="grid gap-1.5">
								{kind === "boolean" ? (
									<div className="flex items-center justify-between gap-3">
										{label}
										<Switch
											id={id}
											aria-label={field.label}
											checked={value === true}
											disabled={saving}
											onCheckedChange={(checked) => set(checked)}
										/>
									</div>
								) : (
									label
								)}
								{kind === "choice" ? (
									<Select
										value={String(value)}
										onValueChange={(next) => set(String(next ?? ""))}
										disabled={saving}
									>
										<SelectTrigger id={id} aria-label={field.label}>
											<SelectValue placeholder="Choose" />
										</SelectTrigger>
										<SelectContent>
											{enumOptions(field).map((option) => (
												<SelectItem key={option} value={option}>
													{option}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								) : kind === "long_text" ? (
									<Textarea
										id={id}
										rows={4}
										value={String(value)}
										disabled={saving}
										onChange={(event) => set(event.target.value)}
									/>
								) : kind !== "boolean" ? (
									<Input
										id={id}
										inputMode={
											kind === "number" || kind === "integer"
												? "decimal"
												: undefined
										}
										value={String(value)}
										disabled={saving}
										onChange={(event) => set(event.target.value)}
									/>
								) : null}
								{field.description ? (
									<Text role="caption" tone="secondary">
										{field.description}
									</Text>
								) : null}
							</div>
						);
					})}
					{error ? (
						<Text role="body" tone="error">
							{error}
						</Text>
					) : null}
					<Button
						type="submit"
						className="min-h-11 w-full sm:w-auto sm:justify-self-start"
						disabled={saving || changed.length === 0}
					>
						{saving ? "Approving…" : "Approve with changes"}
					</Button>
				</form>
			</CollapsibleDefaultContent>
		</Collapsible>
	);
}
