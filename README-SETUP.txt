JARVIS OWNER TOOLS - INSTALL NOTES

1. Stop the current server with Ctrl+C.
2. Back up your existing project folder before replacing files.
3. Replace server.js and the three files inside public/ with these versions.
4. From your existing project folder, run:
   npm install @simplewebauthn/server
5. Start JARVIS:
   npm run dev
6. Open http://localhost:3000 (not 127.0.0.1) in an up-to-date Edge or Chrome browser.
7. Look at the server terminal for the one-time JARVIS OWNER SETUP CODE.
8. Click the core to open chat, then OWNER MODE. Enter the setup code and click SET UP WINDOWS HELLO.
9. Follow the Windows Hello/passkey prompt. After setup, the code is no longer needed.

Existing data/data/jarvis.db is not replaced. Back it up before trying the update.

SECURITY / SCOPE NOTES
- JARVIS listens on 127.0.0.1 only. Do not expose it to your LAN or the internet.
- Windows Hello uses WebAuthn/passkeys. This is a first local implementation; test registration and unlock before relying on it.
- The owner setup code is printed to the server terminal and is only valid until that server process restarts. Owner setup is one-time.
- Owner sessions are kept in server memory and expire after 30 minutes of inactivity.
- The terminal runs real PowerShell for a small allowlist of read-only diagnostic commands. It deliberately does not execute arbitrary PowerShell text. This avoids giving model-generated text unrestricted control of your PC.
- Launcher scanning checks Start Menu and Desktop .lnk shortcuts for names associated with Minecraft launchers. It does not recursively inspect the entire drive.
- App launch and website opening require owner mode and a confirmation prompt. Website allowlist currently contains YouTube and Instagram.
- If passkey registration errors, check terminal output and confirm you used http://localhost:3000, not 127.0.0.1.
