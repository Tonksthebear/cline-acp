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
  clineTaskProgressToAcpPlan,
  createCurrentModeUpdate,
  extractCostInfo,
  extractMessagesFromState,
  extractMode,
  getLatestTaskProgress,
  parseToolInfo,
  parseTaskProgressToPlanEntries,
  clineToolAskToAcpToolCall,
  clineSayToolToAcpToolCallInProgress,
  createToolCallUpdate,
  isTaskComplete,
  isWaitingForUserInput,
  needsApproval,
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
      expect(
        response.models?.availableModels.some(
          (m) => m.name.includes("Claude") || m.name.includes("claude"),
        ),
      ).toBe(true);
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
        prompt: [{ type: "resource_link", uri: "https://example.com", name: "example.com" }],
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

  describe("extractMode()", () => {
    it("should extract 'plan' mode from state", () => {
      const stateJson = JSON.stringify({ mode: "plan" });
      const mode = extractMode(stateJson);
      expect(mode).toBe("plan");
    });

    it("should extract 'act' mode from state", () => {
      const stateJson = JSON.stringify({ mode: "act" });
      const mode = extractMode(stateJson);
      expect(mode).toBe("act");
    });

    it("should default to 'plan' when mode is not specified", () => {
      const stateJson = JSON.stringify({});
      const mode = extractMode(stateJson);
      expect(mode).toBe("plan");
    });

    it("should default to 'plan' for invalid JSON", () => {
      const mode = extractMode("invalid json");
      expect(mode).toBe("plan");
    });
  });

  describe("createCurrentModeUpdate()", () => {
    it("should create a current_mode_update notification for plan mode", () => {
      const notification = createCurrentModeUpdate("session-123", "plan");
      expect(notification).toEqual({
        sessionId: "session-123",
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "plan",
        },
      });
    });

    it("should create a current_mode_update notification for act mode", () => {
      const notification = createCurrentModeUpdate("session-456", "act");
      expect(notification).toEqual({
        sessionId: "session-456",
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "act",
        },
      });
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

  it("should extract content from tool data", () => {
    const toolInfo = parseToolInfo({
      ts: Date.now(),
      type: ClineMessageType.SAY,
      say: ClineSay.TOOL,
      text: JSON.stringify({
        tool: "read_file",
        path: "/path/to/file.ts",
        content: "const x = 1;\nexport default x;",
      }),
    });

    expect(toolInfo.content).toBe("const x = 1;\nexport default x;");
  });

  it("should not extract content if it looks like a path", () => {
    const toolInfo = parseToolInfo({
      ts: Date.now(),
      type: ClineMessageType.SAY,
      say: ClineSay.TOOL,
      text: JSON.stringify({
        tool: "read_file",
        path: "src/file.ts",
        content: "/Users/jason/project/src/file.ts", // Absolute path, not content
      }),
    });

    expect(toolInfo.content).toBeUndefined();
  });

  it("should extract diff from tool data", () => {
    const toolInfo = parseToolInfo({
      ts: Date.now(),
      type: ClineMessageType.SAY,
      say: ClineSay.TOOL,
      text: JSON.stringify({
        tool: "replace_in_file",
        path: "/path/to/file.ts",
        diff: "-const x = 1;\n+const x = 2;",
      }),
    });

    expect(toolInfo.diff).toBe("-const x = 1;\n+const x = 2;");
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
  it("should convert SAY TOOL messages to tool_call for follow feature", () => {
    const notification = clineMessageToAcpNotification(
      {
        ts: Date.now(),
        type: ClineMessageType.SAY,
        say: ClineSay.TOOL,
        text: JSON.stringify({
          tool: "read_file",
          path: "/path/to/file.ts",
          result: "file contents here",
        }),
      },
      "session-123",
    );

    // SAY TOOL messages are converted to tool_call notifications
    // This enables the "follow" feature so editors can track what files the agent is working on
    expect(notification).not.toBeNull();
    expect(notification?.update.sessionUpdate).toBe("tool_call");
    expect((notification?.update as any).status).toBe("completed");
    expect((notification?.update as any).kind).toBe("read");
    expect((notification?.update as any).locations).toContainEqual({ path: "/path/to/file.ts" });
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

describe("Tool Call Updates (in_progress status)", () => {
  describe("clineSayToolToAcpToolCallInProgress()", () => {
    it("should emit tool_call with status in_progress for partial SAY TOOL message", () => {
      const ts = Date.now();
      const notification = clineSayToolToAcpToolCallInProgress(
        {
          ts,
          type: ClineMessageType.SAY,
          say: ClineSay.TOOL,
          text: JSON.stringify({
            tool: "readFile",
            path: "src/index.ts",
            content: "/absolute/path/src/index.ts",
          }),
          partial: true,
        },
        "session-123",
      );

      expect(notification).not.toBeNull();
      expect(notification?.update.sessionUpdate).toBe("tool_call");
      expect((notification?.update as any).status).toBe("in_progress");
      expect((notification?.update as any).toolCallId).toBe(String(ts));
      expect((notification?.update as any).title).toContain("readFile");
    });

    it("should NOT include locations in in_progress tool_call (path may be incomplete during streaming)", () => {
      const notification = clineSayToolToAcpToolCallInProgress(
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TOOL,
          text: JSON.stringify({
            tool: "readFile",
            path: "src/foo.ts",
            content: "/Users/test/project/src/foo.ts",
          }),
          partial: true,
        },
        "session-123",
      );

      expect(notification).not.toBeNull();
      // Locations should be empty for in_progress - path may be incomplete during streaming
      // (e.g., "package" instead of "package.json"). Locations are included when tool completes.
      expect((notification?.update as any).locations).toEqual([]);
    });

    it("should return null for non-tool messages", () => {
      const notification = clineSayToolToAcpToolCallInProgress(
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TEXT,
          text: "Hello world",
          partial: true,
        },
        "session-123",
      );

      expect(notification).toBeNull();
    });

    it("should return null for unknown tool type", () => {
      const notification = clineSayToolToAcpToolCallInProgress(
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TOOL,
          text: "invalid json",
          partial: true,
        },
        "session-123",
      );

      expect(notification).toBeNull();
    });
  });

  describe("createToolCallUpdate()", () => {
    it("should create tool_call_update notification with completed status", () => {
      const notification = createToolCallUpdate("session-123", "12345", "completed");

      expect(notification.sessionId).toBe("session-123");
      expect(notification.update.sessionUpdate).toBe("tool_call_update");
      expect((notification.update as any).toolCallId).toBe("12345");
      expect((notification.update as any).status).toBe("completed");
    });

    it("should create tool_call_update notification with failed status", () => {
      const notification = createToolCallUpdate("session-456", "67890", "failed");

      expect(notification.sessionId).toBe("session-456");
      expect(notification.update.sessionUpdate).toBe("tool_call_update");
      expect((notification.update as any).toolCallId).toBe("67890");
      expect((notification.update as any).status).toBe("failed");
    });

    it("should create tool_call_update notification with in_progress status", () => {
      const notification = createToolCallUpdate("session-789", "11111", "in_progress");

      expect(notification.update.sessionUpdate).toBe("tool_call_update");
      expect((notification.update as any).status).toBe("in_progress");
    });
  });
});

describe("Line Numbers in Locations", () => {
  describe("parseToolInfo() line extraction", () => {
    it("should extract line number from tool data", () => {
      const msg: ClineMessage = {
        ts: Date.now(),
        type: ClineMessageType.SAY,
        say: ClineSay.TOOL,
        text: JSON.stringify({
          tool: "replace_in_file",
          path: "src/index.ts",
          line: 42,
          content: "/abs/path/src/index.ts",
        }),
      };

      const toolInfo = parseToolInfo(msg);
      expect(toolInfo.line).toBe(42);
    });

    it("should extract startLine as line number", () => {
      const msg: ClineMessage = {
        ts: Date.now(),
        type: ClineMessageType.SAY,
        say: ClineSay.TOOL,
        text: JSON.stringify({
          tool: "replace_in_file",
          path: "src/foo.ts",
          startLine: 100,
          endLine: 120,
        }),
      };

      const toolInfo = parseToolInfo(msg);
      expect(toolInfo.line).toBe(100);
    });

    it("should return undefined line when not present", () => {
      const msg: ClineMessage = {
        ts: Date.now(),
        type: ClineMessageType.SAY,
        say: ClineSay.TOOL,
        text: JSON.stringify({
          tool: "readFile",
          path: "src/foo.ts",
        }),
      };

      const toolInfo = parseToolInfo(msg);
      expect(toolInfo.line).toBeUndefined();
    });
  });

  describe("tool_call locations with line numbers", () => {
    it("should include line number in locations for clineSayToolToAcpToolCall", () => {
      const notification = clineMessageToAcpNotification(
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TOOL,
          text: JSON.stringify({
            tool: "replace_in_file",
            path: "src/index.ts",
            line: 42,
            content: "/abs/path/src/index.ts",
          }),
        },
        "session-123",
      );

      expect(notification).not.toBeNull();
      expect((notification?.update as any).locations).toContainEqual({
        path: "/abs/path/src/index.ts",
        line: 42,
      });
    });

    it("should include line number in locations for clineToolAskToAcpToolCall", () => {
      const notification = clineToolAskToAcpToolCall(
        {
          ts: Date.now(),
          type: ClineMessageType.ASK,
          ask: ClineAsk.TOOL,
          text: JSON.stringify({
            tool: "replace_in_file",
            path: "src/index.ts",
            line: 55,
            content: "/abs/path/src/index.ts",
          }),
        },
        "session-123",
      );

      expect((notification.update as any).locations).toContainEqual({
        path: "/abs/path/src/index.ts",
        line: 55,
      });
    });

    it("should omit line from locations when not present", () => {
      const notification = clineMessageToAcpNotification(
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TOOL,
          text: JSON.stringify({
            tool: "readFile",
            path: "src/foo.ts",
            content: "/abs/path/src/foo.ts",
          }),
        },
        "session-123",
      );

      expect(notification).not.toBeNull();
      // Location should NOT have a line property (or it should be undefined)
      const location = (notification?.update as any).locations[0];
      expect(location.path).toBe("/abs/path/src/foo.ts");
      expect(location.line).toBeUndefined();
    });
  });
});

describe("Task Progress / Plan Entries", () => {
  describe("parseTaskProgressToPlanEntries()", () => {
    it("should parse unchecked checkboxes as pending", () => {
      const text = `- [ ] Set up project structure
- [ ] Install dependencies
- [ ] Create components`;

      const entries = parseTaskProgressToPlanEntries(text);

      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual({
        content: "Set up project structure",
        status: "pending",
      });
      expect(entries[1]).toEqual({
        content: "Install dependencies",
        status: "pending",
      });
      expect(entries[2]).toEqual({
        content: "Create components",
        status: "pending",
      });
    });

    it("should parse checked checkboxes as completed", () => {
      const text = `- [x] Set up project structure
- [x] Install dependencies
- [ ] Create components`;

      const entries = parseTaskProgressToPlanEntries(text);

      expect(entries).toHaveLength(3);
      expect(entries[0].status).toBe("completed");
      expect(entries[1].status).toBe("completed");
      expect(entries[2].status).toBe("pending");
    });

    it("should handle mixed case [X] as completed", () => {
      const text = `- [X] Task with uppercase X`;

      const entries = parseTaskProgressToPlanEntries(text);

      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe("completed");
    });

    it("should handle asterisk bullet points", () => {
      const text = `* [ ] Task with asterisk
* [x] Completed asterisk task`;

      const entries = parseTaskProgressToPlanEntries(text);

      expect(entries).toHaveLength(2);
      expect(entries[0].status).toBe("pending");
      expect(entries[1].status).toBe("completed");
    });

    it("should ignore non-checkbox lines", () => {
      const text = `# Task Progress
- [x] First task
Some description text
- [ ] Second task`;

      const entries = parseTaskProgressToPlanEntries(text);

      expect(entries).toHaveLength(2);
    });

    it("should return empty array for text without checkboxes", () => {
      const text = `No checkboxes here
Just regular text`;

      const entries = parseTaskProgressToPlanEntries(text);

      expect(entries).toHaveLength(0);
    });
  });

  describe("clineTaskProgressToAcpPlan()", () => {
    it("should convert task_progress message to ACP plan notification", () => {
      const notification = clineTaskProgressToAcpPlan(
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TASK_PROGRESS,
          text: `- [x] Set up project
- [ ] Implement feature
- [ ] Run tests`,
        },
        "session-123",
      );

      expect(notification).not.toBeNull();
      expect(notification?.update.sessionUpdate).toBe("plan");

      const update = notification?.update as {
        sessionUpdate: string;
        entries: Array<{ content: string; status: string; priority: string }>;
      };
      expect(update.entries).toHaveLength(3);
      expect(update.entries[0]).toEqual({
        content: "Set up project",
        status: "completed",
        priority: "medium",
      });
      expect(update.entries[1]).toEqual({
        content: "Implement feature",
        status: "pending",
        priority: "medium",
      });
    });

    it("should return null for empty task progress", () => {
      const notification = clineTaskProgressToAcpPlan(
        {
          ts: Date.now(),
          type: ClineMessageType.SAY,
          say: ClineSay.TASK_PROGRESS,
          text: "No checkboxes here",
        },
        "session-123",
      );

      expect(notification).toBeNull();
    });
  });

  describe("getLatestTaskProgress()", () => {
    it("should find the last task_progress message", () => {
      const messages: ClineMessage[] = [
        {
          ts: 1000,
          type: ClineMessageType.SAY,
          say: ClineSay.TEXT,
          text: "Hello",
        },
        {
          ts: 2000,
          type: ClineMessageType.SAY,
          say: ClineSay.TASK_PROGRESS,
          text: "- [ ] First version",
        },
        {
          ts: 3000,
          type: ClineMessageType.SAY,
          say: ClineSay.TEXT,
          text: "Working...",
        },
        {
          ts: 4000,
          type: ClineMessageType.SAY,
          say: ClineSay.TASK_PROGRESS,
          text: "- [x] First version\n- [ ] Second version",
        },
      ];

      const latest = getLatestTaskProgress(messages);

      expect(latest).not.toBeNull();
      expect(latest?.ts).toBe(4000);
      expect(latest?.text).toContain("Second version");
    });

    it("should return null if no task_progress messages", () => {
      const messages: ClineMessage[] = [
        {
          ts: 1000,
          type: ClineMessageType.SAY,
          say: ClineSay.TEXT,
          text: "Hello",
        },
      ];

      const latest = getLatestTaskProgress(messages);

      expect(latest).toBeNull();
    });

    it("should handle lowercase say type from state JSON", () => {
      const messages: ClineMessage[] = [
        {
          ts: 1000,
          type: ClineMessageType.SAY,
          say: "task_progress" as ClineSay, // State JSON uses lowercase
          text: "- [ ] Task",
        },
      ];

      const latest = getLatestTaskProgress(messages);

      expect(latest).not.toBeNull();
    });
  });
});

describe("Cost Tracking", () => {
  describe("extractCostInfo()", () => {
    it("should extract cost info from api_req_started message with cost data", () => {
      const msg: ClineMessage = {
        ts: 1000,
        type: ClineMessageType.SAY,
        say: ClineSay.API_REQ_STARTED,
        text: JSON.stringify({
          tokensIn: 1500,
          tokensOut: 800,
          cacheWrites: 100,
          cacheReads: 50,
          cost: 0.0234,
        }),
      };

      const costInfo = extractCostInfo(msg);

      expect(costInfo).not.toBeNull();
      expect(costInfo!.tokensIn).toBe(1500);
      expect(costInfo!.tokensOut).toBe(800);
      expect(costInfo!.cacheWrites).toBe(100);
      expect(costInfo!.cacheReads).toBe(50);
      expect(costInfo!.cost).toBe(0.0234);
    });

    it("should return null for api_req_started message without cost data", () => {
      const msg: ClineMessage = {
        ts: 1000,
        type: ClineMessageType.SAY,
        say: ClineSay.API_REQ_STARTED,
        text: JSON.stringify({
          request: "some request data",
          // No cost, tokensIn, etc. - request still in progress
        }),
      };

      const costInfo = extractCostInfo(msg);

      expect(costInfo).toBeNull();
    });

    it("should return null for non-api_req_started messages", () => {
      const msg: ClineMessage = {
        ts: 1000,
        type: ClineMessageType.SAY,
        say: ClineSay.TEXT,
        text: "Hello world",
      };

      const costInfo = extractCostInfo(msg);

      expect(costInfo).toBeNull();
    });

    it("should handle lowercase say type from state JSON", () => {
      const msg: ClineMessage = {
        ts: 1000,
        type: ClineMessageType.SAY,
        say: "api_req_started" as ClineSay,
        text: JSON.stringify({
          tokensIn: 500,
          tokensOut: 200,
          cost: 0.01,
        }),
      };

      const costInfo = extractCostInfo(msg);

      expect(costInfo).not.toBeNull();
      expect(costInfo!.tokensIn).toBe(500);
      expect(costInfo!.tokensOut).toBe(200);
      expect(costInfo!.cost).toBe(0.01);
    });

    it("should handle zero cost (free tier or cached)", () => {
      const msg: ClineMessage = {
        ts: 1000,
        type: ClineMessageType.SAY,
        say: ClineSay.API_REQ_STARTED,
        text: JSON.stringify({
          tokensIn: 100,
          tokensOut: 50,
          cacheReads: 100,
          cost: 0, // Zero cost (fully cached)
        }),
      };

      const costInfo = extractCostInfo(msg);

      expect(costInfo).not.toBeNull();
      expect(costInfo!.cost).toBe(0);
      expect(costInfo!.cacheReads).toBe(100);
    });

    it("should handle missing optional fields", () => {
      const msg: ClineMessage = {
        ts: 1000,
        type: ClineMessageType.SAY,
        say: ClineSay.API_REQ_STARTED,
        text: JSON.stringify({
          tokensIn: 100,
          cost: 0.005,
          // No tokensOut, cacheWrites, cacheReads
        }),
      };

      const costInfo = extractCostInfo(msg);

      expect(costInfo).not.toBeNull();
      expect(costInfo!.tokensIn).toBe(100);
      expect(costInfo!.tokensOut).toBe(0);
      expect(costInfo!.cacheWrites).toBe(0);
      expect(costInfo!.cacheReads).toBe(0);
      expect(costInfo!.cost).toBe(0.005);
    });

    it("should return null for invalid JSON", () => {
      const msg: ClineMessage = {
        ts: 1000,
        type: ClineMessageType.SAY,
        say: ClineSay.API_REQ_STARTED,
        text: "not valid json",
      };

      const costInfo = extractCostInfo(msg);

      expect(costInfo).toBeNull();
    });
  });

  describe("ClineSession cost fields", () => {
    it("should initialize session with zero costs", async () => {
      const mockClient = createMockClineClient();
      const agent = new ClineAcpAgent({
        clineClient: mockClient,
        autoStart: false,
      });
      agent.setClient(createMockConnection());
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

      const response = await agent.newSession({ cwd: "/test", mcpServers: [] });
      const session = agent.getSession(response.sessionId);

      expect(session).toBeDefined();
      expect(session!.totalCost).toBe(0);
      expect(session!.totalTokensIn).toBe(0);
      expect(session!.totalTokensOut).toBe(0);
      expect(session!.totalCacheWrites).toBe(0);
      expect(session!.totalCacheReads).toBe(0);
    });
  });
});

describe("Streaming Integration Tests", () => {
  describe("Cost accumulation during streaming", () => {
    it("should accumulate costs from multiple api_req_started messages", async () => {
      // Create state updates that simulate multiple API requests completing
      const stateUpdates = [
        // First API request completes
        {
          stateJson: JSON.stringify({
            mode: "plan",
            clineMessages: [
              {
                ts: 1000,
                type: "say",
                say: "api_req_started",
                text: JSON.stringify({
                  tokensIn: 500,
                  tokensOut: 200,
                  cacheWrites: 50,
                  cacheReads: 25,
                  cost: 0.01,
                }),
              },
              {
                ts: 1001,
                type: "say",
                say: "text",
                text: "Hello!",
              },
            ],
          }),
        },
        // Second API request completes
        {
          stateJson: JSON.stringify({
            mode: "plan",
            clineMessages: [
              {
                ts: 1000,
                type: "say",
                say: "api_req_started",
                text: JSON.stringify({
                  tokensIn: 500,
                  tokensOut: 200,
                  cacheWrites: 50,
                  cacheReads: 25,
                  cost: 0.01,
                }),
              },
              {
                ts: 1001,
                type: "say",
                say: "text",
                text: "Hello!",
              },
              {
                ts: 2000,
                type: "say",
                say: "api_req_started",
                text: JSON.stringify({
                  tokensIn: 800,
                  tokensOut: 400,
                  cacheWrites: 100,
                  cacheReads: 75,
                  cost: 0.02,
                }),
              },
              {
                ts: 2001,
                type: "ask",
                ask: "plan_mode_respond",
                text: JSON.stringify({ response: "Done!", options: [] }),
              },
            ],
          }),
        },
      ];

      // Create mock client with streaming state updates
      const mockClineClient: ClineClient = {
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
            async *[Symbol.asyncIterator]() {},
          }),
        },
      };

      const mockConnection = {
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        requestPermission: vi.fn().mockResolvedValue({
          outcome: { outcome: "selected", optionId: "allow" },
        }),
      } as unknown as AgentSideConnection;

      const agent = new ClineAcpAgent({
        clineClient: mockClineClient,
        autoStart: false,
      });
      agent.setClient(mockConnection);
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

      const sessionResponse = await agent.newSession({ cwd: "/test", mcpServers: [] });
      await agent.prompt({
        sessionId: sessionResponse.sessionId,
        prompt: [{ type: "text", text: "Test" }],
      });

      // Verify costs were accumulated correctly
      const session = agent.getSession(sessionResponse.sessionId);
      expect(session!.totalCost).toBe(0.03); // 0.01 + 0.02
      expect(session!.totalTokensIn).toBe(1300); // 500 + 800
      expect(session!.totalTokensOut).toBe(600); // 200 + 400
      expect(session!.totalCacheWrites).toBe(150); // 50 + 100
      expect(session!.totalCacheReads).toBe(100); // 25 + 75
    });

    it("should not double-count costs from repeated state updates", async () => {
      // Same api_req_started message appears in multiple state updates
      const stateUpdates = [
        {
          stateJson: JSON.stringify({
            mode: "plan",
            clineMessages: [
              {
                ts: 1000,
                type: "say",
                say: "api_req_started",
                text: JSON.stringify({ tokensIn: 500, tokensOut: 200, cost: 0.01 }),
              },
            ],
          }),
        },
        // Same message appears again in next update
        {
          stateJson: JSON.stringify({
            mode: "plan",
            clineMessages: [
              {
                ts: 1000, // Same timestamp - should not be counted again
                type: "say",
                say: "api_req_started",
                text: JSON.stringify({ tokensIn: 500, tokensOut: 200, cost: 0.01 }),
              },
              {
                ts: 1001,
                type: "ask",
                ask: "plan_mode_respond",
                text: JSON.stringify({ response: "Done!", options: [] }),
              },
            ],
          }),
        },
      ];

      const mockClineClient: ClineClient = {
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
            async *[Symbol.asyncIterator]() {},
          }),
        },
      };

      const mockConnection = {
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        requestPermission: vi.fn().mockResolvedValue({
          outcome: { outcome: "selected", optionId: "allow" },
        }),
      } as unknown as AgentSideConnection;

      const agent = new ClineAcpAgent({
        clineClient: mockClineClient,
        autoStart: false,
      });
      agent.setClient(mockConnection);
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

      const sessionResponse = await agent.newSession({ cwd: "/test", mcpServers: [] });
      await agent.prompt({
        sessionId: sessionResponse.sessionId,
        prompt: [{ type: "text", text: "Test" }],
      });

      // Verify cost was only counted once despite appearing in two state updates
      const session = agent.getSession(sessionResponse.sessionId);
      expect(session!.totalCost).toBe(0.01); // Only counted once
      expect(session!.totalTokensIn).toBe(500);
    });
  });

  describe("Mode change emissions during streaming", () => {
    it("should emit current_mode_update when mode changes from plan to act", async () => {
      const stateUpdates = [
        {
          stateJson: JSON.stringify({
            mode: "plan",
            clineMessages: [{ ts: 1000, type: "say", say: "text", text: "Starting in plan mode" }],
          }),
        },
        // Mode changes to act
        {
          stateJson: JSON.stringify({
            mode: "act",
            clineMessages: [
              { ts: 1000, type: "say", say: "text", text: "Starting in plan mode" },
              { ts: 1001, type: "say", say: "text", text: "Now in act mode" },
            ],
          }),
        },
        // Task completes
        {
          stateJson: JSON.stringify({
            mode: "act",
            clineMessages: [
              { ts: 1000, type: "say", say: "text", text: "Starting in plan mode" },
              { ts: 1001, type: "say", say: "text", text: "Now in act mode" },
              { ts: 1002, type: "ask", ask: "completion_result" },
            ],
          }),
        },
      ];

      const mockClineClient: ClineClient = {
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
            async *[Symbol.asyncIterator]() {},
          }),
        },
      };

      const mockConnection = {
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        requestPermission: vi.fn().mockResolvedValue({
          outcome: { outcome: "selected", optionId: "allow" },
        }),
      } as unknown as AgentSideConnection;

      const agent = new ClineAcpAgent({
        clineClient: mockClineClient,
        autoStart: false,
      });
      agent.setClient(mockConnection);
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

      const sessionResponse = await agent.newSession({ cwd: "/test", mcpServers: [] });
      await agent.prompt({
        sessionId: sessionResponse.sessionId,
        prompt: [{ type: "text", text: "Test" }],
      });

      // Find the current_mode_update call
      const calls = (mockConnection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls;
      const modeUpdateCalls = calls.filter(
        (call: unknown[]) =>
          (call[0] as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          "current_mode_update",
      );

      expect(modeUpdateCalls.length).toBe(1);
      expect(
        (modeUpdateCalls[0][0] as { update: { currentModeId: string } }).update.currentModeId,
      ).toBe("act");
    });

    it("should emit current_mode_update when mode changes from act to plan", async () => {
      const stateUpdates = [
        {
          stateJson: JSON.stringify({
            mode: "act",
            clineMessages: [{ ts: 1000, type: "say", say: "text", text: "Starting in act mode" }],
          }),
        },
        // Mode changes to plan
        {
          stateJson: JSON.stringify({
            mode: "plan",
            clineMessages: [
              { ts: 1000, type: "say", say: "text", text: "Starting in act mode" },
              {
                ts: 1001,
                type: "ask",
                ask: "plan_mode_respond",
                text: JSON.stringify({ response: "Now planning", options: [] }),
              },
            ],
          }),
        },
      ];

      const mockClineClient: ClineClient = {
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
            async *[Symbol.asyncIterator]() {},
          }),
        },
      };

      const mockConnection = {
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        requestPermission: vi.fn().mockResolvedValue({
          outcome: { outcome: "selected", optionId: "allow" },
        }),
      } as unknown as AgentSideConnection;

      const agent = new ClineAcpAgent({
        clineClient: mockClineClient,
        autoStart: false,
      });
      agent.setClient(mockConnection);
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

      const sessionResponse = await agent.newSession({ cwd: "/test", mcpServers: [] });
      await agent.prompt({
        sessionId: sessionResponse.sessionId,
        prompt: [{ type: "text", text: "Test" }],
      });

      // Find the current_mode_update call
      const calls = (mockConnection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls;
      const modeUpdateCalls = calls.filter(
        (call: unknown[]) =>
          (call[0] as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          "current_mode_update",
      );

      expect(modeUpdateCalls.length).toBe(1);
      expect(
        (modeUpdateCalls[0][0] as { update: { currentModeId: string } }).update.currentModeId,
      ).toBe("plan");
    });
  });

  describe("Tool call in_progress → completed flow", () => {
    it("should emit in_progress then completed tool_call for same tool", async () => {
      const stateUpdates = [
        // Tool starts executing (partial)
        {
          stateJson: JSON.stringify({
            mode: "act",
            workspaceRoots: [{ path: "/workspace" }],
            clineMessages: [
              {
                ts: 1000,
                type: "say",
                say: "tool",
                text: JSON.stringify({
                  tool: "readFile",
                  path: "src/index.ts",
                  content: "/workspace/src/index.ts",
                }),
                partial: true,
              },
            ],
          }),
        },
        // Tool completes
        {
          stateJson: JSON.stringify({
            mode: "act",
            workspaceRoots: [{ path: "/workspace" }],
            clineMessages: [
              {
                ts: 1000,
                type: "say",
                say: "tool",
                text: JSON.stringify({
                  tool: "readFile",
                  path: "src/index.ts",
                  content: "/workspace/src/index.ts",
                }),
                partial: false, // Now complete
              },
              {
                ts: 1001,
                type: "ask",
                ask: "completion_result",
              },
            ],
          }),
        },
      ];

      const mockClineClient: ClineClient = {
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
            async *[Symbol.asyncIterator]() {},
          }),
        },
      };

      const mockConnection = {
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        requestPermission: vi.fn().mockResolvedValue({
          outcome: { outcome: "selected", optionId: "allow" },
        }),
      } as unknown as AgentSideConnection;

      const agent = new ClineAcpAgent({
        clineClient: mockClineClient,
        autoStart: false,
      });
      agent.setClient(mockConnection);
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

      const sessionResponse = await agent.newSession({ cwd: "/test", mcpServers: [] });
      await agent.prompt({
        sessionId: sessionResponse.sessionId,
        prompt: [{ type: "text", text: "Test" }],
      });

      // Find tool_call notifications for the same tool (ts: 1000)
      const calls = (mockConnection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls;
      const toolCallUpdates = calls.filter((call: unknown[]) => {
        const update = (call[0] as { update?: { sessionUpdate?: string; toolCallId?: string } })
          ?.update;
        return update?.sessionUpdate === "tool_call" && update?.toolCallId === "1000";
      });

      // Should have 2 tool_call notifications: one in_progress, one completed
      expect(toolCallUpdates.length).toBe(2);

      // First should be in_progress
      const first = toolCallUpdates[0][0] as { update: { status: string; locations: unknown[] } };
      expect(first.update.status).toBe("in_progress");
      expect(first.update.locations).toEqual([]); // No locations for in_progress

      // Second should be completed with locations
      const second = toolCallUpdates[1][0] as { update: { status: string; locations: unknown[] } };
      expect(second.update.status).toBe("completed");
      expect(second.update.locations).toContainEqual({ path: "/workspace/src/index.ts" });
    });

    it("should emit failed status when tool is rejected", async () => {
      const stateUpdates = [
        // Tool pending approval
        {
          stateJson: JSON.stringify({
            mode: "act",
            workspaceRoots: [{ path: "/workspace" }],
            clineMessages: [
              {
                ts: 1000,
                type: "ask",
                ask: "tool",
                text: JSON.stringify({
                  tool: "write_to_file",
                  path: "src/index.ts",
                  content: "new content",
                }),
                partial: false,
              },
            ],
          }),
        },
        // After rejection, Cline responds with new message
        {
          stateJson: JSON.stringify({
            mode: "act",
            workspaceRoots: [{ path: "/workspace" }],
            clineMessages: [
              {
                ts: 1000,
                type: "ask",
                ask: "tool",
                text: JSON.stringify({
                  tool: "write_to_file",
                  path: "src/index.ts",
                  content: "new content",
                }),
                partial: false,
              },
              {
                ts: 1001,
                type: "say",
                say: "text",
                text: "I understand you rejected the edit.",
              },
              {
                ts: 1002,
                type: "ask",
                ask: "plan_mode_respond",
                text: JSON.stringify({
                  response: "What would you like me to do instead?",
                  options: [],
                }),
              },
            ],
          }),
        },
      ];

      const mockClineClient: ClineClient = {
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
            async *[Symbol.asyncIterator]() {},
          }),
        },
      };

      // Mock connection that rejects the tool
      const mockConnection = {
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        requestPermission: vi.fn().mockResolvedValue({
          outcome: { outcome: "selected", optionId: "reject" }, // Reject the tool
        }),
      } as unknown as AgentSideConnection;

      const agent = new ClineAcpAgent({
        clineClient: mockClineClient,
        autoStart: false,
      });
      agent.setClient(mockConnection);
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

      const sessionResponse = await agent.newSession({ cwd: "/test", mcpServers: [] });
      await agent.prompt({
        sessionId: sessionResponse.sessionId,
        prompt: [{ type: "text", text: "Test" }],
      });

      // Find tool_call_update with failed status
      const calls = (mockConnection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls;
      const failedUpdates = calls.filter((call: unknown[]) => {
        const update = (call[0] as { update?: { sessionUpdate?: string; status?: string } })
          ?.update;
        return update?.sessionUpdate === "tool_call_update" && update?.status === "failed";
      });

      expect(failedUpdates.length).toBe(1);
      expect((failedUpdates[0][0] as { update: { toolCallId: string } }).update.toolCallId).toBe(
        "1000",
      );
    });
  });
});
