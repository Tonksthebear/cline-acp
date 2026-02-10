/**
 * Conversion functions between ACP protocol and Cline gRPC types
 */

import * as fs from "fs";
import * as path from "path";
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
 * Extracts text content and converts images to file paths
 */
export function acpPromptToCline(
  prompt: PromptRequest,
  debug?: (msg: string, data?: unknown) => void,
): ClinePrompt {
  const textParts: string[] = [];
  const images: string[] = [];
  const files: string[] = [];

  for (const chunk of prompt.prompt) {
    if (chunk.type === "text" && "text" in chunk && chunk.text) {
      textParts.push(chunk.text);
    } else if (chunk.type === "image") {
      // Log the raw image chunk for debugging
      debug?.("image chunk received", {
        keys: Object.keys(chunk),
        hasUri: "uri" in chunk,
        uri: "uri" in chunk ? chunk.uri : undefined,
        hasData: "data" in chunk,
        dataLength: "data" in chunk ? (chunk as { data?: string }).data?.length : 0,
        mimeType: "mimeType" in chunk ? chunk.mimeType : undefined,
      });

      // Handle image content - Cline internal code expects DATA URLs, not file paths!
      // Despite proto comments saying "file paths", the actual code uses data:image/...;base64,...
      let imageDataUrl: string | null = null;

      if ("data" in chunk && chunk.data && chunk.data.length > 0) {
        // Use base64 data directly to create data URL
        const mimeType = "mimeType" in chunk ? (chunk.mimeType as string) : "image/png";
        imageDataUrl = `data:${mimeType};base64,${chunk.data}`;
        debug?.("created data URL from base64", {
          mimeType,
          dataLength: chunk.data.length,
        });
      } else if ("uri" in chunk && chunk.uri) {
        // No base64 data - try to read file and convert to data URL
        const uri = chunk.uri as string;
        debug?.("no base64 data, trying to read file", { uri });
        if (uri.startsWith("file://")) {
          const filePath = decodeURIComponent(uri.slice(7));
          if (fs.existsSync(filePath)) {
            try {
              const fileBuffer = fs.readFileSync(filePath);
              const base64Data = fileBuffer.toString("base64");
              const mimeType = getMimeTypeFromPath(filePath);
              imageDataUrl = `data:${mimeType};base64,${base64Data}`;
              debug?.("created data URL from file", { filePath, mimeType });
            } catch (err) {
              debug?.("failed to read file", { filePath, error: String(err) });
            }
          }
        }
      }

      if (imageDataUrl) {
        images.push(imageDataUrl);
      } else {
        debug?.("image chunk: no valid data or file path available");
      }
    } else if (chunk.type === "resource" && "resource" in chunk) {
      // Embedded resource - append text content
      const resource = chunk.resource;
      if ("text" in resource && resource.text) {
        // Include resource URI as context
        if (resource.uri) {
          // Strip file:// prefix if present and wrap in XML tags
          let path = resource.uri;
          if (path.startsWith("file://")) {
            path = decodeURIComponent(path.slice(7));
          }
          textParts.push(`<file_context path="${path}">\n${resource.text}\n</file_context>`);
        } else {
          textParts.push(resource.text);
        }
      }
    } else if (chunk.type === "resource_link" && "uri" in chunk && chunk.uri) {
      // Resource link - treat as file attachment if it's a file:// URI
      const uri = chunk.uri as string;
      if (uri.startsWith("file://")) {
        // URL-decode the path (handles %20 spaces, etc.)
        const filePath = decodeURIComponent(uri.slice(7));
        files.push(filePath);
      }
    }
  }

  return {
    text: textParts.join("\n"),
    images: images.length > 0 ? images : undefined,
    files: files.length > 0 ? files : undefined,
  };
}

/**
 * Get MIME type from file path based on extension
 */
function getMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const extMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return extMap[ext] || "image/png";
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
      // Skip internal retry mechanism messages
      if (looksLikeRetryJson(text)) {
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
    // Handle API request failures - surface the error to the user
    if (askType === "api_req_failed") {
      try {
        const errorData = JSON.parse(msg.text || "{}");
        const errorMessage = errorData.message || "API request failed. Please check your configuration.";
        return {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `⚠️ **Error**: ${errorMessage}`,
            },
          },
        };
      } catch {
        return {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "⚠️ **Error**: API request failed. Please check your configuration.",
            },
          },
        };
      }
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
 * This catches Cline's internal tool formats that shouldn't be shown to users
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
      // Has a "tool" field (Cline tool format) - e.g., {"tool":"readFile",...}
      if ("tool" in parsed) {
        return true;
      }
      // Has operationIsLocatedInWorkspace (Cline tool metadata)
      if ("operationIsLocatedInWorkspace" in parsed) {
        return true;
      }
      // Has tool-like fields: path + content/diff/regex/filePattern
      if ("path" in parsed) {
        if ("content" in parsed || "diff" in parsed || "regex" in parsed || "filePattern" in parsed) {
          return true;
        }
      }
      // Browser action format
      if ("action" in parsed && ("url" in parsed || "coordinate" in parsed)) {
        return true;
      }
      // MCP tool format
      if ("serverName" in parsed && "toolName" in parsed) {
        return true;
      }
    }
  } catch {
    // Not valid JSON - not tool data
  }

  return false;
}

/**
 * Check if text looks like internal retry mechanism JSON that should be filtered out
 * Cline emits these messages during API retries: {"attempt":1,"maxAttempts":3,"delaySeconds":0}
 */
function looksLikeRetryJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      // Check for retry mechanism signature: has attempt, maxAttempts, and delaySeconds
      if (
        "attempt" in parsed &&
        "maxAttempts" in parsed &&
        "delaySeconds" in parsed &&
        typeof parsed.attempt === "number" &&
        typeof parsed.maxAttempts === "number"
      ) {
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
    // Skip tool messages in partial stream - they're handled separately
    if (sayCat === "tool" || msg.say === ClineSay.TOOL) {
      return null;
    }

    if (sayCat === "reasoning" || msg.say === ClineSay.REASONING) {
      const text = extractTextFromMessage(msg);
      // Skip if reasoning looks like tool JSON
      if (text && looksLikeToolJson(text)) {
        return null;
      }
      return {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: text || "" },
        },
      };
    }

    // Default to message chunk for text
    const text = extractTextFromMessage(msg);
    if (text) {
      // Skip if text looks like raw JSON tool data
      if (looksLikeToolJson(text)) {
        return null;
      }
      // Skip internal retry mechanism messages
      if (looksLikeRetryJson(text)) {
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
  }

  // Handle ASK messages (for plan mode responses, followups, etc.)
  if (msgType === "ask" || msg.type === ClineMessageType.ASK) {
    const askCat = normalizeEnumValue(msg.ask as unknown as string);
    // Skip tool/command asks in partial stream - handled by permission flow
    if (askCat === "tool" || askCat === "command") {
      return null;
    }

    const text = extractTextFromMessage(msg);
    if (text) {
      // Skip if text looks like tool JSON
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
      // For edits, a cleaner title helps Zed's native UI
      if (toolType === "replace_in_file" || toolType === "write_to_file" || toolType === "apply_diff") {
        title = `Edit ${path.basename(data.path)}`;
      } else {
        title = `${toolType} ${data.path}`;
      }
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
 * Parse results from search/replace extraction
 */
interface ParsedDiff {
  oldText: string;
  newText: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Extract all SEARCH/REPLACE blocks from text
 * Handles variations in markers and same-line code
 */
function extractSearchReplaceBlocks(text: string): ParsedDiff[] {
  const blocks: ParsedDiff[] = [];
  // Flexible regex for standard and variant markers
  // Group 1: Optional code on the same line as SEARCH
  // Group 2: The rest of the SEARCH block
  // Group 3: The REPLACE block
  const pattern = /(?:^|\n)(?:-{3,}|<{7})\s*SEARCH\s*(.*?)\n([\s\S]*?)\n[=]{3,}\s*\n([\s\S]*?)\n(?:\+{3,}|>{7})\s*REPLACE/g;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const firstLineSearch = match[1].trim();
    const restSearch = match[2];
    const newText = match[3];

    blocks.push({
      oldText: (firstLineSearch ? firstLineSearch + "\n" : "") + restSearch,
      newText: newText,
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }
  return blocks;
}

/**
 * Build ToolCallContent array from parsed tool info
 */
function buildToolCallContent(toolInfo: ClineToolInfo): ToolCallContent[] {
  const result: ToolCallContent[] = [];
  const foundDiffs: ToolCallContent[] = [];

  // 1. Check for granular search/replace in input fields (some MCP tools)
  if (toolInfo.input && typeof toolInfo.input === "object") {
    const input = toolInfo.input as Record<string, unknown>;

    // Standard SEARCH/REPLACE in fields (used by some models)
    if (input.search && input.replace && typeof input.search === "string" && typeof input.replace === "string") {
      foundDiffs.push({
        type: "diff",
        path: toolInfo.path || "",
        oldText: input.search,
        newText: input.replace,
      });
    }

    // Alternative field names (common in some MCP tools)
    if (input.old_text && input.new_text && typeof input.old_text === "string" && typeof input.new_text === "string") {
      foundDiffs.push({
        type: "diff",
        path: toolInfo.path || "",
        oldText: input.old_text,
        newText: input.new_text,
      });
    }
  }

  // 2. Check for full write_to_file logic
  if (
    (toolInfo.type === "write_to_file" || toolInfo.type === "insert_content") &&
    toolInfo.input &&
    typeof toolInfo.input === "object"
  ) {
    const input = toolInfo.input as Record<string, unknown>;
    if (input.content && typeof input.content === "string" && toolInfo.path) {
      foundDiffs.push({
        type: "diff",
        path: toolInfo.path,
        newText: input.content, // oldText undefined implies total overwrite
      });
    }
  }

  // 3. Extract SEARCH/REPLACE blocks from 'diff' or 'content' field in replace_in_file/apply_diff
  if ((toolInfo.type === "replace_in_file" || toolInfo.type === "apply_diff") && toolInfo.path) {
    const diffSource = toolInfo.diff || toolInfo.content;
    if (diffSource) {
      const blocks = extractSearchReplaceBlocks(diffSource);
      if (blocks.length > 0) {
        for (const block of blocks) {
          foundDiffs.push({
            type: "diff",
            path: toolInfo.path,
            oldText: block.oldText,
            newText: block.newText,
          });
        }
      } else {
        // Fallback: show the raw block if it's not standard SEARCH/REPLACE format
        foundDiffs.push({
          type: "diff",
          path: toolInfo.path,
          newText: diffSource,
        });
      }
    }
  }

  // 4. Extract SEARCH/REPLACE blocks from generic 'content' field
  // This handles models that explain their code inside the content field
  let remainingContent: string | undefined = toolInfo.content;
  if (remainingContent && typeof remainingContent === "string") {
    const contentStr: string = remainingContent;
    const blocks = extractSearchReplaceBlocks(contentStr);
    if (blocks.length > 0) {
      // Sort blocks from last to first
      const sortedBlocks = [...blocks].sort((a, b) => b.startIndex - a.startIndex);
      for (const block of sortedBlocks) {
        foundDiffs.push({
          type: "diff",
          path: toolInfo.path || "file",
          oldText: block.oldText,
          newText: block.newText,
        });
        // Remove block from the thought text
        const prefixStr: string = remainingContent!.substring(0, block.startIndex);
        const suffixStr: string = remainingContent!.substring(block.endIndex);
        remainingContent = prefixStr + "\n(Diff proposed below)\n" + suffixStr;
      }
    }
  }

  // Final Assembly
  // CRITICAL: If we have diffs, we only send the diffs to ensure Zed promotes this
  // ToolCall to the native editor diff UI. Any reasoning text is already
  // being sent in the main message stream.
  if (foundDiffs.length > 0) {
    result.push(...foundDiffs);
  } else {
    // Only send text if there are no diffs
    if (remainingContent && remainingContent.trim()) {
      result.push({
        type: "content",
        content: { type: "text", text: remainingContent.trim() },
      });
    }
  }

  return result;
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
    apply_diff: "edit", // Support apply_diff specifically
    insert_content: "edit", // Support insert_content specifically
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
      _meta: {
        tool: toolInfo.type,
      },
    },
  };
}

/**
 * Convert Cline command ask to ACP tool call notification (pending approval)
 * Command asks have raw command text, not JSON like tool asks
 */
export function clineCommandAskToAcpToolCall(msg: ClineMessage, sessionId: string): SessionNotification {
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
export function clineTaskProgressToAcpPlan(msg: ClineMessage, sessionId: string): SessionNotification | null {
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
export function isWaitingForUserInput(
  messages: ClineMessage[],
  debug?: (msg: string, data?: unknown) => void,
): boolean {
  if (messages.length === 0) {
    debug?.("isWaitingForUserInput: no messages");
    return false;
  }

  const lastMessage = messages[messages.length - 1];

  // If the last message is still partial, we're not done yet
  if (lastMessage.partial) {
    debug?.("isWaitingForUserInput: message is partial");
    return false;
  }

  const msgType = String(lastMessage.type || "").toLowerCase();
  const askType = String(lastMessage.ask || "").toLowerCase();

  // These ask types mean Cline is waiting for user response (or has errored)
  const waitingTypes = [
    "plan_mode_respond", // Plan mode - waiting for user to approve/respond
    "followup", // Asking follow-up question
    "completion_result", // Task completed, asking if satisfied
    "api_req_failed", // API request failed - need to surface error and stop
  ];

  debug?.("isWaitingForUserInput: checking", {
    msgType,
    askType,
    partial: lastMessage.partial,
    isAsk: msgType === "ask",
    isWaitingType: waitingTypes.includes(askType),
  });

  if (msgType === "ask" && waitingTypes.includes(askType)) {
    debug?.("isWaitingForUserInput: returning true");
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
  const approvalTypes = [ClineAsk.TOOL, ClineAsk.COMMAND, ClineAsk.BROWSER_ACTION_LAUNCH, ClineAsk.USE_MCP_SERVER];

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
export function createCurrentModeUpdate(sessionId: string, modeId: "plan" | "act"): SessionNotification {
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
