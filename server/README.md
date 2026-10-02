# Browser Pilot server

The server launches installed Google Chrome in headed mode with a persistent profile at `.browser-profile/`, then streams JPEG screenshots and page metadata to WebSocket clients on port 3001. It follows newly opened tabs and accepts `{"type":"navigate","url":"https://example.com"}` messages. Install Google Chrome before starting the server.