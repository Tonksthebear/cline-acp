# Cline ACP

An [ACP-compatible](https://agentclientprotocol.com) coding agent powered by [Cline](https://github.com/cline/cline).

Use Cline from ACP clients such as [Zed](https://zed.dev)!

## Features

- Context @-mentions
- Images
- Tool calls with permission requests
- Plan/Act mode switching
- Multiple AI model support (via Cline's provider configuration)
- Streaming responses
- Tool integration testing capabilities

## Prerequisites

You need the [Cline CLI](https://www.npmjs.com/package/cline) installed:

```bash
npm install -g cline
```

Configure your API key in Cline's settings before use.

## Installation

```bash
npm install cline-acp
```

## Usage

Start the ACP agent:

```bash
cline-acp
```

The agent will automatically connect to an existing Cline instance or start a new one.

### With Zed

1. **Install dependencies** (if not already done):

   ```bash
   npm install -g cline-acp
   ```

2. **Configure Zed** by adding the agent server to your Zed `settings.json`:

   ```json
   {
     "agent_servers": {
       "Cline": {
         "type": "custom",
         "command": "cline-acp"
       }
     }
   }
   ```

For more information about Zed's external agents, see [Zed's External Agent documentation](https://zed.dev/docs/ai/external-agents).

### Other Clients

Any ACP-compatible client can use this agent. Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## How It Works

This adapter connects to Cline via its gRPC interface:

```
┌─────────────┐     ACP      ┌─────────────────┐    gRPC     ┌─────────────┐
│ ACP Client  │◄────────────►│    cline-acp    │◄───────────►│ cline-core  │
│   (Zed)     │   (stdio)    │                 │             │             │
└─────────────┘              └─────────────────┘             └─────────────┘
```

Cline handles all file operations and tool execution internally.

## Known Limitations

Due to limitations in the Cline CLI's gRPC interface, some ACP features are not fully supported:

| Feature | Status | Notes |
|---------|--------|-------|
| Line numbers in file edits | Not available | Cline's `ToolMessage` struct doesn't include line number fields. File paths work, but jump-to-line is not supported. |
| Available commands | Not available | Cline doesn't expose a list of available slash commands through its gRPC interface. |

These limitations are upstream in the Cline CLI and would require changes to the [cline/cline](https://github.com/cline/cline) repository to resolve.

For detailed information about ACP feature support and Cline CLI capabilities, see [docs/ACP_FEATURE_IMPROVEMENTS.md](docs/ACP_FEATURE_IMPROVEMENTS.md).

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm run test:run

# Start in development mode
npm run dev
```

## Acknowledgments

Inspired by [claude-code-acp](https://github.com/zed-industries/claude-code-acp) by Zed Industries.

## Repository

[https://github.com/Tonksthebear/cline-acp](https://github.com/Tonksthebear/cline-acp)

## License

Apache-2.0