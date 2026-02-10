/**
 * Cline gRPC types - these will eventually be generated from proto files
 * For now, we define them manually based on the Cline proto definitions
 */

// Cline message types from proto/cline/state.proto
export enum ClineMessageType {
  ASK = "ask",
  SAY = "say",
}

// Ask types - when Cline is requesting input/approval
export enum ClineAsk {
  FOLLOWUP = "followup",
  PLAN_MODE_RESPOND = "plan_mode_respond",
  TOOL = "tool",
  COMMAND = "command",
  COMMAND_OUTPUT = "command_output",
  COMPLETION_RESULT = "completion_result",
  API_REQ_FAILED = "api_req_failed",
  BROWSER_ACTION_LAUNCH = "browser_action_launch",
  USE_MCP_SERVER = "use_mcp_server",
  RESUME_TASK = "resume_task",
  RESUME_COMPLETED_TASK = "resume_completed_task",
  MISTAKE_LIMIT_REACHED = "mistake_limit_reached",
  AUTO_APPROVAL_MAX_REQ_REACHED = "auto_approval_max_req_reached",
}

// Say types - when Cline is outputting information
export enum ClineSay {
  TEXT = "text",
  REASONING = "reasoning",
  TOOL = "tool",
  COMMAND = "command",
  COMMAND_OUTPUT = "command_output",
  COMPLETION_RESULT = "completion_result",
  API_REQ_STARTED = "api_req_started",
  API_REQ_FINISHED = "api_req_finished",
  API_REQ_RETRIED = "api_req_retried",
  BROWSER_ACTION = "browser_action",
  BROWSER_ACTION_RESULT = "browser_action_result",
  MCP_SERVER_REQUEST_STARTED = "mcp_server_request_started",
  MCP_SERVER_RESPONSE = "mcp_server_response",
  TASK_COMPLETION_SUGGESTION = "task_completion_suggestion",
  USER_FEEDBACK = "user_feedback",
  USER_FEEDBACK_DIFF = "user_feedback_diff",
  ERROR = "error",
  DIFF = "diff",
  TASK_PROGRESS = "task_progress",
}

// Plan/Act mode - values must match proto enum names (uppercase)
export enum PlanActMode {
  PLAN = "PLAN",
  ACT = "ACT",
}

// Plan mode response structure
export interface ClinePlanModeResponse {
  response: string;
  options: string[];
  selected?: string;
}

// Ask question structure
export interface ClineAskQuestion {
  question: string;
  options: string[];
  selected?: string;
}

// ClineMessage from state stream
export interface ClineMessage {
  ts: number;
  type: ClineMessageType;
  ask?: ClineAsk;
  say?: ClineSay;
  text?: string;
  reasoning?: string;
  partial?: boolean;
  images?: string[];
  // Additional fields from proto
  planModeResponse?: ClinePlanModeResponse;
  askQuestion?: ClineAskQuestion;
}

// State update from StateService.subscribeToState
export interface StateUpdate {
  stateJson: string;
}

// Task response types
export enum AskResponseType {
  MESSAGE_RESPONSE = "messageResponse",
  YES_BUTTON_CLICKED = "yesButtonClicked",
  NO_BUTTON_CLICKED = "noButtonClicked",
}

// gRPC service request/response types
// These match the proto definitions in proto/cline/task.proto
export interface NewTaskRequest {
  text: string;
  images?: string[]; // File paths to images
  files?: string[]; // File paths to attach
}

export interface AskResponseRequest {
  responseType: AskResponseType | string;
  text?: string;
  images?: string[];
  files?: string[];
}

export type EmptyRequest = object;

// Empty metadata message required by many Cline gRPC requests
export type Metadata = object;

export interface TogglePlanActModeRequest {
  metadata: Metadata;
  mode: PlanActMode;
}

export interface AutoApprovalActions {
  readFiles?: boolean;
  editFiles?: boolean;
  executeAllCommands?: boolean;
  executeCommands?: string[];
  listFiles?: boolean;
  searchFiles?: boolean;
  useMcp?: boolean;
  browserAction?: boolean;
}

export interface AutoApprovalSettingsRequest {
  actions: AutoApprovalActions;
}

// API Provider enum - matches proto/cline/models.proto ApiProvider
export enum ApiProvider {
  ANTHROPIC = "ANTHROPIC",
  OPENROUTER = "OPENROUTER",
  BEDROCK = "BEDROCK",
  VERTEX = "VERTEX",
  OPENAI = "OPENAI",
  OLLAMA = "OLLAMA",
  LMSTUDIO = "LMSTUDIO",
  GEMINI = "GEMINI",
  OPENAI_NATIVE = "OPENAI_NATIVE",
  REQUESTY = "REQUESTY",
  TOGETHER = "TOGETHER",
  DEEPSEEK = "DEEPSEEK",
  QWEN = "QWEN",
  DOUBAO = "DOUBAO",
  MISTRAL = "MISTRAL",
  VSCODE_LM = "VSCODE_LM",
  CLINE = "CLINE",
  LITELLM = "LITELLM",
  NEBIUS = "NEBIUS",
  FIREWORKS = "FIREWORKS",
  ASKSAGE = "ASKSAGE",
  XAI = "XAI",
  SAMBANOVA = "SAMBANOVA",
  CEREBRAS = "CEREBRAS",
  GROQ = "GROQ",
  SAPAICORE = "SAPAICORE",
  CLAUDE_CODE = "CLAUDE_CODE",
  MOONSHOT = "MOONSHOT",
  HUGGINGFACE = "HUGGINGFACE",
  HUAWEI_CLOUD_MAAS = "HUAWEI_CLOUD_MAAS",
  BASETEN = "BASETEN",
  ZAI = "ZAI",
  VERCEL_AI_GATEWAY = "VERCEL_AI_GATEWAY",
  QWEN_CODE = "QWEN_CODE",
  DIFY = "DIFY",
  OCA = "OCA",
  MINIMAX = "MINIMAX",
  HICAP = "HICAP",
  AIHUBMIX = "AIHUBMIX",
  NOUSRESEARCH = "NOUSRESEARCH",
}

// ModelsApiConfiguration - matches proto/cline/models.proto ModelsApiConfiguration
// This is the full API configuration structure used in UpdateSettingsRequest
// We only define the fields we currently use - the proto has 238+ fields
export interface ModelsApiConfiguration {
  // Global API configuration
  apiKey?: string;
  clineApiKey?: string;

  // Provider-specific API keys
  openRouterApiKey?: string;
  xaiApiKey?: string;
  openAiNativeApiKey?: string;
  anthropicBaseUrl?: string;

  // Plan mode configuration (fields 100-138 in proto)
  planModeApiProvider?: ApiProvider | string;
  planModeApiModelId?: string; // field 101 - generic model ID
  planModeOpenRouterModelId?: string; // field 107 - OpenRouter/Cline provider model ID
  planModeOpenRouterModelInfo?: OpenRouterModelInfo; // field 108 - OpenRouter model metadata
  planModeOpenAiModelId?: string; // field 109 - OpenAI provider model ID
  planModeOllamaModelId?: string; // field 111 - Ollama provider model ID
  planModeGroqModelId?: string; // field 121 - Groq provider model ID

  // Act mode configuration (fields 200-238 in proto)
  actModeApiProvider?: ApiProvider | string;
  actModeApiModelId?: string; // field 201 - generic model ID
  actModeOpenRouterModelId?: string; // field 207 - OpenRouter/Cline provider model ID
  actModeOpenRouterModelInfo?: OpenRouterModelInfo; // field 208 - OpenRouter model metadata
  actModeOpenAiModelId?: string; // field 209 - OpenAI provider model ID
  actModeOllamaModelId?: string; // field 211 - Ollama provider model ID
  actModeGroqModelId?: string; // field 221 - Groq provider model ID
}

export interface UpdateSettingsRequest {
  apiConfiguration?: ModelsApiConfiguration;
  mode?: PlanActMode;
  yoloModeToggled?: boolean;
}

// gRPC stream types
export interface AsyncIterableStream<T> extends AsyncIterable<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

// Cline gRPC services
export interface TaskService {
  newTask(request: NewTaskRequest): Promise<string>;
  askResponse(request: AskResponseRequest): Promise<void>;
  cancelTask(request: EmptyRequest): Promise<void>;
  taskFeedback(request: { value: string }): Promise<void>;
}

export interface StateService {
  subscribeToState(request?: EmptyRequest): AsyncIterableStream<StateUpdate>;
  getLatestState(request?: EmptyRequest): Promise<StateUpdate>;
  togglePlanActModeProto(request: TogglePlanActModeRequest): Promise<void>;
  updateAutoApprovalSettings(request: AutoApprovalSettingsRequest): Promise<void>;
  updateSettings(request: UpdateSettingsRequest): Promise<void>;
  updateTaskSettings(request: { value: string }): Promise<void>;
  getProcessInfo(request?: EmptyRequest): Promise<{ pid: number; address: string }>;
}

export interface UiService {
  subscribeToPartialMessage(request?: EmptyRequest): AsyncIterableStream<ClineMessage>;
}

// OpenRouter model info returned from ModelsService
export interface OpenRouterModelInfo {
  maxTokens?: number;
  contextWindow?: number;
  supportsImages?: boolean;
  supportsPromptCache?: boolean;
  inputPrice?: number;
  outputPrice?: number;
  cacheWritesPrice?: number;
  cacheReadsPrice?: number;
  description?: string;
  name?: string;
  temperature?: number;
  supportsReasoning?: boolean;
}

// Response from refreshOpenRouterModelsRpc
export interface OpenRouterModelsResponse {
  models: Record<string, OpenRouterModelInfo>;
}

export interface ModelsService {
  refreshOpenRouterModels(request?: EmptyRequest): Promise<OpenRouterModelsResponse>;
}

// Combined Cline client
export interface ClineClient {
  Task: TaskService;
  State: StateService;
  Ui: UiService;
  Models: ModelsService;
}

// Cline process instance
export interface ClineInstance {
  pid: number;
  address: string;
  clineCorePid: number;
  clineHostPid: number;
}

// Session state for ClineAcpAgent
export interface ClineSession {
  id: string;
  taskId: string;
  stateStream: AsyncIterableStream<StateUpdate>;
  partialStream: AsyncIterableStream<ClineMessage>;
  cancelled: boolean;
  mode: "plan" | "act";
  isTaskCreated?: boolean; // Track whether we've sent the first message to Cline
  // Track if we're waiting for user feedback in chat for a specific tool call
  pendingCorrection?: {
    toolCallId: string;
    ts: number;
  };
  // Cost tracking
  totalCost: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheWrites: number;
  totalCacheReads: number;
}

// Cline prompt format - matches NewTaskRequest
export interface ClinePrompt {
  text: string;
  images?: string[]; // File paths to images
  files?: string[]; // File paths to attach
}

// Tool info parsed from Cline messages
export interface ClineToolInfo {
  type: string;
  title: string;
  input: Record<string, unknown>;
  path?: string;
  line?: number;
  content?: string; // Tool output or file content
  diff?: string; // Diff for file edit operations
}

// Cost info extracted from api_req_started messages
export interface ClineCostInfo {
  tokensIn: number;
  tokensOut: number;
  cacheWrites: number;
  cacheReads: number;
  cost: number;
}

export type PermissionOutcome = 
  | { outcome: "selected"; optionId: "allow" | "allow_always" | "reject" | "edit" }
  | { outcome: "dismissed" }
  | { outcome: "error"; message: string };
