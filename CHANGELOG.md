# Changelog

## 0.1.0

Initial release of cline-acp - an ACP adapter for Cline.

### Features

- Full ACP protocol support (initialize, newSession, prompt, cancel)
- Plan/Act mode switching
- Model selection via Cline's provider configuration
- Permission request handling for tool calls
- Streaming state updates
- Automatic Cline process management (connect to existing or start new)
- gRPC communication with cline-core

### Architecture

This project was derived from [claude-code-acp](https://github.com/zed-industries/claude-code-acp) by Zed Industries, adapting the ACP protocol implementation to work with Cline instead of Claude Code SDK.

Key differences from the original:

- Uses Cline's gRPC interface instead of Claude Code SDK
- No MCP server needed (Cline handles file/terminal operations internally)
- Simplified permission flow using Cline's ask/response pattern
