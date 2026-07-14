# Repository Guidelines

## Project Structure & Module Organization
This repository contains a remote support system with a hybrid architecture:
- **Node.js Backend**: `.\server.js` serves as the central Express and WebSocket server for authentication, routing, and active sessions.
- **Web Frontend**: `.\public\` contains static HTML and JavaScript files for the technician console and customer join page.
- **Native Windows Components**:
  - `.\native-agent\`: A .NET 8 desktop helper for real desktop capture and mouse input injection.
  - `.\native-service\`: A .NET 8 unattended service that registers the endpoint and launches the desktop helper.
  - `.\native-host\`: A .NET 8 component likely related to hosting or relaying.
- **Data & Configuration**: `.\data\` stores application state (`auth.json`, `state.json`), and `.\certs\` stores local development certificates.
- **Deployment**: `.\deploy\` contains scripts for production setup on Ubuntu, including Caddy and Cloudflare configurations.

## Build, Test, and Development Commands
### Node.js (Server & Frontend)
- **Install dependencies**: `npm install`
- **Start server**: `node server.js` (aliased to `npm dev` and `npm start`)
- **HTTPS Setup**: Use `dotnet dev-certs` or `openssl` to generate certificates in `.\certs\`, then set `HTTPS_PFX`, `HTTPS_KEY`, or `HTTPS_CERT` environment variables.

### .NET (Native Components)
- **Run Agent**: `cd .\native-agent && dotnet run -- http://helpsupport.top:3001`
- **Publish components**:
  - `dotnet publish .\native-agent\RemoteSupportAgent.csproj -c Release -o .\native-agent\publish`
  - `dotnet publish .\native-service\RemoteSupportService.csproj -c Release -o .\native-service\publish`
- **Service Installation**: `.\native-service\publish\RemoteSupportService.exe --install <server_url> --helper <helper_path>`

## Coding Style & Naming Conventions
- The Node.js server uses ES Modules (`"type": "module"` in `.\package.json`).
- Native components follow standard C#/.NET 8 conventions.
- Use `.\public\webmcp.js` for WebRTC/WebSocket interactions in the browser.

## Deployment Guidelines
- Production setup is documented in `.\deploy\PRODUCTION.md`.
- Use `.\deploy\install-ubuntu-production.sh` for initial server setup.
- Cloudflare Tunnel configuration is located in `.\.cloudflared\config.yml`.
