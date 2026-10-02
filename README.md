# Browser Pilot

Browser Pilot is a talk-to-browser agent foundation. Phase 1 connects a React desktop-style shell to an installed, headed Chrome session and streams the active page into the app.

## Requirements

- Node.js 22 or newer and npm
- Google Chrome installed on the machine running the server

The server launches Chrome with a persistent profile at `server/.browser-profile/`. Logins and browser data stay on that machine; the profile is ignored by Git. Run only one Browser Pilot server against this profile at a time.

## Start Developing

```sh
git clone <repository-url>
cd Browser_agent
npm install
npm install --prefix server
npm install --prefix web
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The server listens on port `3001`; `GET http://localhost:3001/health` reports its status. Stop both development processes with `Ctrl+C`.

Run production TypeScript and frontend builds with:

```sh
npm run build
```

## Architecture

```text
Browser Pilot workspace
├── server/   Express, WebSocket, Playwright, persistent Chrome
└── web/      React, Vite, TypeScript, Tailwind CSS
```

- The root `package.json` runs the server and Vite concurrently with `npm run dev`.
- `server/src/index.ts` starts Express and a WebSocket server on the same HTTP server. Playwright launches the installed Chrome channel in headed mode, using the project-local persistent profile.
- The server follows newly opened tabs and streams the newest active page as JPEG frames about every 400 ms (roughly 2.5 frames per second), together with the current URL, title, and capture time. Frames are sent only while at least one WebSocket client is connected.
- `web/src/BrowserPilot.tsx` renders the app shell and live frame. It reconnects to the WebSocket with increasing delays when the connection drops and shows connecting, connected, disconnected, and error states.
- The command bar is visual-only in this phase. Its send button is not connected to browser actions.

## WebSocket Messages

Connect to `ws://localhost:3001`. The server sends status messages and snapshots shaped like:

```json
{"type":"status","status":"connected"}
```

```json
{"type":"snapshot","url":"https://example.com/","title":"Example Domain","image":"<base64 JPEG>","capturedAt":1790944142640}
```

To navigate the active browser tab, send:

```json
{"type":"navigate","url":"https://example.com/"}
```

Only HTTP and HTTPS navigation URLs are accepted. The page title and URL appear in the stream metadata and browser toolbar.

## Phase 2 Starting Points

Start in `server/src/index.ts` to extend browser capabilities and define any new WebSocket message types. Keep the client and server message contract in sync; add validation and focused tests for each new action. Start in `web/src/BrowserPilot.tsx` for UI behavior and `web/src/pilot.css` for the app shell styling. The command bar is the natural place to connect future task submission, while the activity panel is currently an empty timeline placeholder.

The browser-control WebSocket currently has no authentication, so keep the server on a trusted development machine and do not expose port `3001` to an untrusted network.