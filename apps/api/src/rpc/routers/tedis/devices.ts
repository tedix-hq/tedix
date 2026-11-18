/**
 * Tedis Router — Device management
 */

import {
	approveDevice,
	getDeviceById,
	getDevicesByTedi,
	revokeDevice,
} from "@tedix/db/queries/tedis";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	requireTediAccess,
} from "./helpers";

// =============================================================================
// DEVICE MANAGEMENT
// =============================================================================

export const listDevices = authedTedisOs.listDevices
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);

		const projectedDevices = await getDevicesByTedi(context.db, input.tediId);
		const mapProjected = (d: (typeof projectedDevices.pending)[number]) => ({
			id: d.id,
			tediId: d.tediId,
			deviceId: d.deviceId,
			displayName: d.displayName,
			platform: d.platform,
			channel: d.channel,
			status: (d.status ?? "pending") as "pending" | "paired" | "revoked",
			pairedAt: d.pairedAt,
			createdAt: d.createdAt,
		});

		return {
			pending: projectedDevices.pending.map(mapProjected),
			paired: projectedDevices.paired.map(mapProjected),
		};
	});

export const approveDeviceProcedure = authedTedisOs.approveDevice
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);

		const existingDevice = await getDeviceById(context.db, input.deviceId);
		if (!existingDevice || existingDevice.tediId !== input.tediId) {
			throw createError(ErrorCodes.NOT_FOUND, "Device not found for this tedi");
		}

		const device = await approveDevice(context.db, input.deviceId);

		if (!device) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Device not found or not in pending status",
			);
		}

		console.log(
			`[Tedis] Approved device: ${device.displayName ?? device.deviceId}`,
		);

		return {
			success: true,
			message: `Device "${device.displayName ?? device.deviceId}" approved`,
		};
	});

export const revokeDeviceProcedure = authedTedisOs.revokeDevice
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);

		const existingDevice = await getDeviceById(context.db, input.deviceId);
		if (!existingDevice || existingDevice.tediId !== input.tediId) {
			throw createError(ErrorCodes.NOT_FOUND, "Device not found for this tedi");
		}

		await revokeDevice(context.db, input.deviceId);

		console.log(`[Tedis] Revoked device: ${input.deviceId}`);

		return {
			success: true as const,
			message: "Device revoked",
		};
	});
