/**
 * Conversion functions between ACP protocol and Cline gRPC types
 */

import { PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import {
  ClineMessage,
  ClinePrompt,
  ClineToolInfo,
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
 */
export function clineMessageToAcpNotification(
  msg: ClineMessage,
  sessionId: string,
  messageIndex: number = 0,
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

    // Skip the first say:text message - it's always the user's echoed input
    if (sayType === "text" && messageIndex === 0) {
      return null;
    }

    // Reasoning/thinking
    if (sayType === "reasoning") {
      const text = msg.reasoning || extractTextFromMessage(msg);
      if (text) {
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

    // Default to text message for other say types (text, tool, command_output, etc.)
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

  // ASK messages (requesting input/approval)
  if (msgType === "ask") {
    // Tool/command permission request
    if (askType === "tool" || askType === "command") {
      return clineToolAskToAcpToolCall(msg, sessionId);
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
 */
export function parseToolInfo(msg: ClineMessage): ClineToolInfo {
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

    return {
      type: toolType,
      title,
      input: data,
      path: data.path,
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
 * Map Cline tool types to ACP ToolKind
 */
function mapToolKind(
  toolType: string,
): "read" | "edit" | "execute" | "search" | "fetch" | "think" | "other" {
  const kindMap: Record<string, "read" | "edit" | "execute" | "search" | "fetch" | "think" | "other"> = {
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
 * Convert Cline tool ask to ACP tool call notification
 */
export function clineToolAskToAcpToolCall(
  msg: ClineMessage,
  sessionId: string,
): SessionNotification {
  const toolInfo = parseToolInfo(msg);
  const kind = mapToolKind(toolInfo.type);

  const locations: Array<{ path: string }> = [];
  if (toolInfo.path) {
    locations.push({ path: toolInfo.path });
  }

  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: String(msg.ts),
      status: "pending",
      title: toolInfo.title,
      kind,
      rawInput: toolInfo.input,
      content: [],
      locations,
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
    "plan_mode_respond",   // Plan mode - waiting for user to approve/respond
    "followup",            // Asking follow-up question
    "completion_result",   // Task completed, asking if satisfied
  ];

  if (msgType === "ask" && waitingTypes.includes(askType)) {
    return true;
  }

  return false;
}

/**
 * Check if approval is needed based on messages
 */
export function needsApproval(messages: ClineMessage[]): boolean {
  if (messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];

  // Only ASK messages can need approval
  if (lastMessage.type !== ClineMessageType.ASK) return false;

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
      planModeResponse: msg.planModeResponse as { response: string; options: string[]; selected?: string } | undefined,
      askQuestion: msg.askQuestion as { question: string; options: string[]; selected?: string } | undefined,
    }));
  } catch {
    return [];
  }
}
