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
export interface NewTaskRequest {
  text: string;
  images: string[];
  files: string[];
}

export interface AskResponseRequest {
  responseType: AskResponseType | string;
  text: string;
  images: string[];
  files: string[];
}

export interface EmptyRequest {}

// Empty metadata message required by many Cline gRPC requests
export interface Metadata {}

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

export interface UpdateSettingsRequest {
  apiConfiguration?: {
    apiModelId?: string;
    apiProvider?: string;
  };
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
}

export interface StateService {
  subscribeToState(request?: EmptyRequest): AsyncIterableStream<StateUpdate>;
  getLatestState(request?: EmptyRequest): Promise<StateUpdate>;
  togglePlanActModeProto(request: TogglePlanActModeRequest): Promise<void>;
  updateAutoApprovalSettings(request: AutoApprovalSettingsRequest): Promise<void>;
  updateSettings(request: UpdateSettingsRequest): Promise<void>;
  getProcessInfo(request?: EmptyRequest): Promise<{ pid: number; address: string }>;
}

export interface UiService {
  subscribeToPartialMessage(request?: EmptyRequest): AsyncIterableStream<ClineMessage>;
}

// Combined Cline client
export interface ClineClient {
  Task: TaskService;
  State: StateService;
  Ui: UiService;
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
}

// Cline prompt format (converted from ACP)
export interface ClinePrompt {
  text: string;
  images: string[];
  files: string[];
}

// Tool info parsed from Cline messages
export interface ClineToolInfo {
  type: string;
  title: string;
  input: Record<string, unknown>;
  path?: string;
}
