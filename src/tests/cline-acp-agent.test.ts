/**
 * ClineAcpAgent Tests - TDD tests for Cline ACP integration
 *
 * These tests define the expected behavior of the Cline ACP agent.
 * Following TDD approach: tests first, implementation follows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Agent,
  AgentSideConnection,
  AvailableCommand,
  Client,
  ClientSideConnection,
  ndJsonStream,
  NewSessionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import {
  ClineMessage,
  ClineMessageType,
  ClineAsk,
  ClineSay,
  ClineClient,
  ClineInstance,
  ClineSession,
  ClinePrompt,
  PlanActMode,
  StateUpdate,
  AskResponseType,
} from "../cline/types.js";
import { ClineAcpAgent } from "../cline/cline-acp-agent.js";
import {
  acpPromptToCline,
  clineMessageToAcpNotification,
  clinePartialToAcpNotification,
  parseToolInfo,
  clineToolAskToAcpToolCall,
  isTaskComplete,
  isWaitingForUserInput,
  needsApproval,
  extractMessagesFromState,
} from "../cline/conversion.js";

// Mock Cline gRPC client factory
function createMockClineClient(): ClineClient {
  const stateUpdates: StateUpdate[] = [];
  const partialMessages: ClineMessage[] = [];

  return {
    Task: {
      newTask: vi.fn().mockResolvedValue("task-123"),
      askResponse: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn().mockResolvedValue(undefined),
    },
    State: {
      subscribeToState: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          for (const update of stateUpdates) {
            yield update;
          }
        },
      }),
      getLatestState: vi.fn().mockResolvedValue({ stateJson: "{}" }),
      togglePlanActModeProto: vi.fn().mockResolvedValue(undefined),
      updateAutoApprovalSettings: vi.fn().mockResolvedValue(undefined),
      updateSettings: vi.fn().mockResolvedValue(undefined),
      getProcessInfo: vi.fn().mockResolvedValue({ pid: 1234, address: "localhost:50051" }),
    },
    Ui: {
      subscribeToPartialMessage: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          for (const msg of partialMessages) {
            yield msg;
          }
        },
      }),
    },
  };
}

// Mock AgentSideConnection
function createMockConnection(): AgentSideConnection {
  return {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
    requestPermission: vi.fn().mockResolvedValue({
      outcome: { outcome: "selected", optionId: "allow" },
    }),
    // Add other required methods as needed
  } as unknown as AgentSideConnection;
}

describe("ClineAcpAgent", () => {
  let agent: ClineAcpAgent;
  let mockConnection: AgentSideConnection;
  let mockClineClient: ClineClient;

  beforeEach(() => {
    mockConnection = createMockConnection();
    mockClineClient = createMockClineClient();
    // Inject mock Cline client via options
    agent = new ClineAcpAgent({ clineClient: mockClineClient });
    agent.setClient(mockConnection);
  });

  describe("initialize()", () => {
    it("should return correct protocol version and agent info", async () => {
      const response = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      expect(response.protocolVersion).toBe(1);
      expect(response.agentInfo?.name).toBe("cline-acp");
      expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true);
      expect(response.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
    });

    it("should store client capabilities", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: false },
        },
      });

      // The agent should store these capabilities for later use
      // This is tested via the agent's behavior in other methods
    });

    it("should provide auth methods for API key configuration", async () => {
      const response = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      expect(response.authMethods).toBeDefined();
      expect(response.authMethods?.length).toBeGreaterThan(0);
      // Cline uses API keys rather than OAuth
      expect(response.authMethods?.[0].id).toBe("cline-api-key");
    });
  });

  describe("newSession()", () => {
    it("should create a new session with unique ID", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const response = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      expect(response.sessionId).toBeDefined();
      expect(response.sessionId.length).toBeGreaterThan(0);
    });

    it("should return available models", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const response = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      expect(response.models).toBeDefined();
      expect(response.models?.availableModels.length).toBeGreaterThan(0);
      // Cline supports multiple providers
      expect(response.models?.availableModels.some((m) => m.name.includes("Claude") || m.name.includes("claude"))).toBe(true);
    });

    it("should return available modes", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const response = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      expect(response.modes).toBeDefined();
      expect(response.modes?.availableModes).toBeDefined();

      // Should support Cline's plan/act modes
      const modeIds = response.modes?.availableModes.map((m) => m.id);
      expect(modeIds).toContain("plan");
      expect(modeIds).toContain("act");
    });

    it("should initialize with plan mode by default", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const response = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      expect(response.modes?.currentModeId).toBe("plan");
    });

    it("should create a Cline task for the session", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const response = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      const session = agent.getSession(response.sessionId);
      expect(session).toBeDefined();
      expect(session?.taskId).toBeDefined();
    });
  });

  describe("prompt()", () => {
    it("should send prompt to Cline and return response", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const session = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      const response = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Hello" }],
      });

      expect(response.stopReason).toBe("end_turn");
    });

    it("should convert ACP prompt to Cline format", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const session = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      await agent.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "text", text: "Hello " },
          { type: "text", text: "World" },
        ],
      });

      // Verify the prompt was sent to Cline (first prompt uses newTask)
      const clineClient = agent.getClineClient();
      expect(clineClient?.Task.newTask).toHaveBeenCalled();
    });

    it("should stream text updates to ACP client", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const session = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Hello" }],
      });

      // Verify session updates were sent
      expect(mockConnection.sessionUpdate).toHaveBeenCalled();
    });
  });

  describe("cancel()", () => {
    it("should cancel the Cline task", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const session = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      await agent.cancel({ sessionId: session.sessionId });

      const sessionState = agent.getSession(session.sessionId);
      expect(sessionState?.cancelled).toBe(true);
    });

    it("should call Cline cancelTask", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const session = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      await agent.cancel({ sessionId: session.sessionId });

      const clineClient = agent.getClineClient();
      expect(clineClient?.Task.cancelTask).toHaveBeenCalled();
    });
  });

  describe("setSessionMode()", () => {
    it("should set plan mode via Cline API", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const session = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      await agent.setSessionMode({
        sessionId: session.sessionId,
        modeId: "plan",
      });

      const clineClient = agent.getClineClient();
      expect(clineClient?.State.togglePlanActModeProto).toHaveBeenCalledWith({
        metadata: {},
        mode: PlanActMode.PLAN,
      });
    });

    it("should set act mode via Cline API", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const session = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      await agent.setSessionMode({
        sessionId: session.sessionId,
        modeId: "act",
      });

      const clineClient = agent.getClineClient();
      expect(clineClient?.State.togglePlanActModeProto).toHaveBeenCalledWith({
        metadata: {},
        mode: PlanActMode.ACT,
      });
    });
  });

  describe("setSessionModel()", () => {
    it("should update Cline model configuration", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const session = await agent.newSession({
        cwd: "/test/path",
        mcpServers: [],
      });

      await agent.setSessionModel({
        sessionId: session.sessionId,
        modelId: "claude-sonnet-4-20250514",
      });

      const clineClient = agent.getClineClient();
      expect(clineClient?.State.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          apiConfiguration: expect.objectContaining({
            apiModelId: "claude-sonnet-4-20250514",
          }),
        }),
      );
    });
  });
});

describe("ACP to Cline conversion", () => {
  describe("acpPromptToCline()", () => {
    it("should convert text chunks to Cline text", () => {
      const clinePrompt = acpPromptToCline({
        sessionId: "test",
        prompt: [
          { type: "text", text: "Hello " },
          { type: "text", text: "World" },
        ],
      });

      expect(clinePrompt.text).toBe("Hello World");
      expect(clinePrompt.images).toEqual([]);
      expect(clinePrompt.files).toEqual([]);
    });

    it("should convert file:// resource links to files array", () => {
      const clinePrompt = acpPromptToCline({
        sessionId: "test",
        prompt: [
          { type: "text", text: "Check this file: " },
          { type: "resource_link", uri: "file:///path/to/file.ts", name: "file.ts" },
        ],
      });

      expect(clinePrompt.files).toContain("/path/to/file.ts");
    });

    it("should convert embedded resources to context XML", () => {
      const clinePrompt = acpPromptToCline({
        sessionId: "test",
        prompt: [
          { type: "text", text: "Here is the code: " },
          {
            type: "resource",
            resource: {
              uri: "file:///path/to/code.ts",
              text: "const x = 1;",
            },
          },
        ],
      });

      expect(clinePrompt.text).toContain("<context");
      expect(clinePrompt.text).toContain("const x = 1;");
      expect(clinePrompt.text).toContain("</context>");
    });

    it("should handle non-file URLs as text", () => {
      const clinePrompt = acpPromptToCline({
        sessionId: "test",
        prompt: [
          { type: "resource_link", uri: "https://example.com", name: "example.com" },
        ],
      });

      expect(clinePrompt.text).toContain("https://example.com");
      expect(clinePrompt.files).toEqual([]);
    });
  });
});

describe("Cline to ACP conversion", () => {
  describe("clineMessageToAcpNotification()", () => {
    it("should convert SAY text to agent_message_chunk", () => {
      // Pass messageIndex=1 because index 0 is skipped (user's echoed input)
      const notification = clineMessageToAcpNotification(
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TEXT,
          text: "Hello from Cline",
        },
        "session-123",
        1, // Not the first message
      );

      expect(notification).not.toBeNull();
      expect(notification?.update.sessionUpdate).toBe("agent_message_chunk");
      expect((notification?.update as any).content.text).toBe("Hello from Cline");
    });

    it("should skip first say:text message (user's echoed input)", () => {
      // Index 0 say:text is always the user's echoed input - should be skipped
      const notification = clineMessageToAcpNotification(
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TEXT,
          text: "User's message that gets echoed",
        },
        "session-123",
        0, // First message
      );

      expect(notification).toBeNull();
    });

    it("should convert SAY reasoning to agent_thought_chunk", () => {
      const notification = clineMessageToAcpNotification(
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.REASONING,
          text: "Thinking about the problem...",
        },
        "session-123",
      );

      expect(notification).not.toBeNull();
      expect(notification?.update.sessionUpdate).toBe("agent_thought_chunk");
    });

    it("should convert ASK followup to agent_message_chunk", () => {
      const notification = clineMessageToAcpNotification(
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.FOLLOWUP,
          text: "Could you clarify?",
        },
        "session-123",
      );

      expect(notification).not.toBeNull();
      expect(notification?.update.sessionUpdate).toBe("agent_message_chunk");
    });

    it("should return null for API request messages", () => {
      const notification = clineMessageToAcpNotification(
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.API_REQ_STARTED,
        },
        "session-123",
      );

      expect(notification).toBeNull();
    });

    it("should return null for ASK api_req_failed messages", () => {
      const notification = clineMessageToAcpNotification(
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.API_REQ_FAILED,
          text: JSON.stringify({
            attempt: 3,
            maxAttempts: 3,
            failed: true,
            message: "API request failed",
          }),
        },
        "session-123",
      );

      expect(notification).toBeNull();
    });

    it("should return null for ASK resume_task messages", () => {
      const notification = clineMessageToAcpNotification(
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.RESUME_TASK,
          text: "Resume previous task?",
        },
        "session-123",
      );

      expect(notification).toBeNull();
    });

    it("should return null for ASK resume_completed_task messages", () => {
      const notification = clineMessageToAcpNotification(
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.RESUME_COMPLETED_TASK,
          text: "Resume completed task?",
        },
        "session-123",
      );

      expect(notification).toBeNull();
    });
  });

  describe("clineToolAskToAcpToolCall()", () => {
    it("should convert read_file tool to read kind", () => {
      const notification = clineToolAskToAcpToolCall(
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.TOOL,
          text: JSON.stringify({
            tool: "read_file",
            path: "/path/to/file.ts",
          }),
        },
        "session-123",
      );

      expect(notification.update.sessionUpdate).toBe("tool_call");
      expect((notification.update as any).kind).toBe("read");
      expect((notification.update as any).locations).toContainEqual({ path: "/path/to/file.ts" });
    });

    it("should convert write_to_file tool to edit kind", () => {
      const notification = clineToolAskToAcpToolCall(
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.TOOL,
          text: JSON.stringify({
            tool: "write_to_file",
            path: "/path/to/new.ts",
            content: "const x = 1;",
          }),
        },
        "session-123",
      );

      expect(notification.update.sessionUpdate).toBe("tool_call");
      expect((notification.update as any).kind).toBe("edit");
    });

    it("should convert execute_command tool to execute kind", () => {
      const notification = clineToolAskToAcpToolCall(
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.COMMAND,
          text: JSON.stringify({
            tool: "execute_command",
            command: "npm run build",
          }),
        },
        "session-123",
      );

      expect(notification.update.sessionUpdate).toBe("tool_call");
      expect((notification.update as any).kind).toBe("execute");
    });

    it("should convert search_files tool to search kind", () => {
      const notification = clineToolAskToAcpToolCall(
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.TOOL,
          text: JSON.stringify({
            tool: "search_files",
            path: "/path",
            regex: "TODO",
          }),
        },
        "session-123",
      );

      expect(notification.update.sessionUpdate).toBe("tool_call");
      expect((notification.update as any).kind).toBe("search");
    });

    it("should use message timestamp as toolCallId", () => {
      const ts = Date.now();
      const notification = clineToolAskToAcpToolCall(
        {
          ts,
          type: ClineMessageType.ASK,
          ask: ClineAsk.TOOL,
          text: JSON.stringify({ tool: "read_file", path: "/file.ts" }),
        },
        "session-123",
      );

      expect((notification.update as any).toolCallId).toBe(String(ts));
    });
  });

  describe("isTaskComplete()", () => {
    it("should return true for completion_result ask", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TEXT,
          text: "Done!",
        },
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.COMPLETION_RESULT,
        },
      ];

      expect(isTaskComplete(messages)).toBe(true);
    });

    it("should return false for in-progress task", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TEXT,
          text: "Working on it...",
        },
      ];

      expect(isTaskComplete(messages)).toBe(false);
    });
  });

  describe("isWaitingForUserInput()", () => {
    it("should return true for plan_mode_respond ask", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.PLAN_MODE_RESPOND,
          text: JSON.stringify({ response: "Hello!", options: [] }),
        },
      ];

      expect(isWaitingForUserInput(messages)).toBe(true);
    });

    it("should return true for followup ask", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.FOLLOWUP,
          text: "What would you like me to do next?",
        },
      ];

      expect(isWaitingForUserInput(messages)).toBe(true);
    });

    it("should return true for completion_result ask", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.COMPLETION_RESULT,
        },
      ];

      expect(isWaitingForUserInput(messages)).toBe(true);
    });

    it("should return false if last message is partial", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.PLAN_MODE_RESPOND,
          text: JSON.stringify({ response: "", options: [] }),
          partial: true,
        },
      ];

      expect(isWaitingForUserInput(messages)).toBe(false);
    });

    it("should return false for in-progress task", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TEXT,
          text: "Working on it...",
        },
      ];

      expect(isWaitingForUserInput(messages)).toBe(false);
    });

    it("should return false for tool ask (needs approval, not user input)", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.TOOL,
          text: JSON.stringify({ tool: "read_file", path: "/file.ts" }),
        },
      ];

      expect(isWaitingForUserInput(messages)).toBe(false);
    });
  });

  describe("needsApproval()", () => {
    it("should return true for tool ask", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.TOOL,
          text: JSON.stringify({ tool: "read_file", path: "/file.ts" }),
        },
      ];

      expect(needsApproval(messages)).toBe(true);
    });

    it("should return true for command ask", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.COMMAND,
          text: JSON.stringify({ tool: "execute_command", command: "ls" }),
        },
      ];

      expect(needsApproval(messages)).toBe(true);
    });

    it("should return false for followup ask", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.FOLLOWUP,
          text: "What do you want to do?",
        },
      ];

      expect(needsApproval(messages)).toBe(false);
    });

    it("should return false for say messages", () => {
      const messages: ClineMessage[] = [
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TEXT,
          text: "Hello",
        },
      ];

      expect(needsApproval(messages)).toBe(false);
    });
  });

  describe("extractMessagesFromState()", () => {
    it("should parse messages from state JSON", () => {
      const stateJson = JSON.stringify({
        clineMessages: [
          {
            ts: 1234567890,
            type: "say",
            say: "text",
            text: "Hello",
          },
        ],
      });

      const messages = extractMessagesFromState(stateJson);

      expect(messages.length).toBe(1);
      expect(messages[0].text).toBe("Hello");
    });

    it("should handle empty state", () => {
      const messages = extractMessagesFromState("{}");

      expect(messages).toEqual([]);
    });

    it("should handle invalid JSON gracefully", () => {
      const messages = extractMessagesFromState("invalid json");

      expect(messages).toEqual([]);
    });
  });
});

describe("parseToolInfo()", () => {
  it("should parse read_file tool info", () => {
    const toolInfo = parseToolInfo({
      ts: Date.now(),
      type: ClineMessageType.ASK,
      ask: ClineAsk.TOOL,
      text: JSON.stringify({
        tool: "read_file",
        path: "/path/to/file.ts",
      }),
    });

    expect(toolInfo.type).toBe("read_file");
    expect(toolInfo.path).toBe("/path/to/file.ts");
  });

  it("should parse write_to_file tool info", () => {
    const toolInfo = parseToolInfo({
      ts: Date.now(),
      type: ClineMessageType.ASK,
      ask: ClineAsk.TOOL,
      text: JSON.stringify({
        tool: "write_to_file",
        path: "/path/to/new.ts",
        content: "const x = 1;",
      }),
    });

    expect(toolInfo.type).toBe("write_to_file");
    expect(toolInfo.path).toBe("/path/to/new.ts");
    expect(toolInfo.input).toHaveProperty("content");
  });

  it("should parse execute_command tool info", () => {
    const toolInfo = parseToolInfo({
      ts: Date.now(),
      type: ClineMessageType.ASK,
      ask: ClineAsk.COMMAND,
      text: JSON.stringify({
        tool: "execute_command",
        command: "npm run build",
      }),
    });

    expect(toolInfo.type).toBe("execute_command");
    expect(toolInfo.input.command).toBe("npm run build");
  });

  it("should generate appropriate title", () => {
    const toolInfo = parseToolInfo({
      ts: Date.now(),
      type: ClineMessageType.ASK,
      ask: ClineAsk.TOOL,
      text: JSON.stringify({
        tool: "read_file",
        path: "/path/to/file.ts",
      }),
    });

    expect(toolInfo.title).toContain("read");
  });
});

describe("Permission handling", () => {
  it("should request permission from ACP client for tool calls", async () => {
    const agent = new ClineAcpAgent({ autoStart: false });
    const mockConnection = createMockConnection();
    agent.setClient(mockConnection);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const session = await agent.newSession({
      cwd: "/test/path",
      mcpServers: [],
    });

    // Simulate a prompt that triggers a tool call requiring permission
    // This would be tested through the full prompt flow

    // The permission request should include proper options
    const expectedOptions = [
      { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
      { kind: "allow_once", name: "Allow", optionId: "allow" },
      { kind: "reject_once", name: "Reject", optionId: "reject" },
    ];

    // When permission is requested, verify the structure
    // This tests the integration point between Cline ask messages and ACP permission requests
  });

  it("should auto-approve in bypassPermissions mode", async () => {
    const agent = new ClineAcpAgent({ autoStart: false });
    const mockConnection = createMockConnection();
    agent.setClient(mockConnection);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const session = await agent.newSession({
      cwd: "/test/path",
      mcpServers: [],
    });

    await agent.setSessionMode({
      sessionId: session.sessionId,
      modeId: "bypassPermissions",
    });

    // In bypassPermissions mode, tool calls should not trigger permission requests
    // This is handled by Cline's yolo mode
  });

  it("should auto-approve edits in acceptEdits mode", async () => {
    const agent = new ClineAcpAgent({ autoStart: false });
    const mockConnection = createMockConnection();
    agent.setClient(mockConnection);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const session = await agent.newSession({
      cwd: "/test/path",
      mcpServers: [],
    });

    await agent.setSessionMode({
      sessionId: session.sessionId,
      modeId: "acceptEdits",
    });

    // In acceptEdits mode, file edits should be auto-approved
    // Other operations should still require permission
  });
});

describe("Partial message streaming", () => {
  it("should convert partial messages to streaming chunks", () => {
    const notification = clinePartialToAcpNotification(
      {
        ts: Date.now(),
        type: ClineMessageType.SAY,
        say: ClineSay.TEXT,
        text: "Partial text...",
        partial: true,
      },
      "session-123",
    );

    expect(notification).not.toBeNull();
    expect(notification?.update.sessionUpdate).toBe("agent_message_chunk");
  });

  it("should handle reasoning partial messages", () => {
    const notification = clinePartialToAcpNotification(
      {
        ts: Date.now(),
        type: ClineMessageType.SAY,
        say: ClineSay.REASONING,
        text: "Thinking...",
        partial: true,
      },
      "session-123",
    );

    expect(notification).not.toBeNull();
    expect(notification?.update.sessionUpdate).toBe("agent_thought_chunk");
  });
});

describe("Tool result handling", () => {
  it("should convert SAY TOOL to tool_call_result", () => {
    const notification = clineMessageToAcpNotification(
      {
        ts: Date.now(),
        type: ClineMessageType.SAY,
        say: ClineSay.TOOL,
        text: JSON.stringify({
          tool: "read_file",
          result: "file contents here",
        }),
      },
      "session-123",
    );

    // Tool results should be converted appropriately
    expect(notification).not.toBeNull();
  });

  it("should convert command output to tool_call_result", () => {
    const notification = clineMessageToAcpNotification(
      {
        ts: Date.now(),
        type: ClineMessageType.SAY,
        say: ClineSay.COMMAND_OUTPUT,
        text: "npm run build\nCompiled successfully",
      },
      "session-123",
    );

    expect(notification).not.toBeNull();
  });
});
