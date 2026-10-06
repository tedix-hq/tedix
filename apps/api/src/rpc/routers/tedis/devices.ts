/**
 * Tedis Router — Device management
 */

import {
	approveDevice,
	getDeviceById,
	getDevicesByTedi,
	revokeDevice,
} from "@tedix/db/queries/tedis";
import { approveRuntimeDevice, getRuntimeDevices } from "@tedix/provisioning";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	getProvisioningConfig,
	requireTediAccess,
} from "./helpers";

// =============================================================================
// DEVICE MANAGEMENT
// =============================================================================

export const listDevices = authedTedisOs.listDevices
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		const provConfig = getProvisioningConfig(tedi, context.env);
		if (provConfig) {
			try {
				const runtimeDevices = await getRuntimeDevices(provConfig);
				const normalize = (
					device: (typeof runtimeDevices.pending)[number],
				) => ({
					id: device.id,
					tediId: device.tediId ?? null,
					deviceId: device.deviceId ?? device.id,
					displayName: device.displayName ?? null,
					platform: device.platform ?? null,
					channel: device.channel ?? null,
					status: device.status,
					pairedAt: device.pairedAt ?? null,
					createdAt: device.createdAt ?? null,
				});
				return {
					pending: runtimeDevices.pending.map(normalize),
					paired: runtimeDevices.paired.map(normalize),
				};
			} catch (error) {
				console.warn(
					`[Tedis] Failed to fetch runtime devices for ${tedi.id}:`,
					error,
				);
			}
		}

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
		const tedi = await requireTediAccess(context, input.tediId);

		const provConfig = getProvisioningConfig(tedi, context.env);
		let runtimeAttempted = false;
		if (provConfig) {
			runtimeAttempted = true;
			try {
				const runtimeResult = await approveRuntimeDevice(
					provConfig,
					input.deviceId,
				);
				if (runtimeResult.success) {
					return {
						success: true,
						message:
							runtimeResult.message ??
							`Device request "${input.deviceId}" approved`,
					};
				}
				throw createError(
					ErrorCodes.BAD_REQUEST,
					runtimeResult.message ??
						`Runtime rejected device approval for "${input.deviceId}"`,
				);
			} catch (error) {
				if (error && typeof error === "object" && "code" in error) {
					throw error;
				}
				console.warn(
					`[Tedis] Runtime device approval failed for ${input.deviceId}:`,
					error,
				);
			}
		}

		if (runtimeAttempted) {
			throw createError(
				ErrorCodes.BAD_GATEWAY,
				"Runtime device approval unavailable",
			);
		}

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
