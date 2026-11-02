import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { readdirSync, readFileSync, realpathSync } from "node:fs";

/**
 * Kernel process facts without `ps`/`lsof` subprocesses: /proc on Linux,
 * libSystem proc_pidinfo/sysctl on macOS. Returns undefined for a process or
 * field the platform cannot report (denied sysctl, missing proc entry); the
 * caller decides whether to fall back to spawning.
 */
export interface KernelProcessFacts {
	pid: number;
	ppid: number;
	pgid: number;
	/** Opaque per-instance start tokens (sec/usec or boot ticks). */
	start: string[];
	comm: string;
	argv: string[];
	cwd?: string;
}

export interface KernelProcessRow {
	pid: number;
	ppid: number;
	comm: string;
	args: string;
}

function cstr(buf: Uint8Array, offset: number, limit: number): string {
	let end = offset;
	while (end < limit && buf[end] !== 0) end++;
	return new TextDecoder().decode(buf.subarray(offset, end));
}

/* Linux: /proc */

function linuxStatFields(pid: number) {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const close = stat.lastIndexOf(")");
	if (close < 0) return;
	const comm = stat.slice(stat.indexOf("(") + 1, close);
	return {
		comm,
		fields: stat
			.slice(close + 2)
			.trim()
			.split(/\s+/),
	};
}

function linuxFacts(pid: number): KernelProcessFacts | undefined {
	try {
		const stat = linuxStatFields(pid);
		if (!stat) return;
		const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
			.split("\0")
			.filter(Boolean);
		return {
			pid,
			ppid: Number(stat.fields[1]),
			pgid: Number(stat.fields[2]),
			start: [stat.fields[19]!],
			comm: stat.comm,
			argv,
			cwd: linuxCwd(pid),
		};
	} catch {
		return;
	}
}

function linuxTable(): KernelProcessRow[] | undefined {
	try {
		return readdirSync("/proc").flatMap((name) => {
			const pid = Number(name);
			if (!Number.isInteger(pid) || pid <= 0) return [];
			try {
				const stat = linuxStatFields(pid);
				if (!stat) return [];
				let args = "";
				try {
					args = readFileSync(`/proc/${pid}/cmdline`, "utf8")
						.split("\0")
						.filter(Boolean)
						.join(" ");
				} catch {}
				return [{ pid, ppid: Number(stat.fields[1]), comm: stat.comm, args }];
			} catch {
				return [];
			}
		});
	} catch {
		return;
	}
}

function linuxCwd(pid: number): string | undefined {
	try {
		return realpathSync(`/proc/${pid}/cwd`);
	} catch {
		return;
	}
}

/* macOS: libSystem proc_pidinfo / sysctl via FFI */

const PROC_ALL_PIDS = 1;
const PROC_PIDTBSDINFO = 3;
const PROC_PIDVNODEPATHINFO = 9;
const PROC_PIDT_SHORTBSDINFO = 13;
const PROC_PIDUNIQIDENTIFIERINFO = 17;
const CTL_KERN = 1;
const KERN_PROCARGS2 = 69;

interface DarwinSymbols {
	proc_listpids(
		type: number,
		typeinfo: number,
		buffer: number,
		buffersize: number,
	): number;
	proc_pidinfo(
		pid: number,
		flavor: number,
		arg: bigint,
		buffer: number,
		buffersize: number,
	): number;
	sysctl(
		name: number,
		namelen: number,
		oldp: number | null,
		oldlenp: number,
		newp: number | null,
		newlen: bigint,
	): number;
	__error(): number;
}

let darwinSymbols: DarwinSymbols | null | undefined;

function darwinLib(): DarwinSymbols | undefined {
	if (process.platform !== "darwin") return;
	if (darwinSymbols === undefined) {
		try {
			darwinSymbols = dlopen("libSystem.B.dylib", {
				proc_listpids: {
					args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32],
					returns: FFIType.i32,
				},
				proc_pidinfo: {
					args: [
						FFIType.i32,
						FFIType.i32,
						FFIType.u64,
						FFIType.ptr,
						FFIType.i32,
					],
					returns: FFIType.i32,
				},
				sysctl: {
					args: [
						FFIType.ptr,
						FFIType.u32,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.u64,
					],
					returns: FFIType.i32,
				},
				__error: { args: [], returns: FFIType.ptr },
			}).symbols as unknown as DarwinSymbols;
		} catch {
			darwinSymbols = null;
		}
	}
	return darwinSymbols ?? undefined;
}

function darwinPidInfo(pid: number, flavor: number, size: number) {
	const lib = darwinLib();
	if (!lib) return;
	const buf = new Uint8Array(size);
	const n = lib.proc_pidinfo(pid, flavor, 0n, ptr(buf), buf.length);
	return n > 0 ? { buf, n } : undefined;
}

function darwinShortInfo(pid: number) {
	const row = darwinPidInfo(pid, PROC_PIDT_SHORTBSDINFO, 128);
	if (!row || row.n < 64) return;
	const dv = new DataView(row.buf.buffer);
	if (dv.getUint32(0, true) !== pid) return;
	return {
		ppid: dv.getUint32(4, true),
		pgid: dv.getUint32(8, true),
		comm: cstr(row.buf, 16, row.n),
	};
}

/**
 * Per-instance birth token: the kernel's unique process id, which survives
 * exec and is never reused. Older kernels without PROC_PIDUNIQIDENTIFIERINFO
 * fall back to proc_bsdinfo's start time (pbi_pid at offset 8 in the
 * documented layout; a later field inserted before it shifts it to 12, which
 * carries no start time).
 */
function darwinBirth(pid: number): string[] | undefined {
	const unique = darwinPidInfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 64);
	if (unique && unique.n >= 24) {
		const id = new DataView(unique.buf.buffer).getBigUint64(16, true);
		if (id !== 0n) return [String(id)];
	}
	const row = darwinPidInfo(pid, PROC_PIDTBSDINFO, 4096);
	if (
		!row ||
		row.n < 136 ||
		new DataView(row.buf.buffer).getUint32(8, true) !== pid
	)
		return;
	const dv = new DataView(row.buf.buffer);
	const sec = Number(dv.getBigUint64(48, true));
	const usec = Number(dv.getBigUint64(56, true));
	if (
		!(sec > 1_500_000_000 && sec < Date.now() / 1000 + 120) ||
		usec >= 1_000_000
	)
		return;
	return [String(sec), String(usec)];
}

function darwinCwd(pid: number): string | undefined {
	const row = darwinPidInfo(pid, PROC_PIDVNODEPATHINFO, 8192);
	if (!row || row.n < 200) return;
	for (const offset of [152, 144]) {
		const path = cstr(row.buf, offset, row.n);
		if (path.startsWith("/")) return realpathSync(path);
	}
	for (let i = 128; i < row.n; i++) {
		if (row.buf[i] !== 0x2f) continue;
		const path = cstr(row.buf, i, row.n);
		if (path.length > 1 && /^\/[^\x00-\x1f]*$/.test(path))
			return realpathSync(path);
	}
}

/** kern.procargs2: exec path, then the argument vector, then environment. */
let darwinArgvDenied = false;
function darwinArgv(pid: number): string[] | undefined {
	const lib = darwinLib();
	if (!lib || darwinArgvDenied) return;
	const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
	const buf = new Uint8Array(1024 * 1024);
	const len = new BigUint64Array([BigInt(buf.length)]);
	if (lib.sysctl(ptr(mib), 3, ptr(buf), ptr(len), null, 0n) !== 0) {
		// EPERM: the sandbox forbids kern.procargs2 entirely; dead pids retry.
		const errno = new DataView(toArrayBuffer(lib.__error(), 0, 4)).getInt32(
			0,
			true,
		);
		if (errno === 1) darwinArgvDenied = true;
		return;
	}
	const n = Number(len[0]);
	const argc = new DataView(buf.buffer).getInt32(0, true);
	if (argc < 1) return;
	const execPath = cstr(buf, 4, n);
	let offset = 4 + execPath.length + 1;
	while (offset < n && buf[offset] === 0) offset++;
	const strings: string[] = [];
	while (offset < n) {
		const value = cstr(buf, offset, n);
		if (!value.length) break;
		strings.push(value);
		offset += value.length + 1;
	}
	return strings.slice(0, argc);
}

function darwinFacts(pid: number): KernelProcessFacts | undefined {
	const info = darwinShortInfo(pid);
	const start = darwinBirth(pid);
	if (!info || !start) return;
	return {
		pid,
		ppid: info.ppid,
		pgid: info.pgid,
		start,
		comm: info.comm,
		argv: darwinArgv(pid) ?? [],
		cwd: darwinCwd(pid),
	};
}

function darwinTable(): KernelProcessRow[] | undefined {
	const lib = darwinLib();
	if (!lib) return;
	const pids = new Int32Array(16384);
	const n = lib.proc_listpids(PROC_ALL_PIDS, 0, ptr(pids), pids.byteLength);
	if (n <= 0) return;
	return Array.from(pids.slice(0, n >> 2)).flatMap((pid) => {
		if (pid <= 0) return [];
		const info = darwinShortInfo(pid);
		return info ? [{ pid, ppid: info.ppid, comm: info.comm, args: "" }] : [];
	});
}

/* Exported platform switch */

export function kernelProcessFacts(
	pid: number,
): KernelProcessFacts | undefined {
	if (process.platform === "linux") return linuxFacts(pid);
	if (process.platform === "darwin") return darwinFacts(pid);
}

export function kernelProcessTable(): KernelProcessRow[] | undefined {
	if (process.platform === "linux") return linuxTable();
	if (process.platform === "darwin") return darwinTable();
}

export function kernelProcessCwd(pid: number): string | undefined {
	if (process.platform === "linux") return linuxCwd(pid);
	if (process.platform === "darwin") return darwinCwd(pid);
}
