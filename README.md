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

## Prerequisites

You need the [Cline CLI](https://www.npmjs.com/package/@anthropic-ai/cline) installed:

```bash
npm install -g @anthropic-ai/cline
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

Configure Zed to use cline-acp as an external agent. See [Zed's External Agent documentation](https://zed.dev/docs/ai/external-agents).

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
