import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const source = readFileSync("install.ps1", "utf8");
for (const placeholder of ["__PRIME_AGENT_DOWNLOAD_BASE_URL__", "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"]) {
	if (!source.includes(placeholder)) throw new Error(`Windows installer is missing ${placeholder}`);
}
for (const requirement of ["process.arch", "requires x64 Node.js", "Programs\\Git\\bin\\bash.exe"]) {
	if (!source.includes(requirement)) throw new Error(`Windows installer is missing requirement: ${requirement}`);
}

if (process.platform !== "win32") {
	console.log("Windows installer template check passed; behavioral check skipped off Windows.");
	process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "prime-agent-windows-installer-"));
const packageBytes = Buffer.from("prime-agent-test-package\n");
const packageChecksum = createHash("sha256").update(packageBytes).digest("hex");
let channelVersion = "v0.7.0";
let serveBadChecksum = false;

const server = createServer((request, response) => {
	const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
	if (path === "/stable") {
		response.end(`${channelVersion}\n`);
		return;
	}
	if (path === "/releases/v0.7.0/prime-agent-0.7.0.tgz") {
		response.end(packageBytes);
		return;
	}
	if (path === "/releases/v0.7.0/SHA256SUMS") {
		const checksum = serveBadChecksum ? "0".repeat(64) : packageChecksum;
		response.end(`${checksum}  prime-agent-0.7.0.tgz\n`);
		return;
	}
	response.statusCode = 404;
	response.end("not found\n");
});

function runPowerShell(scriptPath, environment) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
			{ env: environment, windowsHide: true },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code, output: `${stdout}${stderr}` }));
	});
}

await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
});

try {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Windows installer test server has no TCP address");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const scriptPath = join(directory, "install.ps1");
	writeFileSync(
		scriptPath,
		source
			.replaceAll("__PRIME_AGENT_DOWNLOAD_BASE_URL__", baseUrl)
			.replaceAll("__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__", "stable"),
		"utf8",
	);

	const binDirectory = join(directory, "bin");
	const npmLog = join(directory, "npm.log");
	mkdirSync(binDirectory, { recursive: true });
	writeFileSync(
		join(binDirectory, "npm.cmd"),
		[
			"@echo off",
			`> "%PRIME_AGENT_INSTALLER_TEST_LOG%" echo %PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL% %PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL% %PRIME_AGENT_INSTALL_UV%`,
			`>> "%PRIME_AGENT_INSTALLER_TEST_LOG%" echo %*`,
			"exit /b 0",
			"",
		].join("\r\n"),
	);
	const fakeProgramFiles = join(directory, "Program Files");
	const fakeGitBin = join(fakeProgramFiles, "Git", "bin");
	mkdirSync(fakeGitBin, { recursive: true });
	copyFileSync(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", join(fakeGitBin, "bash.exe"));

	const environment = {
		...process.env,
		PATH: `${binDirectory};${process.env.PATH ?? ""}`,
		ProgramFiles: fakeProgramFiles,
		PRIME_AGENT_INSTALLER_TEST_LOG: npmLog,
	};
	const success = await runPowerShell(scriptPath, environment);
	if (success.code !== 0) throw new Error(`Windows installer success case failed:\n${success.output}`);
	const npmInvocation = readFileSync(npmLog, "utf8");
	if (!npmInvocation.includes("1 1 1")) throw new Error("Windows installer did not enable postinstall bootstrap");
	if (!npmInvocation.includes("install -g") || !npmInvocation.includes("prime-agent-0.7.0.tgz")) {
		throw new Error(`Unexpected npm invocation:\n${npmInvocation}`);
	}

	unlinkSync(npmLog);
	serveBadChecksum = true;
	const checksumFailure = await runPowerShell(scriptPath, environment);
	if (checksumFailure.code === 0 || !checksumFailure.output.includes("Checksum mismatch")) {
		throw new Error(`Windows installer accepted a bad checksum:\n${checksumFailure.output}`);
	}
	if (existsSync(npmLog)) throw new Error("Windows installer invoked npm after checksum failure");

	serveBadChecksum = false;
	for (const invalidVersion of ["vv0.7.0", "01.2.3", "1.2.3-."]) {
		channelVersion = invalidVersion;
		const invalidVersionFailure = await runPowerShell(scriptPath, environment);
		if (invalidVersionFailure.code === 0 || !invalidVersionFailure.output.includes("Invalid Prime Agent version")) {
			throw new Error(`Windows installer accepted invalid version ${invalidVersion}:\n${invalidVersionFailure.output}`);
		}
		if (existsSync(npmLog)) throw new Error(`Windows installer invoked npm for invalid version ${invalidVersion}`);
	}

	console.log("Windows installer check passed.");
} finally {
	await new Promise((resolve) => server.close(resolve));
	rmSync(directory, { recursive: true, force: true });
}
