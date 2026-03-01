<div align="center">
  <img src="BlitzBlue.png" width="100" />
  <br /><br />
  <p>MCP server that lets AI use an iPhone</p>

  [![Website](https://img.shields.io/badge/blitz.dev-website-black)](https://blitz.dev/)
  [![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/wJQ6dA95S6)
  [![npm](https://img.shields.io/npm/v/@blitzdev/ios-mcp?label=npm&color=blue)](https://www.npmjs.com/package/@blitzdev/ios-mcp)
</div>

# @blitzdev/ios-mcp

<!-- NOTE: Video showing a 30-second demo of Claude Code tapping through an app on a simulator, scanning UI, and taking a screenshot -->

## Installation

```bash
npm install @blitzdev/ios-mcp
```

## Quick Start

### Global (use in any project)

```bash
npx @blitzdev/ios-mcp --setup-all
```

This installs dependencies and configures `@blitzdev/ios-mcp` for all your AI agents. It automatically sets up Claude Code, and if you have Cursor, Codex, or OpenCode installed, those get configured too.

NOTE: For Cursor, you need to enable the blitz-ios MCP server in Cursor Settings

### Project-scoped (one project only)

```bash
cd your-project
npx @blitzdev/ios-mcp --setup-here
```

This prompts you to choose which AI agents to configure (Claude Code, Cursor, Codex, OpenCode) and writes the config files into your project directory. `@blitzdev/ios-mcp` will only be available when you open an agent inside that directory.

### Then just ask

Open a new AI agent session and ask:

```
> scan the simulator screen and tell me what you see
```

```
> connect to my iPhone and test the login flow
```

```
> find bugs in my app — tap around, try edge cases, report anything weird
```

<!-- NOTE: Video showing Claude Code responding to "test my app", scanning UI, tapping buttons, finding a bug, and screenshotting the result -->

## What can it do?

| Capability | Simulator | Physical iPhone |
|---|---|---|
| Tap, swipe, type text | Yes | Yes |
| Press buttons (Home, Lock, Siri) | Yes | Yes |
| Scan UI elements with coordinates | Yes | Yes |
| Take screenshots | Yes | Yes |
| List & launch installed apps | Yes | Yes |
| Auto-detect devices | Yes | Yes |
| Live screen viewer in browser | -- | Yes |

<!-- NOTE: Image showing a split view — left side has Claude Code terminal with scan_ui output, right side shows the corresponding simulator screen with UI elements highlighted -->

## Simulators

Boot any iOS simulator, then ask your AI agent to interact with it. No extra setup needed beyond `--setup-all` or `--setup-here`.

```
> what apps are installed on the simulator?
> launch Safari and go to example.com
> take a screenshot
```

<!-- NOTE: Image showing terminal output of the list_apps tool with clean formatted app list -->

## Physical iPhones

Connect your iPhone via USB or make sure it's on the same Wi-Fi network (home/office networks work, public cafe Wi-Fi won't).

**First-time setup** — your iPhone needs:
1. **Developer Mode** enabled (Settings > Privacy & Security > Developer Mode)
2. **Trust this computer** when prompted on the phone

Then ask your agent:

```
> connect to my iPhone
```

The agent will build and install WebDriverAgent on your phone (takes 1-3 minutes the first time), then give you a URL like `http://localhost:5152?udid=...` — open it in your browser to see a live view of your phone screen.

<!-- NOTE: Image showing the browser-based viewer with an iPhone screen displayed in a dark bezel frame -->

## Example session

```
You:    test the checkout flow in my app
Agent:  Let me scan the simulator to see what's on screen.

        [calls scan_ui]

        I can see the home screen. Let me launch your app first.

        [calls launch_app with bundleId "com.myapp"]
        [calls get_screenshot]

        The app is open on the main screen. I see a "Shop" tab at the bottom.
        Let me tap it and walk through the checkout flow.

        [calls device_action: tap on "Shop" tab]
        [calls scan_ui]

        I see a list of products. Let me add one to cart...
```

<!-- NOTE: Video showing a full end-to-end testing session — agent launches app, navigates through screens, finds a UI bug, screenshots it, and reports the issue -->

## MCP Tools reference

These are the tools your AI agent can call:

| Tool | What it does |
|---|---|
| `get_execution_context` | Find available simulators and iPhones |
| `scan_ui` | Find tappable elements — buttons, links, text fields — with their coordinates |
| `describe_screen` | Full UI element hierarchy (more detail than scan_ui) |
| `device_action` | Tap, swipe, press buttons, type text, press keys |
| `device_actions` | Run multiple actions in sequence |
| `get_screenshot` | Save a screenshot and return the file path |
| `list_devices` | List all simulators and physical devices |
| `launch_app` | Launch an app by bundle ID |
| `list_apps` | List installed apps |
| `setup_device` | Build & install WebDriverAgent on a physical iPhone |

## Requirements

- macOS
- Xcode (install from App Store or `xcode-select --install`)
- Node.js 18+
- Homebrew (for installing idb dependencies)

The `--setup-all` / `--setup-here` command handles installing everything else automatically.

## Manual MCP configuration

If you'd rather configure things yourself:

**Claude Code** — add to `~/.claude.json` (global) or `.mcp.json` (project):

```json
{
  "mcpServers": {
    "blitz-ios": {
      "command": "npx",
      "args": ["@blitzdev/ios-mcp"]
    }
  }
}
```

**Cursor** — add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "blitz-ios": {
      "command": "npx",
      "args": ["@blitzdev/ios-mcp"]
    }
  }
}
```

**Codex** — add to `~/.codex/config.toml` (global) or `.codex/config.toml` (project):

```toml
[mcp_servers.blitz-ios]
command = "npx"
args = ["@blitzdev/ios-mcp"]
```

**OpenCode** — add to `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "blitz-ios": {
      "type": "local",
      "command": ["npx", "-y", "@blitzdev/ios-mcp"],
      "enabled": true
    }
  }
}
```

## Troubleshooting

**"No booted simulator found"** — Open Simulator.app or run `xcrun simctl boot "iPhone 16"` first.

**Physical device not detected** — Make sure Developer Mode is on, the phone is connected via USB, and you've tapped "Trust" on the phone.

**WDA build fails** — Open Xcode > Settings > Accounts and make sure an Apple ID is signed in. Xcode needs a signing identity to build WDA.

**"Connection refused" errors** — The idb companion may have crashed. Run `npx @blitzdev/ios-mcp --setup-all` again to re-initialize.

## License

MIT
