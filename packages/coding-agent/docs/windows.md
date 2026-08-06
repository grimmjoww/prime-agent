# Windows Setup

Native Windows requires x64 Node.js 22.8.0 or newer and [Git for Windows](https://git-scm.com/download/win). ARM64 Node.js is not supported.

Install the stable release from PowerShell:

```powershell
irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
```

The installer verifies the release SHA-256 checksum before invoking npm. At runtime, Prime Agent resolves bash in these locations (in order):

1. Custom path from `~/.prime/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe` or `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`)
3. `bash.exe` on PATH for foreground sessions

After installation, run `prime-agent` from PowerShell, Windows Terminal, or Git Bash. Prime Agent uses the detected bash executable for model-generated shell commands. In daemon workers, Git for Windows resolves from the public `bin\\bash.exe` path to the direct `usr\\bin\\bash.exe` executable so process isolation is applied before Bash creates descendants.

Windows daemon workers require Git for Windows, hold a kill-on-close Job Object, and assign each local Bash process before releasing an anonymous startup pipe. Other Bash implementations remain available to foreground sessions but are rejected in daemon workers because their descendants cannot be guaranteed to join the Job. If the worker crashes, Windows terminates that Bash process tree; replacement supervisors remain outside the Job. This adds no persistent file or network I/O. Missing native support or any failed Win32 call prevents the worker from accepting commands instead of running without isolation.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
