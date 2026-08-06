import { createRequire } from "node:module";
import type * as Koffi from "koffi";

const cjsRequire = createRequire(import.meta.url);
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DOTNET_FILE_TIME_OFFSET_TICKS = 504911232000000000n;

type NativeHandle = unknown;

type WindowsJobApi = {
	createJobObject: (securityAttributes: null, name: null) => NativeHandle;
	setInformationJobObject: (job: NativeHandle, informationClass: number, information: Buffer, size: number) => boolean;
	openProcess: (access: number, inheritHandle: boolean, pid: number) => NativeHandle;
	assignProcessToJobObject: (job: NativeHandle, process: NativeHandle) => boolean;
	getProcessTimes: (
		process: NativeHandle,
		creationTime: Buffer,
		exitTime: Buffer,
		kernelTime: Buffer,
		userTime: Buffer,
	) => boolean;
	closeHandle: (handle: NativeHandle) => boolean;
	getLastError: () => number;
};

let api: WindowsJobApi | undefined;
let daemonWorkerJob: NativeHandle | undefined;

function windowsJobApi(): WindowsJobApi {
	if (api) return api;
	const koffi = cjsRequire("koffi") as typeof Koffi;
	const kernel32 = koffi.load("kernel32.dll");
	api = {
		createJobObject: kernel32.func(
			"void* __stdcall CreateJobObjectW(void*, void*)",
		) as WindowsJobApi["createJobObject"],
		setInformationJobObject: kernel32.func(
			"bool __stdcall SetInformationJobObject(void*, int, void*, uint32_t)",
		) as WindowsJobApi["setInformationJobObject"],
		openProcess: kernel32.func(
			"void* __stdcall OpenProcess(uint32_t, bool, uint32_t)",
		) as WindowsJobApi["openProcess"],
		assignProcessToJobObject: kernel32.func(
			"bool __stdcall AssignProcessToJobObject(void*, void*)",
		) as WindowsJobApi["assignProcessToJobObject"],
		getProcessTimes: kernel32.func(
			"bool __stdcall GetProcessTimes(void*, void*, void*, void*, void*)",
		) as WindowsJobApi["getProcessTimes"],
		closeHandle: kernel32.func("bool __stdcall CloseHandle(void*)") as WindowsJobApi["closeHandle"],
		getLastError: kernel32.func("uint32_t __stdcall GetLastError()") as WindowsJobApi["getLastError"],
	};
	return api;
}

function win32Failure(operation: string, errorCode: number): Error {
	return new Error(`${operation} failed with Win32 error ${errorCode}`);
}

function closeNativeHandle(jobApi: WindowsJobApi, handle: NativeHandle, context: string): void {
	if (!jobApi.closeHandle(handle)) {
		throw win32Failure(`CloseHandle (${context})`, jobApi.getLastError());
	}
}

function failureWithCleanup(jobApi: WindowsJobApi, handle: NativeHandle, failure: Error, context: string): Error {
	try {
		closeNativeHandle(jobApi, handle, context);
		return failure;
	} catch (cleanupError) {
		const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
		return new AggregateError(
			[failure, cleanupError],
			`${failure.message}; native handle cleanup failed: ${cleanupMessage}`,
		);
	}
}

export function getWindowsProcessStartTicks(pid: number): bigint | undefined {
	if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return undefined;
	const jobApi = windowsJobApi();
	const processHandle = jobApi.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
	if (!processHandle) return undefined;

	let startTicks: bigint | undefined;
	try {
		const creationTime = Buffer.alloc(8);
		const exitTime = Buffer.alloc(8);
		if (jobApi.getProcessTimes(processHandle, creationTime, exitTime, Buffer.alloc(8), Buffer.alloc(8))) {
			const fileTime = (BigInt(creationTime.readUInt32LE(4)) << 32n) | BigInt(creationTime.readUInt32LE(0));
			if (fileTime > 0n && exitTime.readBigUInt64LE() === 0n) {
				startTicks = fileTime + DOTNET_FILE_TIME_OFFSET_TICKS;
			}
		}
	} finally {
		if (!jobApi.closeHandle(processHandle)) startTicks = undefined;
	}
	return startTicks;
}

export function initializeWindowsDaemonWorkerJob(): void {
	if (process.platform !== "win32") return;
	if (daemonWorkerJob) return;
	if (process.arch !== "x64") {
		throw new Error(`Windows daemon process isolation requires x64, received ${process.arch}`);
	}

	const jobApi = windowsJobApi();
	const job = jobApi.createJobObject(null, null);
	if (!job) {
		throw win32Failure("CreateJobObjectW", jobApi.getLastError());
	}

	// ponytail: x64-only layout matches the supported Windows target; use Koffi structs when adding other architectures.
	const information = Buffer.alloc(144);
	information.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
	if (!jobApi.setInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, information, information.length)) {
		const failure = win32Failure("SetInformationJobObject", jobApi.getLastError());
		throw failureWithCleanup(jobApi, job, failure, "Job Object initialization");
	}
	daemonWorkerJob = job;
}

export function hasWindowsDaemonWorkerJob(): boolean {
	return daemonWorkerJob !== undefined;
}

export function assignProcessToWindowsDaemonWorkerJob(pid: number): void {
	if (!daemonWorkerJob) {
		throw new Error("Windows daemon worker Job Object is not initialized");
	}
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error(`Cannot assign invalid process id ${pid} to Windows daemon worker Job Object`);
	}

	const jobApi = windowsJobApi();
	const processHandle = jobApi.openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
	if (!processHandle) {
		throw win32Failure("OpenProcess", jobApi.getLastError());
	}
	if (!jobApi.assignProcessToJobObject(daemonWorkerJob, processHandle)) {
		const failure = win32Failure("AssignProcessToJobObject", jobApi.getLastError());
		throw failureWithCleanup(jobApi, processHandle, failure, "process assignment");
	}
	closeNativeHandle(jobApi, processHandle, "process assignment");
}
