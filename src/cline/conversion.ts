/**
 * Conversion functions between ACP protocol and Cline gRPC types
 */

import { PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import {
  ClineMessage,
  ClinePrompt,
  ClineToolInfo,
  ClineCostInfo,
  ClineMessageType,
  ClineSay,
  ClineAsk,
} from "./types.js";

/**
 * Convert ACP prompt to Cline format
 */
export function acpPromptToCline(prompt: PromptRequest): ClinePrompt {
  let text = "";
  const images: string[] = [];
  const files: string[] = [];

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text":
        text += chunk.text;
        break;
      case "resource_link":
        if (chunk.uri.startsWith("file://")) {
          files.push(chunk.uri.slice(7)); // Remove file:// prefix
        } else {
          text += `[${chunk.uri}]`;
        }
        break;
      case "resource":
        if ("text" in chunk.resource) {
          text += `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`;
        }
        break;
      case "image":
        if ("data" in chunk && chunk.data) {
          // For base64 images, we'd need to write to temp file
          // For now, note that Cline expects file paths
          // This would be handled by the agent layer
        }
        break;
    }
  }

  return { text, images, files };
}

/**
 * Convert Cline message to ACP session notification
 * State JSON uses lowercase enums: "say", "ask", "text", "reasoning", etc.
 *
 * @param msg - The Cline message to convert
 * @param sessionId - The ACP session ID
 * @param messageIndex - The index of this message in the message array (0-based)
 *                      Used to skip the first message which is always user's echoed input
 * @param workspaceRoot - Optional workspace root to resolve relative paths
 */
export function clineMessageToAcpNotification(
  msg: ClineMessage,
  sessionId: string,
  messageIndex: number = 0,
  workspaceRoot?: string,
): SessionNotification | null {
  // Get type as string (state JSON uses lowercase)
  const msgType = String(msg.type || "").toLowerCase();
  const sayType = String(msg.say || "").toLowerCase();
  const askType = String(msg.ask || "").toLowerCase();

  // SAY messages (assistant output)
  if (msgType === "say") {
    // Skip API request messages
    if (sayType.includes("api_req")) {
      return null;
    }

    // Skip internal messages
    if (sayType === "checkpoint_created") {
      return null;
    }

    // Skip user_feedback messages - these are follow-up user inputs echoed back
    if (sayType === "user_feedback") {
      return null;
    }

    // Convert SAY TOOL messages to tool_call notifications for "follow" feature
    // These are auto-approved tool executions - emit them so editor can follow along
    if (sayType === "tool") {
      return clineSayToolToAcpToolCall(msg, sessionId, workspaceRoot);
    }

    // Skip the first say:text message - it's always the user's echoed input
    if (sayType === "text" && messageIndex === 0) {
      return null;
    }

    // Reasoning/thinking
    if (sayType === "reasoning") {
      const text = msg.reasoning || extractTextFromMessage(msg);
      if (text) {
        // Skip if the reasoning text looks like raw JSON tool data
        // (sometimes Cline embeds tool info in reasoning messages)
        if (looksLikeToolJson(text)) {
          return null;
        }
        return {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text },
          },
        };
      }
      return null;
    }

    // Default to text message for other say types (text, command_output, etc.)
    const text = extractTextFromMessage(msg);
    if (text) {
      // Skip if the text looks like raw JSON tool data
      if (looksLikeToolJson(text)) {
        return null;
      }
      return {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      };
    }
    return null;
  }

  // ASK messages (requesting input/approval)
  if (msgType === "ask") {
    // Skip API-related asks (failures, retries)
    if (askType.includes("api_req")) {
      return null;
    }

    // Skip internal ask types
    if (askType === "resume_task" || askType === "resume_completed_task") {
      return null;
    }

    // Tool permission request (JSON format)
    if (askType === "tool") {
      return clineToolAskToAcpToolCall(msg, sessionId, workspaceRoot);
    }

    // Command execution permission request (raw command text)
    if (askType === "command") {
      return clineCommandAskToAcpToolCall(msg, sessionId);
    }

    // Task completed - don't emit notification, just let stream end
    if (askType === "completion_result") {
      return null;
    }

    // Plan mode respond - extract the response text
    // This contains the actual AI response in JSON format: {"response":"...","options":[]}
    if (askType === "plan_mode_respond") {
      const text = extractTextFromMessage(msg);
      if (text) {
        return {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        };
      }
      return null;
    }

    // For followup and other ask types - return text
    const text = extractTextFromMessage(msg);
    if (text) {
      return {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      };
    }
    return null;
  }

  return null;
}

/**
 * Check if text looks like raw JSON tool data that should be filtered out
 */
function looksLikeToolJson(text: string): boolean {
  // Quick check - must start with { and be valid JSON
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed);
    // Check for common tool JSON patterns
    if (typeof parsed === "object" && parsed !== null) {
      // Has a "tool" field (Cline tool format)
      if ("tool" in parsed) {
        return true;
      }
      // Has tool-like fields without explicit "tool" key
      if ("path" in parsed && ("content" in parsed || "operationIsLocatedInWorkspace" in parsed)) {
        return true;
      }
    }
  } catch {
    // Not valid JSON
  }

  return false;
}

/**
 * Extract the text content from a ClineMessage, handling various message formats
 */
function extractTextFromMessage(msg: ClineMessage): string {
  // Check for plan mode response (has response field with the actual text)
  if (msg.planModeResponse?.response) {
    return msg.planModeResponse.response;
  }

  // Check for ask question response
  if (msg.askQuestion?.question) {
    return msg.askQuestion.question;
  }

  // Check if text field contains a JSON object with a response field
  // This happens when the proto-loader serializes nested messages as JSON strings
  if (msg.text) {
    try {
      const parsed = JSON.parse(msg.text);
      if (typeof parsed === "object" && parsed !== null) {
        // Handle planModeResponse format: {"response": "...", "options": [...]}
        if (typeof parsed.response === "string") {
          return parsed.response;
        }
        // Handle askQuestion format: {"question": "...", "options": [...]}
        if (typeof parsed.question === "string") {
          return parsed.question;
        }
      }
    } catch {
      // Not JSON, return text as-is
    }
  }

  // Default to text field
  return msg.text || "";
}

/**
 * Normalize enum values for comparison (proto uses SCREAMING_CASE, we use lowercase)
 */
function normalizeEnumValue(value: string | undefined): string {
  if (!value) return "";
  return value.toLowerCase().replace(/_/g, "_");
}

/**
 * Convert Cline partial message to ACP notification
 */
export function clinePartialToAcpNotification(
  msg: ClineMessage,
  sessionId: string,
): SessionNotification | null {
  const msgType = normalizeEnumValue(msg.type as unknown as string);
  const sayCat = normalizeEnumValue(msg.say as unknown as string);

  if (msgType === "say" || msg.type === ClineMessageType.SAY) {
    if (sayCat === "reasoning" || msg.say === ClineSay.REASONING) {
      return {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: extractTextFromMessage(msg) },
        },
      };
    }

    // Default to message chunk for text
    const text = extractTextFromMessage(msg);
    if (text) {
      return {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      };
    }
  }

  // Handle ASK messages (for plan mode responses, followups, etc.)
  const askCat = normalizeEnumValue(msg.ask as unknown as string);
  if (msgType === "ask" || msg.type === ClineMessageType.ASK) {
    const text = extractTextFromMessage(msg);
    if (text) {
      return {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      };
    }
  }

  return null;
}

/**
 * Parse tool info from Cline message
 * @param msg - The Cline message to parse
 * @param workspaceRoot - Optional workspace root to resolve relative paths
 */
export function parseToolInfo(msg: ClineMessage, workspaceRoot?: string): ClineToolInfo {
  try {
    const data = JSON.parse(msg.text || "{}");
    const toolType = data.tool || "unknown";

    // Generate title based on tool type
    let title = toolType;
    if (data.path) {
      title = `${toolType} ${data.path}`;
    } else if (data.command) {
      title = `${toolType}: ${data.command}`;
    }

    // For file operations, Cline provides:
    // - path: relative path (e.g., "src/foo.ts") or workspace folder name (e.g., "claude-code-acp")
    // - content: absolute path (e.g., "/Users/.../src/foo.ts") - only sometimes
    // Try content first, then resolve relative path using workspace root
    let filePath = data.path;
    if (typeof data.content === "string" && data.content.startsWith("/")) {
      // content field has absolute path
      filePath = data.content;
    } else if (filePath && workspaceRoot && !filePath.startsWith("/")) {
      // Check if path is the workspace folder name itself (e.g., "claude-code-acp")
      // For directory listing tools, Cline may pass the workspace name as the path
      const workspaceBasename = workspaceRoot.split("/").pop();
      if (filePath === workspaceBasename) {
        // Path is the workspace folder name, use workspace root directly
        filePath = workspaceRoot;
      } else {
        // Resolve relative path using workspace root
        filePath = `${workspaceRoot}/${filePath}`;
      }
    }

    // Extract line number if present
    // Cline may provide line, startLine, or other line-related fields
    let line: number | undefined;
    if (typeof data.line === "number") {
      line = data.line;
    } else if (typeof data.startLine === "number") {
      line = data.startLine;
    }

    // Extract content if present (for file reads, command output, etc.)
    // Note: content may be file contents or path depending on context
    let content: string | undefined;
    if (typeof data.content === "string" && !data.content.startsWith("/")) {
      // If content doesn't look like a path, it's actual content
      content = data.content;
    }

    // Extract diff if present (for file edits)
    let diff: string | undefined;
    if (typeof data.diff === "string") {
      diff = data.diff;
    }

    return {
      type: toolType,
      title,
      input: data,
      path: filePath,
      line,
      content,
      diff,
    };
  } catch {
    return {
      type: "unknown",
      title: "Unknown Tool",
      input: {},
    };
  }
}

/**
 * Define the ToolCallContent types for ACP
 * Matches the ACP SDK ToolCallContent schema
 */
type ToolCallContent =
  | { type: "content"; content: { type: "text"; text: string } }
  | { type: "diff"; path: string; newText: string; oldText?: string | null };

/**
 * Build ToolCallContent array from parsed tool info
 */
function buildToolCallContent(toolInfo: ClineToolInfo): ToolCallContent[] {
  const result: ToolCallContent[] = [];

  // If we have a diff, include it as diff content
  // The ACP format expects newText (and optionally oldText)
  // Cline provides the diff string, so we include it as newText for display
  if (toolInfo.diff && toolInfo.path) {
    result.push({
      type: "diff",
      path: toolInfo.path,
      newText: toolInfo.diff,
    });
  }

  // If we have text content (file contents, command output, etc.), include it
  if (toolInfo.content) {
    result.push({
      type: "content",
      content: { type: "text", text: toolInfo.content },
    });
  }

  return result;
}

/**
 * Map Cline tool types to ACP ToolKind
 */
function mapToolKind(
  toolType: string,
): "read" | "edit" | "execute" | "search" | "fetch" | "think" | "other" {
  const kindMap: Record<
    string,
    "read" | "edit" | "execute" | "search" | "fetch" | "think" | "other"
  > = {
    read_file: "read",
    write_to_file: "edit",
    replace_in_file: "edit",
    execute_command: "execute",
    search_files: "search",
    list_files: "search",
    browser_action: "fetch",
    ask_followup_question: "other",
  };

  return kindMap[toolType] || "other";
}

/**
 * Convert Cline tool ask to ACP tool call notification (pending approval)
 */
export function clineToolAskToAcpToolCall(
  msg: ClineMessage,
  sessionId: string,
  workspaceRoot?: string,
): SessionNotification {
  const toolInfo = parseToolInfo(msg, workspaceRoot);
  const kind = mapToolKind(toolInfo.type);

  const locations: Array<{ path: string; line?: number }> = [];
  if (toolInfo.path) {
    const location: { path: string; line?: number } = { path: toolInfo.path };
    if (toolInfo.line !== undefined) {
      location.line = toolInfo.line;
    }
    locations.push(location);
  }

  // Build content array from tool info (includes diffs and preview content)
  const content = buildToolCallContent(toolInfo);

  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: String(msg.ts),
      status: "pending",
      title: toolInfo.title,
      kind,
      rawInput: toolInfo.input,
      content,
      locations,
    },
  };
}

/**
 * Convert Cline command ask to ACP tool call notification (pending approval)
 * Command asks have raw command text, not JSON like tool asks
 */
export function clineCommandAskToAcpToolCall(
  msg: ClineMessage,
  sessionId: string,
): SessionNotification {
  const command = msg.text || "command";

  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: String(msg.ts),
      status: "pending",
      title: command,
      kind: "execute",
      rawInput: { command },
      content: [],
      locations: [],
    },
  };
}

/**
 * Convert Cline SAY TOOL message to ACP tool call notification (completed/auto-approved)
 * This enables the "follow" feature so editors can track what files the agent is working on
 */
export function clineSayToolToAcpToolCall(
  msg: ClineMessage,
  sessionId: string,
  workspaceRoot?: string,
): SessionNotification | null {
  const toolInfo = parseToolInfo(msg, workspaceRoot);

  // Skip if we couldn't parse tool info
  if (toolInfo.type === "unknown") {
    return null;
  }

  const kind = mapToolKind(toolInfo.type);

  const locations: Array<{ path: string; line?: number }> = [];
  if (toolInfo.path) {
    const location: { path: string; line?: number } = { path: toolInfo.path };
    if (toolInfo.line !== undefined) {
      location.line = toolInfo.line;
    }
    locations.push(location);
  }

  // Build content array from tool info (includes diffs and output content)
  const content = buildToolCallContent(toolInfo);

  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: String(msg.ts),
      status: "completed", // SAY TOOL means tool already executed
      title: toolInfo.title,
      kind,
      rawInput: toolInfo.input,
      content,
      locations,
    },
  };
}

/**
 * Convert Cline SAY TOOL message to ACP tool call notification with "in_progress" status
 * Used for partial tool messages that are still executing
 */
export function clineSayToolToAcpToolCallInProgress(
  msg: ClineMessage,
  sessionId: string,
  workspaceRoot?: string,
): SessionNotification | null {
  // Only handle TOOL messages
  const sayType = String(msg.say || "").toLowerCase();
  if (sayType !== "tool") {
    return null;
  }

  const toolInfo = parseToolInfo(msg, workspaceRoot);

  // Skip if we couldn't parse tool info
  if (toolInfo.type === "unknown") {
    return null;
  }

  const kind = mapToolKind(toolInfo.type);

  // For in_progress tool calls from partial messages, don't include locations.
  // The path may be incomplete during streaming (e.g., "package" instead of "package.json").
  // Locations will be included when we emit the completed tool_call.
  const locations: Array<{ path: string; line?: number }> = [];

  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: String(msg.ts),
      status: "in_progress",
      title: toolInfo.title,
      kind,
      rawInput: toolInfo.input,
      content: [],
      locations,
    },
  };
}

/**
 * Create a tool_call_update notification to update the status of an existing tool call
 */
export function createToolCallUpdate(
  sessionId: string,
  toolCallId: string,
  status: "pending" | "in_progress" | "completed" | "failed",
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
    },
  };
}

/**
 * Check if task is complete based on messages
 */
export function isTaskComplete(messages: ClineMessage[]): boolean {
  if (messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];
  const msgType = String(lastMessage.type || "").toLowerCase();
  const askType = String(lastMessage.ask || "").toLowerCase();

  // Check for completion result ask
  if (msgType === "ask" && askType === "completion_result") {
    return true;
  }

  return false;
}

/**
 * Parse Cline's task_progress markdown checklist into ACP PlanEntry format
 * Cline uses: "- [ ]" for pending, "- [x]" for completed
 */
export interface ClinePlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * Parse markdown checkbox format from Cline's task_progress messages
 */
export function parseTaskProgressToPlanEntries(text: string): ClinePlanEntry[] {
  const entries: ClinePlanEntry[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    // Match "- [ ] task" (unchecked) or "- [x] task" (checked)
    const uncheckedMatch = line.match(/^[-*]\s*\[\s*\]\s*(.+)$/);
    const checkedMatch = line.match(/^[-*]\s*\[x\]\s*(.+)$/i);

    if (checkedMatch) {
      entries.push({
        content: checkedMatch[1].trim(),
        status: "completed",
      });
    } else if (uncheckedMatch) {
      entries.push({
        content: uncheckedMatch[1].trim(),
        status: "pending",
      });
    }
  }

  return entries;
}

/**
 * Convert Cline task_progress message to ACP plan notification
 */
export function clineTaskProgressToAcpPlan(
  msg: ClineMessage,
  sessionId: string,
): SessionNotification | null {
  const text = msg.text || "";
  const entries = parseTaskProgressToPlanEntries(text);

  if (entries.length === 0) {
    return null;
  }

  return {
    sessionId,
    update: {
      sessionUpdate: "plan",
      entries: entries.map((entry) => ({
        content: entry.content,
        status: entry.status,
        priority: "medium" as const,
      })),
    },
  };
}

/**
 * Extract the latest task_progress message from Cline messages
 */
export function getLatestTaskProgress(messages: ClineMessage[]): ClineMessage | null {
  // Find the last task_progress message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const sayType = String(msg.say || "").toLowerCase();
    if (sayType === "task_progress") {
      return msg;
    }
  }
  return null;
}

/**
 * Check if Cline is waiting for user input (turn is complete)
 * This is different from task completion - the task may continue after user responds
 *
 * Important: Only returns true if the last message is complete (not partial)
 * because we need to process the full response before ending the turn
 */
export function isWaitingForUserInput(messages: ClineMessage[]): boolean {
  if (messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];

  // If the last message is still partial, we're not done yet
  if (lastMessage.partial) {
    return false;
  }

  const msgType = String(lastMessage.type || "").toLowerCase();
  const askType = String(lastMessage.ask || "").toLowerCase();

  // These ask types mean Cline is waiting for user response
  const waitingTypes = [
    "plan_mode_respond", // Plan mode - waiting for user to approve/respond
    "followup", // Asking follow-up question
    "completion_result", // Task completed, asking if satisfied
  ];

  if (msgType === "ask" && waitingTypes.includes(askType)) {
    return true;
  }

  return false;
}

/**
 * Check if approval is needed based on messages
 *
 * IMPORTANT: Only returns true when the message is COMPLETE (not partial).
 * Cline ignores approval responses sent while the message is still partial.
 * We must wait for the message to be complete before requesting approval.
 */
export function needsApproval(messages: ClineMessage[]): boolean {
  if (messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];

  // Only ASK messages can need approval
  if (lastMessage.type !== ClineMessageType.ASK) return false;

  // CRITICAL: Don't request approval while message is still partial
  // Cline ignores approval responses for partial messages
  if (lastMessage.partial) return false;

  // These ask types require approval
  const approvalTypes = [
    ClineAsk.TOOL,
    ClineAsk.COMMAND,
    ClineAsk.BROWSER_ACTION_LAUNCH,
    ClineAsk.USE_MCP_SERVER,
  ];

  return approvalTypes.includes(lastMessage.ask as ClineAsk);
}

/**
 * Extract messages from Cline state JSON
 */
export function extractMessagesFromState(stateJson: string): ClineMessage[] {
  try {
    const state = JSON.parse(stateJson);
    const rawMessages = state.clineMessages || [];

    // Convert raw message format to ClineMessage type
    return rawMessages.map((msg: Record<string, unknown>) => ({
      ts: msg.ts as number,
      type: msg.type as ClineMessageType,
      ask: msg.ask as ClineAsk | undefined,
      say: msg.say as ClineSay | undefined,
      text: msg.text as string | undefined,
      reasoning: msg.reasoning as string | undefined,
      partial: msg.partial as boolean | undefined,
      images: msg.images as string[] | undefined,
      // Include the structured response fields
      planModeResponse: msg.planModeResponse as
        | { response: string; options: string[]; selected?: string }
        | undefined,
      askQuestion: msg.askQuestion as
        | { question: string; options: string[]; selected?: string }
        | undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Extract the primary workspace root path from Cline state JSON
 * This is used to resolve relative file paths to absolute paths for the "follow" feature
 */
export function extractWorkspaceRoot(stateJson: string): string | undefined {
  try {
    const state = JSON.parse(stateJson);
    const workspaceRoots = state.workspaceRoots as Array<{ path: string }> | undefined;
    const primaryRootIndex = (state.primaryRootIndex as number) ?? 0;

    if (workspaceRoots && workspaceRoots.length > 0) {
      const primaryRoot = workspaceRoots[primaryRootIndex] || workspaceRoots[0];
      return primaryRoot.path;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the current mode from Cline state JSON
 * Cline uses "plan" or "act" as mode values
 */
export function extractMode(stateJson: string): "plan" | "act" {
  try {
    const state = JSON.parse(stateJson);
    // Cline's mode field is either "plan" or "act"
    const mode = state.mode;
    return mode === "act" ? "act" : "plan";
  } catch {
    return "plan"; // Default to plan mode
  }
}

/**
 * Create a current_mode_update notification
 */
export function createCurrentModeUpdate(
  sessionId: string,
  modeId: "plan" | "act",
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "current_mode_update",
      currentModeId: modeId,
    },
  };
}

/**
 * Extract cost info from a Cline api_req_started message
 * Returns null if the message doesn't contain cost data
 *
 * The cost data appears in messages with say="api_req_started" after the request completes.
 * Format: {"tokensIn": 1234, "tokensOut": 567, "cacheWrites": 0, "cacheReads": 100, "cost": 0.0123}
 */
export function extractCostInfo(msg: ClineMessage): ClineCostInfo | null {
  // Only api_req_started messages contain cost data
  const sayType = String(msg.say || "").toLowerCase();
  if (sayType !== "api_req_started") {
    return null;
  }

  try {
    const data = JSON.parse(msg.text || "{}");

    // Cost data is only present after the request completes
    // Check for the presence of cost field (can be 0)
    if (data.cost === undefined) {
      return null;
    }

    return {
      tokensIn: data.tokensIn || 0,
      tokensOut: data.tokensOut || 0,
      cacheWrites: data.cacheWrites || 0,
      cacheReads: data.cacheReads || 0,
      cost: data.cost || 0,
    };
  } catch {
    return null;
  }
}
