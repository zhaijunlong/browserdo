# BrowserDo plugin for Claude

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/zhaijunlong/browserdo)

[Embiody](https://embiody.com) is a Windows browser your AI agent works in, in the background,
while you keep using your PC and can step in at any time. This plugin connects Claude to it, so
Claude can search, read pages, click, type and fill in forms, including on sites you are signed
in to.

## What is inside

- **The BrowserDo MCP server** ([source](https://github.com/zhaijunlong/browserdo)), started with
  `npx -y browserdo-mcp@0.9.3` from the npm package
  [`browserdo-mcp`](https://www.npmjs.com/package/browserdo-mcp).
- **The `browserdo` skill**, which tells Claude how to use the browser tools well: snapshot the
  page first and act by element number, batch several steps in one call, read pages with BrowserDo
  instead of a fetch tool, search from the search engine's home page, leave sign-in, captchas
  and payment to you, and work in its own tabs.

## Where it works

| | MCP server (the browser tools) | Skill |
| --- | --- | --- |
| Claude Code (terminal, IDE extensions, the desktop app's Code tab) | Yes | Yes |
| Cowork in the Claude desktop app | Only when the Cowork session runs on your computer | Yes |
| Chat (claude.ai, the desktop app's Chat, mobile) | No | Yes; it helps only where the BrowserDo desktop extension provides the tools (below) |

Claude runs local MCP servers from plugins only in Claude Code and in local Cowork sessions. To use
BrowserDo in the desktop app's Chat, install the Claude Desktop extension
(`browserdo-mcp-cldd-<version>.mcpb`) from the
[GitHub releases](https://github.com/zhaijunlong/browserdo/releases) instead.

## Requirements

- Windows 10 or 11, 64-bit.
- Node.js 20 or newer (`node -v`). Install it with `winget install OpenJS.NodeJS.LTS`.
- The Embiody browser: installed automatically the first time BrowserDo starts (about 140 MB, a
  few minutes). Until it is ready, each tool replies with the progress.

## What it runs, sends and stores

- **npm**: `npx` fetches the `browserdo-mcp` package from the npm registry to start it.
- **First start**: if Embiody is not installed, BrowserDo downloads the Embiody installer from
  GitHub (or a mirror if GitHub can't be reached) and installs it for your Windows user, without
  administrator rights.
- **Browser updates**: the Embiody browser updates itself, checking the signature of every update.
- **No telemetry**: BrowserDo sends no usage statistics or error reports. The browser tools return
  pages only to Claude.
- **Your browser**: Claude works in your own Embiody, in its Default profile, so it can use the
  sites you are signed in to there. Other browsers such as Chrome or Edge are not touched.
- **Log**: `%LOCALAPPDATA%\Embiody\BrowserDo\logs` records the URLs visited and the steps taken,
  never page content. At most three 5 MB files.

See the [BrowserDo README](https://github.com/zhaijunlong/browserdo#readme) for the full tool list
and settings, the [privacy policy](https://embiody.com/privacy) and the
[Embiody end-user license agreement](https://embiody.com/eula).

## License

Apache License 2.0. The Embiody browser it installs is covered by the
[Embiody EULA](https://embiody.com/eula).
