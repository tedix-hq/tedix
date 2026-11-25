import {
	measureStorage,
	readRetentionConfig,
	runRetention,
	tedixConfigDir,
	type RetentionReport,
} from "./lane-retention";
import { supervisorLog } from "./supervise-drivers";

/**
 * `tedix storage`: what `~/.tedix` uses on disk, measured as real allocated
 * blocks (APFS clone families counted once, unlike `du`), and `tedix storage
 * clean` runs the retention pass now — compaction, expiry, log rotation —
 * reporting the bytes it reclaimed. The supervisor runs the same pass at
 * start and hourly; every threshold lives in `~/.tedix/retention.json`.
 */

export const storageUsage = `Show what Tedix uses on disk, or reclaim it now

  tedix storage              Disk use by area under ~/.tedix
  tedix storage clean        Run compaction, expiry and log rotation now
  tedix storage clean --dry-run   Report what clean would reclaim, change nothing

Disk use is measured as real allocated blocks: APFS clones that bun's install
shares between checkouts count once, so the total is what deleting the files
would actually return to the disk. --json prints the same data as JSON.

Automatic cleanup runs at supervisor start and hourly: regenerable folders
(node_modules, dist, build, …) leave a settled run's worktree an hour after it
settles; a settled run folder expires after 3 days and any idle run folder
after 7, with unpushed commits kept as a restore point for 90 days; logs
rotate at 10 MB keeping 10 files and archives expire after 14 days. A live
Attempt or a live process always keeps its folder.

Thresholds: ~/.tedix/retention.json — compactAfterHours, expireAfterDays,
idleDays, restoreKeepDays, logMaxMB, logKeepFiles, archiveDays.`;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function reportLines(report: RetentionReport): string[] {
	const lines = [
		`compacted ${report.compactedDirs} regenerable folder${report.compactedDirs === 1 ? "" : "s"} (${formatBytes(report.compactedBytes)})`,
		`expired ${report.expiredRuns} run folder${report.expiredRuns === 1 ? "" : "s"} (${formatBytes(report.expiredBytes)})`,
		`kept ${report.restorePoints} restore point${report.restorePoints === 1 ? "" : "s"} for unpushed work`,
		`rotated ${report.rotatedFiles} log${report.rotatedFiles === 1 ? "" : "s"} (${formatBytes(report.rotatedBytes)} freed)`,
		`deleted ${report.archivesDeleted} archive${report.archivesDeleted === 1 ? "" : "s"} older than the window (${formatBytes(report.archivesBytes)})`,
		`pruned ${report.restorePointsPruned} expired restore point${report.restorePointsPruned === 1 ? "" : "s"}`,
	];
	for (const run of report.protectedRuns) lines.push(`kept ${run}`);
	for (const error of report.errors) lines.push(`error: ${error}`);
	return lines;
}

function reclaimedBytes(report: RetentionReport): number {
	return (
		report.compactedBytes +
		report.expiredBytes +
		report.rotatedBytes +
		report.archivesBytes
	);
}

export async function runStorageCommand(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(storageUsage);
		return 0;
	}
	const json = args.includes("--json");
	const positional = args.filter(
		(arg, index) =>
			!arg.startsWith("-") &&
			args[index - 1] !== "--workspace" &&
			args[index - 1] !== "--organization",
	);
	const clean = positional[0] === "clean";
	if (
		(positional[0] && positional[0] !== "clean") ||
		(clean && positional.length > 1)
	) {
		console.error(
			`Unknown storage argument "${positional.find((arg) => arg !== "clean") ?? positional[0]}". Run tedix storage --help.`,
		);
		return 1;
	}
	const dryRun = args.includes("--dry-run");
	const env = { ...process.env };
	const configDir = tedixConfigDir(env);
	if (clean) {
		const report = await runRetention({ env, configDir, apply: !dryRun });
		if (json) {
			console.log(
				JSON.stringify(
					{
						...report,
						dryRun,
						reclaimedBytes: reclaimedBytes(report),
					},
					null,
					2,
				),
			);
		} else {
			for (const line of reportLines(report)) console.log(line);
			console.log(
				`${dryRun ? "would reclaim" : "reclaimed"} ${formatBytes(reclaimedBytes(report))}`,
			);
		}
		return report.errors.length ? 1 : 0;
	}
	const { areas, total } = measureStorage(configDir);
	const config = readRetentionConfig(env, configDir);
	if (json) {
		console.log(
			JSON.stringify(
				{
					root: configDir,
					total,
					areas,
					retention: config,
				},
				null,
				2,
			),
		);
		return 0;
	}
	console.log(`Tedix storage under ${configDir}`);
	console.log("  measured as allocated blocks; APFS clones count once");
	for (const area of areas)
		console.log(
			`  ${formatBytes(area.bytes).padStart(10)}  ${area.name}  (${area.files} files, ${area.dirs} dirs)`,
		);
	console.log(`  ${formatBytes(total.bytes).padStart(10)}  total`);
	console.log("clean now: tedix storage clean");
	return 0;
}

/** The supervisor's hourly pass; logs one line only when it reclaimed. */
export async function runRetentionQuietly(
	env: NodeJS.ProcessEnv,
): Promise<void> {
	try {
		const report = await runRetention({ env });
		const reclaimed = reclaimedBytes(report);
		if (reclaimed || report.errors.length)
			supervisorLog(
				env,
				`storage: reclaimed ${formatBytes(reclaimed)}; ${report.compactedDirs} compacted, ${report.expiredRuns} expired, ${report.rotatedFiles} logs rotated${report.errors.length ? `; ${report.errors.length} errors` : ""}`,
			);
	} catch (error) {
		supervisorLog(
			env,
			`storage: retention pass failed: ${(error as Error).message?.slice(0, 200)}`,
		);
	}
}
