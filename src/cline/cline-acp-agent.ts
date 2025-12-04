/**
 * ClineAcpAgent - ACP Agent implementation backed by Cline
 */

import { v7 as uuidv7 } from "uuid";
import {
  Agent,
  AgentSideConnection,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
} from "@agentclientprotocol/sdk";
import {
  ClineClient,
  ClineInstance,
  ClineSession,
  PlanActMode,
  AskResponseType,
  StateUpdate,
  ClineMessage,
} from "./types.js";
import {
  acpPromptToCline,
  clineMessageToAcpNotification,
  clinePartialToAcpNotification,
  extractMessagesFromState,
  isTaskComplete,
  isWaitingForUserInput,
  needsApproval,
  parseToolInfo,
} from "./conversion.js";
import { ClineProcessManager } from "./process-manager.js";
import { createClineClient } from "./grpc-client.js";

export interface ClineAcpAgentOptions {
  clinePath?: string;
  verbose?: boolean;
  // For testing: inject a mock Cline client
  clineClient?: ClineClient;
  // If true, connect to/start Cline on initialize (default: true)
  autoStart?: boolean;
  // If true, use existing Cline instance if available (default: true)
  useExisting?: boolean;
}

export class ClineAcpAgent implements Agent {
  private client!: AgentSideConnection;
  private clientCapabilities: InitializeRequest["clientCapabilities"] = {};
  private sessions: Record<string, ClineSession> = {};
  private clineClient: ClineClient | null = null;
  private clineInstance: ClineInstance | null = null;
  private processManager: ClineProcessManager | null = null;
  private options: ClineAcpAgentOptions;

  constructor(options: ClineAcpAgentOptions = {}) {
    this.options = options;
    // Use injected client for testing
    if (options.clineClient) {
      this.clineClient = options.clineClient;
    }
  }

  setClient(client: AgentSideConnection): void {
    this.client = client;
  }

  async authenticate(): Promise<void> {
    // Cline authentication is handled externally via the Cline CLI
    // The API key is configured in Cline's settings
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;

    // Connect to Cline if no client is injected (default behavior)
    const autoStart = this.options.autoStart ?? true;
    if (autoStart && !this.clineClient) {
      this.processManager = new ClineProcessManager({
        clinePath: this.options.clinePath,
        verbose: this.options.verbose,
        useExisting: this.options.useExisting ?? true,
      });

      this.clineInstance = await this.processManager.startInstance();
      this.clineClient = await createClineClient(this.clineInstance.address);
    }

    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
      },
      agentInfo: {
        name: "cline-acp",
        version: "0.1.0",
      },
      authMethods: [
        {
          id: "cline-api-key",
          name: "API Key",
          description: "Configure your API key for the AI provider",
        },
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = uuidv7();

    // Create empty streams for testing - in production these come from gRPC
    const stateStream = this.createEmptyStream<StateUpdate>();
    const partialStream = this.createEmptyStream<ClineMessage>();

    // Don't create a task yet - wait for the first prompt
    // Creating an empty task causes Cline to respond with "task is empty" message
    this.sessions[sessionId] = {
      id: sessionId,
      taskId: sessionId, // Will be updated when first prompt is received
      stateStream,
      partialStream,
      cancelled: false,
      mode: "plan",
      isTaskCreated: false, // Track whether we've sent the first message
    };

    // Define available modes (matching Cline's actual modes)
    const availableModes = [
      {
        id: "plan",
        name: "Plan Mode",
        description: "Plan and discuss before taking action",
      },
      {
        id: "act",
        name: "Act Mode",
        description: "Execute tools with manual approval",
      },
    ];

    // Get current model configuration from Cline state
    let currentModelId = "cline";
    let currentMode = "plan";
    const availableModels: Array<{ modelId: string; name: string }> = [];

    if (this.clineClient) {
      try {
        const state = await this.clineClient.State.getLatestState();
        const stateData = JSON.parse(state.stateJson || "{}");
        const apiConfig = stateData.apiConfiguration || {};

        // Get current mode from state (Cline uses "plan" or "act")
        currentMode = stateData.mode === "act" ? "act" : "plan";

        // Get the current provider and model
        const provider = apiConfig.planModeApiProvider || "cline";
        const modelId = apiConfig.planModeOpenRouterModelId ||
                        apiConfig.apiModelId ||
                        provider;

        currentModelId = modelId;

        // Add the current model if it's not already in the list
        availableModels.push({
          modelId: currentModelId,
          name: this.formatModelName(currentModelId),
        });

        // Add some common model options based on the provider
        if (provider === "openrouter" || provider === "cline") {
          const commonModels = [
            "anthropic/claude-sonnet-4",
            "anthropic/claude-3.5-sonnet",
            "openai/gpt-4o",
            "google/gemini-2.0-flash-exp",
            "x-ai/grok-3-mini-beta",
          ];
          for (const model of commonModels) {
            if (!availableModels.find(m => m.modelId === model)) {
              availableModels.push({
                modelId: model,
                name: this.formatModelName(model),
              });
            }
          }
        }
      } catch (error) {
        // Default models if we can't fetch state
        availableModels.push(
          { modelId: "cline", name: "Cline (Default)" },
          { modelId: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
          { modelId: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
        );
      }
    } else {
      // Default models for testing
      availableModels.push(
        { modelId: "cline", name: "Cline (Default)" },
        { modelId: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
      );
    }

    return {
      sessionId,
      models: {
        availableModels,
        currentModelId,
      },
      modes: {
        currentModeId: currentMode,
        availableModes,
      },
    };
  }

  /**
   * Format model ID into a readable name
   */
  private formatModelName(modelId: string): string {
    // Handle provider/model format (e.g., "anthropic/claude-sonnet-4")
    const parts = modelId.split("/");
    const name = parts[parts.length - 1];

    // Convert kebab-case to Title Case
    return name
      .split("-")
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    // Convert ACP prompt to Cline format
    const clinePrompt = acpPromptToCline(params);

    // Send to Cline
    if (this.clineClient) {
      // Get existing message timestamps BEFORE sending the prompt
      // This ensures we only process NEW messages in processStreamingResponses
      const existingTimestamps = new Set<number>();
      if (session.isTaskCreated) {
        const currentState = await this.clineClient.State.getLatestState();
        const existingMessages = extractMessagesFromState(currentState.stateJson || "{}");
        for (const msg of existingMessages) {
          if (msg.ts) {
            existingTimestamps.add(msg.ts);
          }
        }
      }

      if (!session.isTaskCreated) {
        // First message - create a new task
        const taskId = await this.clineClient.Task.newTask({
          text: clinePrompt.text,
          images: clinePrompt.images,
          files: clinePrompt.files,
        });
        session.taskId = taskId;
        session.isTaskCreated = true;
      } else {
        // Subsequent messages - respond to existing task
        await this.clineClient.Task.askResponse({
          responseType: AskResponseType.MESSAGE_RESPONSE,
          text: clinePrompt.text,
          images: clinePrompt.images,
          files: clinePrompt.files,
        });
      }

      // Process streaming responses, skipping any existing messages
      // Also pass the user's input text so we can skip the echoed message
      await this.processStreamingResponses(params.sessionId, existingTimestamps, clinePrompt.text);
    }

    // Send at least one update to the client
    await this.client.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "" },
      },
    });

    return { stopReason: "end_turn" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      return;
    }

    session.cancelled = true;

    if (this.clineClient) {
      await this.clineClient.Task.cancelTask({});
    }
  }

  async setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    if (this.clineClient) {
      await this.clineClient.State.updateSettings({
        apiConfiguration: {
          apiModelId: params.modelId,
        },
      });
    }
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    if (this.clineClient) {
      switch (params.modeId) {
        case "plan":
          await this.clineClient.State.togglePlanActModeProto({
            metadata: {},
            mode: PlanActMode.PLAN,
          });
          break;

        case "act":
          await this.clineClient.State.togglePlanActModeProto({
            metadata: {},
            mode: PlanActMode.ACT,
          });
          break;
      }
    }

    session.mode = params.modeId as ClineSession["mode"];
    return {};
  }

  // Internal methods

  private async processStreamingResponses(
    sessionId: string,
    existingTimestamps: Set<number> = new Set(),
    userInputText: string = "",
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session || session.cancelled || !this.clineClient) return;

    // Subscribe to state updates - this gives us complete messages
    const stateStream = this.clineClient.State.subscribeToState();

    // Track which message timestamps we've already sent
    // We use timestamps (not indices) because messages can transition from partial to complete
    // Start with any existing timestamps passed in (from before the current prompt)
    const sentMessageTimestamps = new Set<number>(existingTimestamps);

    try {
      for await (const state of stateStream) {
        if (session.cancelled) break;

        const messages = extractMessagesFromState(state.stateJson || "{}");

        // Process all messages, checking each one's timestamp and partial status
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];

          // Skip partial messages (they're incomplete) - but don't mark as sent
          // so we'll process them when they become complete
          if (msg.partial) {
            continue;
          }

          // Skip if we've already sent this complete message
          if (msg.ts && sentMessageTimestamps.has(msg.ts)) {
            continue;
          }

          // Skip echoed user input - Cline echoes the user's message back as say:text
          const msgType = String(msg.type || "").toLowerCase();
          const sayType = String(msg.say || "").toLowerCase();
          if (msgType === "say" && sayType === "text" && msg.text === userInputText) {
            // This is the user's input being echoed back - skip it
            if (msg.ts) {
              sentMessageTimestamps.add(msg.ts);
            }
            continue;
          }

          // Mark as sent only AFTER confirming it's complete and not already sent
          if (msg.ts) {
            sentMessageTimestamps.add(msg.ts);
          }

          // Pass the original message index to properly skip user's echoed input (index 0)
          const notification = clineMessageToAcpNotification(msg, sessionId, i);
          if (notification) {
            await this.client.sessionUpdate(notification);
          }
        }

        // Get the last message to check state
        const lastMessage = messages[messages.length - 1];
        const lastMessageIsNew = lastMessage?.ts && !existingTimestamps.has(lastMessage.ts);

        // Check if task needs approval (only for new messages)
        if (lastMessageIsNew && needsApproval(messages)) {
          await this.handleApprovalRequest(sessionId, messages);
          continue;
        }

        // Check if Cline is waiting for user input (turn complete)
        // This happens with plan_mode_respond, followup, completion_result
        // Only break if the waiting message is NEW (not from before this prompt)
        if (lastMessageIsNew && isWaitingForUserInput(messages)) {
          break;
        }

        // Check if task is fully complete (only for new messages)
        if (lastMessageIsNew && isTaskComplete(messages)) {
          break;
        }
      }
    } catch (error) {
      // Stream ended or error occurred
      if (this.options.verbose) {
        console.log("State stream ended:", error);
      }
    }
  }

  private async handleApprovalRequest(
    sessionId: string,
    messages: ClineMessage[],
  ): Promise<void> {
    const lastMessage = messages[messages.length - 1];
    const toolInfo = parseToolInfo(lastMessage);

    // Request permission from ACP client
    const response = await this.client.requestPermission({
      options: [
        { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
      sessionId,
      toolCall: {
        toolCallId: String(lastMessage.ts),
        rawInput: toolInfo.input,
        title: toolInfo.title,
      },
    });

    // Send response to Cline
    if (this.clineClient) {
      const outcome = response.outcome;
      if (
        outcome?.outcome === "selected" &&
        (outcome.optionId === "allow" || outcome.optionId === "allow_always")
      ) {
        await this.clineClient.Task.askResponse({
          responseType: AskResponseType.YES_BUTTON_CLICKED,
          text: "",
          images: [],
          files: [],
        });
      } else {
        await this.clineClient.Task.askResponse({
          responseType: AskResponseType.NO_BUTTON_CLICKED,
          text: "",
          images: [],
          files: [],
        });
      }
    }
  }

  private createEmptyStream<T>(): AsyncIterable<T> {
    return {
      async *[Symbol.asyncIterator]() {
        // Empty stream for testing
      },
    };
  }

  /**
   * Shutdown the agent, stopping any managed processes
   */
  async shutdown(): Promise<void> {
    if (this.processManager) {
      await this.processManager.stopInstance();
      this.processManager = null;
    }
    this.clineClient = null;
    this.clineInstance = null;
  }

  // Testing helpers
  getClineClient(): ClineClient | null {
    return this.clineClient;
  }

  getSession(sessionId: string): ClineSession | undefined {
    return this.sessions[sessionId];
  }

  getProcessManager(): ClineProcessManager | null {
    return this.processManager;
  }

  // Allow setting the Cline client (for testing)
  setClineClient(client: ClineClient): void {
    this.clineClient = client;
  }
}
