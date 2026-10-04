# Browser Pilot server

The Express server exposes the model-settings and task APIs, runs the browser agent, and hosts a WebSocket for browser frames and task events. Playwright launches installed Google Chrome in headed mode with a persistent profile at `.browser-profile/`.

## Start

From the repository root, run `npm run dev`. The server listens on port `3001`; `GET /health` reports whether Chrome is connected, starting, or recovering. Install Google Chrome before starting the server. Only one server can use the persistent profile at a time.

## Browser lifecycle and task limits

- Chrome launch failures and unexpected context closure are logged and retried with exponential backoff capped at 30 seconds.
- If the active page is closed while Chrome remains open, the server attempts to create a replacement page.
- Browser frames are streamed as JPEG snapshots to connected WebSocket clients. A 30-second ping/pong heartbeat detects dead connections; clients may reconnect safely.
- Tasks stop after 10 minutes or 40 agent actions. Model requests, browser navigation, page actions, and screenshot capture also have individual timeouts.
- Task event and action logs omit typed text and credentials. The model/API key is not printed.

See the repository [README](../README.md) for configuration, WebSocket message shapes, API routes, development, and security guidance.