# Myra AI Gemini

Myra is an AI assistant desktop application powered by Google's Gemini API. It provides voice interaction, remote control via phone, and project intelligence features for technical interviews and code analysis.

## Features

### 🤖 **Voice Assistant**
- Real-time voice conversations with Gemini AI
- Desktop microphone integration
- Text-to-speech responses

### 📱 **Phone Remote Control**
- Secure phone dashboard at `/remote`
- One-time code pairing between desktop and phone
- Phone microphone audio streaming to desktop session
- Tailscale Serve integration for secure remote access

### 🧠 **Project Intelligence & Interview Mode**
- Analyze local folders or public GitHub repositories
- Build evidence-linked knowledge profiles from real code
- Conduct live technical interviews (text or voice)
- Generate assessment reports with scores and feedback

### 🛠️ **Desktop Tool Integration**
- File system access (read, search, compare)
- Browser control (YouTube, tabs, navigation)
- WhatsApp Web integration
- VS Code project planning and editing
- Windows application control (allowlisted apps)
- Multi-step task automation

## Quick Start

### Prerequisites
- Node.js 18+
- npm or yarn
- Google Gemini API key

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd Myra_AI_Gemini
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy environment variables:
   ```bash
   copy .env.example .env
   ```

4. Edit `.env` file and add your Gemini API key:
   ```env
   GEMINI_API_KEY="your-api-key-here"
   AI_PROVIDER=gemini
   ```

### Running the Application

#### Development Mode (Browser)
```bash
npm run dev
```
Open `http://localhost:3000` in your browser.

#### Desktop Application (Electron)
```bash
npm run electron:dev
```

#### Build for Production
```bash
# Build the application
npm run build

# Create Windows installer
npm run electron:build:win
```

## Configuration

### Environment Variables

See `.env.example` for all available options. Key variables:

- `GEMINI_API_KEY`: Your Google Gemini API key (required)
- `PORT`: Server port (default: 3000)
- `MYRA_REMOTE`: Enable/disable phone remote (default: enabled in Electron)
- `MYRA_INTELLIGENCE`: Enable/disable project intelligence features
- `MYRA_DATA_DIR`: Directory for storing project data

### Phone Remote Setup

1. Ensure Tailscale is installed and running on your PC
2. Start Myra in Electron mode
3. Use Tailscale Serve to expose the local port:
   ```powershell
   tailscale serve --bg 3000
   ```
4. Configure `MYRA_REMOTE_PUBLIC_URL` with your Tailscale URL

## Usage

### Basic Voice Assistant
1. Start Myra in Electron mode
2. Click the microphone button to start voice conversation
3. Speak naturally - Myra will respond with voice and text

### Phone Remote
1. Start Myra on your PC
2. Open the phone dashboard URL on your mobile device
3. Enter the 6-digit pairing code shown on desktop
4. Use phone microphone for voice input

### Project Intelligence
1. Click **INTERVIEW** in the footer
2. Choose a source:
   - **Local folder**: Select a directory (desktop app only)
   - **GitHub**: Enter a public repository URL
   - **Saved**: Previously analyzed projects
3. Click **Analyse project** to build knowledge profile
4. Start an interview with text or voice questions

## API Documentation

Myra provides several API surfaces:

### Local HTTP API
- `GET /api/health`: Health check
- `GET /api/remote/pairing`: Remote pairing status
- `POST /api/remote/pairing/rotate`: Generate new pairing code

### Project Intelligence API (`/api/intelligence/*`)
- Project import (local/GitHub)
- Project analysis and knowledge extraction
- Interview session management
- Report generation

See `api/` directory for detailed API contracts:
- [API Endpoints](api/endpoints.md)
- [Error Codes](api/errors.md)
- [API Contracts](api/contracts.md)

## Security

### Authentication & Authorization
- Desktop authentication via per-run WebSocket token
- Phone pairing with one-time codes and secure cookies
- Handoff Authority for secure tool execution in Electron
- Loopback-only server binding by default

### Security Features
- Read-only file system access for project intelligence
- Explicit scope limits for file scanning
- Secrets detection and redaction
- Rate limiting and abuse prevention
- Origin validation for remote endpoints

### Data Privacy
- No raw audio storage (only transcript text)
- Local JSON storage for project data
- No cloud synchronization
- All processing occurs on local machine

## Architecture

### Components
- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **Backend**: Express.js + TypeScript
- **Desktop**: Electron for native integration
- **Voice**: Gemini Live API with WebSocket streaming
- **Tools**: Handoff Authority for secure desktop operations

### Project Structure
```
Myra_AI_Gemini/
├── electron/           # Electron main process
├── src/
│   ├── server/        # Express server with APIs
│   ├── components/    # React components
│   └── utils/         # Utility functions
├── api/              # API documentation
├── docs/             # Feature documentation
├── test/             # Test suites
└── dist/             # Build output
```

## Development

### Running Tests
```bash
# Run all tests
npm test

# Run specific test suites
npm run test:intelligence
npm run test:remote
npm run test:browser-window
```

### Code Quality
```bash
# Type checking
npm run lint

# Build verification
npm run build
```

### Adding New Tools
1. Define tool schema in `src/server/index.ts`
2. Implement controller in Electron main process
3. Add validation in Handoff Authority
4. Write comprehensive tests

## Troubleshooting

### Common Issues

**Phone cannot connect:**
- Verify Tailscale Serve is running (`tailscale serve status`)
- Check `MYRA_REMOTE_PUBLIC_URL` matches Tailscale URL
- Ensure HTTPS is used (required for microphone access)

**Voice not working:**
- Check Gemini API key in `.env`
- Verify microphone permissions
- Check browser/Electron console for errors

**Project analysis fails:**
- Ensure selected folder is within approved roots (Electron)
- Check file size limits (200KB per file, 160 files max)
- Verify GitHub repository is public

**Tool execution denied:**
- Tool may require user confirmation
- Check Electron console for denial reasons
- Verify tool is in allowlist

## License

This project is for personal use. See LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Submit a pull request

## Support

For issues and questions:
1. Check existing documentation in `docs/` directory
2. Review API contracts in `api/` directory
3. Enable debug logging by setting environment variables

---

*Myra AI Gemini - Your intelligent desktop assistant for code analysis and voice interaction*