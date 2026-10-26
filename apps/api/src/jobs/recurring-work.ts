/**
 * Recurring Work: each project template in `metadata.recurringWork` files one
 * Work Item per month (e.g. "Bewirtungsbelege November 2026").
 *
 * The item's sourceIntentId is `recurring:<projectId>:<key>:<YYYY-MM>`, which
 * the org-scoped unique index makes the idempotency key: a repeated or
 * overlapping tick finds the existing item and files nothing. Items are filed
 * as proposed; accepting them stays with the people and tedis who own them.
 */

import {
	ProjectMetadataSchema,
	type RecurringWorkTemplate,
} from "@tedix/api-contract/schemas/work-attention";
import type { DbClient } from "@tedix/db/client";
import { listProjectsWithRecurringWork } from "@tedix/db/queries/projects";
import {
	createWorkItem,
	getWorkItemBySourceIntentId,
} from "@tedix/db/queries/work-items/crud";
import { resolveWorkItemPurpose } from "@tedix/db/queries/work-items/purpose";
import { safeExceptionTopology } from "../lib/safe-log-metadata";

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** The month a template is due for at `now`, or null before its day. */
export function recurringWorkPeriod(
	now: Date,
	dayOfMonth: number,
): { key: string; label: string; endsAt: string } | null {
	if (now.getUTCDate() < dayOfMonth) return null;
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	return {
		key: `${year}-${String(month + 1).padStart(2, "0")}`,
		label: `${MONTHS[month]} ${year}`,
		endsAt: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
	};
}

export function recurringWorkIntentId(
	projectId: string,
	templateKey: string,
	periodKey: string,
): string {
	return `recurring:${projectId}:${templateKey}:${periodKey}`;
}

function itemDescription(template: RecurringWorkTemplate): string | undefined {
	const parts = [
		template.description?.trim(),
		template.doneWhen?.trim() ? `Done when: ${template.doneWhen.trim()}` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export async function fileRecurringWork(
	db: DbClient,
	now: Date,
): Promise<{ filed: number; existing: number; failed: number }> {
	const counts = { filed: 0, existing: 0, failed: 0 };
	for (const project of await listProjectsWithRecurringWork(db)) {
		const metadata = ProjectMetadataSchema.safeParse(project.metadata ?? {});
		if (!metadata.success) {
			counts.failed += 1;
			console.warn("[recurring-work] project metadata is invalid", {
				projectId: project.id,
			});
			continue;
		}
		for (const template of metadata.data.recurringWork ?? []) {
			if (!template.enabled) continue;
			const period = recurringWorkPeriod(now, template.dayOfMonth);
			if (!period) continue;
			const sourceIntentId = recurringWorkIntentId(
				project.id,
				template.key,
				period.key,
			);
			try {
				if (
					await getWorkItemBySourceIntentId(db, {
						orgId: project.orgId,
						sourceIntentId,
					})
				) {
					counts.existing += 1;
					continue;
				}
				// A project objective wins; otherwise the item is maintenance that
				// expires with its month.
				const purpose = await resolveWorkItemPurpose(db, {
					orgId: project.orgId,
					now: now.toISOString(),
					workClass: "maintenance",
					purposeExceptionExpiresAt: period.endsAt,
					project: { key: project.key, objectiveId: project.objectiveId },
				});
				await createWorkItem(db, {
					id: crypto.randomUUID(),
					orgId: project.orgId,
					createdBy: { type: "system", id: "recurring-work" },
					title: template.title.replaceAll("{month}", period.label),
					description: itemDescription(template),
					...(template.workKind ? { workKind: template.workKind } : {}),
					...(template.priority ? { priority: template.priority } : {}),
					...(template.owner
						? {
								accountableOwnerType: template.owner.type,
								accountableOwnerId: template.owner.id,
							}
						: {}),
					objectiveId: purpose.objectiveId ?? undefined,
					workClass: purpose.workClass,
					purposeExceptionExpiresAt:
						purpose.purposeExceptionExpiresAt ?? undefined,
					projectId: project.id,
					sourceIntentId,
					metadata: {
						recurringWork: { templateKey: template.key, period: period.key },
					},
					createdAt: now.toISOString(),
				});
				counts.filed += 1;
			} catch (error) {
				counts.failed += 1;
				console.warn("[recurring-work] could not file the item", {
					projectId: project.id,
					templateKey: template.key,
					period: period.key,
					exception: safeExceptionTopology(error),
				});
			}
		}
	}
	return counts;
}
