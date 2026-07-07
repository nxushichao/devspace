# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through DevSpace.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local DevSpace server

DevSpace does not create the public tunnel for you. Use Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or your own HTTPS reverse proxy.

## Windows One-Click Setup For A Local Checkout

When developing DevSpace from this repository on Windows, double-click
`setup-devspace.bat`, or run:

```bash
npm run setup:windows
```

The script checks Node, npm, Git, and Bash; installs dependencies when they are
missing; builds the project; and creates or updates the DevSpace configuration.
It preserves existing configuration values where possible and preserves the
Owner password unless you explicitly reset it. On a first run, the parent folder
of this checkout becomes the allowed project root.

Pass an allowed root and public HTTPS base URL when setting up a remote MCP
connection. Enter the base URL without `/mcp`:

```powershell
npm run setup:windows -- -AllowedRoot "E:\code" -PublicBaseUrl "https://your-tunnel-host.example.com"
```

Useful optional switches are `-Port 7676`, `-ForceInstall`, `-SkipBuild`,
`-ResetToken`, and `-ShowOwnerToken`. If no public base URL is set, the local
server still works but a remote MCP client cannot connect until you configure an
HTTPS tunnel URL.

## Windows Desktop Control Center

The local checkout includes an Electron desktop control center. Double-click
`start-devspace-desktop.bat`, or run:

```bash
npm run desktop
```

The desktop app can select allowed project roots, set the local port and public
HTTPS base URL, save the DevSpace configuration, run `doctor`, show recent
service output, and start or stop the DevSpace process. Its custom icon is used
in the window, taskbar, and system tray. Minimizing or closing the window hides
it to the tray; the tray menu can show the window, start or stop the managed
service, or exit the app. A process started in a terminal is displayed as an
external service and cannot be stopped by the desktop app.

The **Reset Owner password** action rotates the local owner token and revokes all
issued OAuth access and refresh tokens. The new value is shown only for the
current desktop session so it can be stored securely. A service managed by the
desktop app restarts automatically; an externally started service must be
restarted from its original terminal before it can use the new value.

Three Windows release formats are available:

```bash
# One self-extracting EXE for direct sending; slower first launch.
npm run desktop:portable

# Full directory package; unzip it, then run win-unpacked/DevSpace Desktop.exe.
npm run desktop:unpacked

# NSIS installer with install location, desktop shortcut, and Start menu entry.
npm run desktop:installer
```

The portable output is `release/DevSpace Desktop-<version>-portable.exe`; the
unpacked output is `release/win-unpacked/`; and the installer is named like
`release/DevSpace Desktop-<version>-installer-x64.exe`. The portable package
contains the Electron application, DevSpace server, production dependencies,
and the matching Node runtime. It is larger than the installer and extracts to a
temporary directory on each launch.

Git and Git Bash (or WSL) are still required only for DevSpace shell and Git
operations. The desktop app itself opens without them and its environment
diagnostic reports what is missing. Unsigned executables can trigger Windows
SmartScreen on another computer; code signing with a trusted certificate is
required to remove that publisher warning.

## Install And Configure

Run:

```bash
npx @waishnav/devspace init
```

The setup flow asks one question at a time.

### Project Roots

Choose the folders ChatGPT is allowed to open through DevSpace. Keep this
narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

### Local Port

The default is `7676`.

The local MCP URL is:

```text
http://127.0.0.1:7676/mcp
```

### Public Base URL

Start your tunnel or reverse proxy before entering this value. Point the tunnel
at:

```text
http://127.0.0.1:7676
```

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

## Start The Server

Run:

```bash
npx @waishnav/devspace serve
```

If your tunnel URL changes for one run, override it without rewriting config:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx @waishnav/devspace serve
```

For a stable public URL, persist it:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, DevSpace shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
npx @waishnav/devspace doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are developing DevSpace itself instead of using the published package:

```bash
npm install --include=dev
npm run dev
```

The same setup rules apply.
