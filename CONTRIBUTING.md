# Contributing to DriverRadar

Thanks for helping make driver updates less painful.

## Ways to help

- **Report a driver that was missed or matched incorrectly.** Include the device's
  hardware IDs (`Get-PnpDevice` → `HardwareID`), the package title, and the scan note.
- **Add a vendor adapter.** NVIDIA is implemented in `lib/nvidia.js`; AMD/Intel/OEM
  endpoints are welcome behind the same `latestDriver()` shape.
- **Improve the UI.** It is plain HTML/CSS/JS with no build step.
- **Test on another machine.** Windows 10, Windows 11, ARM64 laptops and OEM systems are
  all useful reports.

## Ground rules

- No npm dependencies. Node core, PowerShell and Windows built-ins only.
- Keep scans read-only. Never install anything without an explicit user action.
- Never add telemetry, analytics, or uploads. The server binds `127.0.0.1` only.
- Keep the downloader multi-part and resumable.
- Match the existing code style (single quotes, 2-space indent, small focused modules).

## Development

```bat
node cli.js scan      :: terminal scan
node server.js        :: UI on http://127.0.0.1:7788
node supervisor.js    :: keeps the server alive while you work
```

There is no build step and no test runner. `node --check <file>` catches syntax errors;
the live scan is the integration test.

## Pull requests

1. Fork the repo and create a topic branch.
2. Describe what machine/OS you tested on.
3. Include the before/after scan notes if the change affects matching.
4. Do not commit `data/`, downloaded packages, or logs.

By contributing you agree that your work is licensed under the MIT License.
