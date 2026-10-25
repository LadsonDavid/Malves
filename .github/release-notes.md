Files for each place malves runs. Setup steps: see the README, "Getting started".

- **malves.apk**: the Android app. Open it on your phone and allow installing from your browser or files app.
- **malves-chrome.zip**: the Chrome extension. Unzip it, open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and choose the unzipped folder.
- **malves.vsix**: the IDE extension for VS Code, Cursor, Antigravity or Windsurf. In the IDE: **Extensions → ⋯ → Install from VSIX…**
- **malves-windows.zip** and **install.ps1**: the computer side for Windows, with its own Node.js (nothing to install first). Download `install.ps1`, run it in PowerShell, and it unpacks and checks the zip. Mac and Linux run from the source: see the README. The `.sha256` file is the zip's checksum, which `install.ps1` checks.
