# Windows Job Object evaluation

**Accessed:** 2026-08-06

## Recommendation

Use exact **`koffi@2.16.2`** as a direct coding-agent dependency. The repository already resolved this MIT-licensed Node-API 8 package through TUI, included its tested Windows x64 prebuilt binary, and externalized it from the esbuild CLI bundle. Making it direct adds no new package or version; it makes required daemon isolation fail closed instead of depending on an optional transitive install.

Koffi 3.1.3/3.1.4 were evaluated but rejected for this change because the configured npm registry age policy refused both. No policy bypass is needed.

## Design

A Windows daemon worker creates and retains a Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The worker itself and its non-Bash children remain outside the Job, so replacement supervisors survive worker failure. Before a local Bash command runs, Bash blocks on an anonymous stdin pipe; the worker assigns its PID with `AssignProcessToJobObject`, then releases the gate. Git for Windows resolves from the public `bin\\bash.exe` path to direct `usr\\bin\\bash.exe`, preventing its launcher from creating an unassigned descendant first.

The Job uses only kernel handles and an anonymous pipe. Process identity checks reuse Koffi and `GetProcessTimes`, avoiding a PowerShell subprocess for every PID check. This adds no persistent file or network I/O. Missing Koffi, unsupported architecture, invalid PID, or failed `CreateJobObjectW`, `SetInformationJobObject`, `OpenProcess`, `AssignProcessToJobObject`, or `CloseHandle` rejects execution.

## Evidence and risk

A dedicated Windows causality test runs without a supervisor: with the same direct Bash executable and active blocker command, the assigned leaf exits with its owner while the no-Job control survives until explicit cleanup. It passes alongside all 8 supervisor process tests (with 6 additional platform skips), including replacement recovery after a hard worker kill.

Koffi is memory-unsafe FFI; the implementation therefore limits the raw `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` layout to the supported Windows x64 target and checks every Win32 result. Microsoft documents [Job inheritance and lifecycle](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [kill-on-close](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information), and [process assignment](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject). Koffi documents [Windows x64 prebuilt support](https://koffi.dev/platforms) and [Node-API compatibility](https://koffi.dev/start).
