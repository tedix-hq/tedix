import { useQueries } from "@tanstack/react-query";
import type {
	DriveSaveProvider,
	SaveExportToDriveInput,
} from "@tedix/api-contract/schemas/connections";
import { Link } from "@/components/kumo/link";
import { toast } from "@/components/kumo/toast";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";

/** One of the person's own connected drives an export can be saved to. */
export type DriveSaveTarget = {
	provider: DriveSaveProvider;
	connectionInstanceId: string;
	label: string;
};

export type DriveExportFile = Pick<
	SaveExportToDriveInput,
	"fileName" | "mimeType" | "content"
>;

const DRIVE_NAMES: Record<DriveSaveProvider, string> = {
	"google-drive": "Google Drive",
};

/**
 * The person's own connected drives, at most one per provider: the default
 * account when they have several. Organization accounts are never offered.
 */
export function useDriveSaveTargets(): DriveSaveTarget[] {
	const providers = Object.keys(DRIVE_NAMES) as DriveSaveProvider[];
	return useQueries({
		queries: providers.map((provider) => ({
			...osQuery.connections.getConnectionsOverview.queryOptions({
				input: {
					scope: "personal",
					providerId: provider,
					status: "all",
					q: "",
					limit: 20,
					offset: 0,
				},
			}),
			staleTime: 5 * 60_000,
		})),
		combine: (results) =>
			results.flatMap((result, index): DriveSaveTarget[] => {
				const provider = providers[index]!;
				const accounts = (result.data?.rows ?? []).filter(
					(row) =>
						row.provider.appId === provider &&
						row.scope === "user" &&
						row.accountState === "present" &&
						row.connectionInstanceId,
				);
				const account = accounts.find((row) => row.isDefault) ?? accounts[0];
				return account?.connectionInstanceId
					? [
							{
								provider,
								connectionInstanceId: account.connectionInstanceId,
								label: `Save to ${DRIVE_NAMES[provider]}`,
							},
						]
					: [];
			}),
	});
}

/** Read a downloaded file as base64 for the save request. */
export async function blobToBase64(blob: Blob): Promise<string> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
	return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/** Save one exported file to the person's drive and show where it went, or why it did not. */
export async function saveExportToDrive(
	target: DriveSaveTarget,
	file: DriveExportFile,
): Promise<void> {
	const driveName = DRIVE_NAMES[target.provider];
	try {
		const saved = await osApi.connections.saveExportToDrive({
			provider: target.provider,
			connectionInstanceId: target.connectionInstanceId,
			...file,
		});
		toast.success(`Saved to ${driveName}`, {
			description: (
				<Link href={saved.url} target="_blank" rel="noreferrer noopener">
					Open {saved.name}
				</Link>
			),
		});
	} catch (error) {
		toast.error(`Could not save to ${driveName}`, {
			description: error instanceof Error ? error.message : undefined,
		});
	}
}
