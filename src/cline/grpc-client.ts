/**
 * Cline gRPC Client - Connects to cline-core via gRPC
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import {
  ClineClient,
  ClineMessage,
  StateUpdate,
  PlanActMode,
  AsyncIterableStream,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find the proto directory - it's at the package root
// When running from dist/cline/grpc-client.js, we need to go up to find proto/
function findProtoDir(): string {
  // Try relative path first (works when proto/ is at package root)
  const candidates = [
    path.join(__dirname, "../../proto"),      // from dist/cline/
    path.join(__dirname, "../proto"),         // from dist/
    path.join(process.cwd(), "proto"),        // from cwd
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "cline/task.proto"))) {
      return candidate;
    }
  }

  // Fallback to the expected location
  return path.join(__dirname, "../../proto");
}

const PROTO_DIR = findProtoDir();

// Proto loader options
const PROTO_OPTIONS: protoLoader.Options = {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
};

// gRPC service clients
interface GrpcServiceClient {
  [key: string]: (...args: unknown[]) => unknown;
}

/**
 * Load proto definition and create client
 */
function loadProtoClient(
  protoFile: string,
  serviceName: string,
  address: string,
): GrpcServiceClient {
  const packageDef = protoLoader.loadSync(protoFile, PROTO_OPTIONS);
  const grpcObject = grpc.loadPackageDefinition(packageDef);

  // Navigate to the service (cline.ServiceName)
  const clinePackage = grpcObject.cline as Record<string, unknown>;
  const ServiceClass = clinePackage[serviceName] as new (
    address: string,
    credentials: grpc.ChannelCredentials,
  ) => GrpcServiceClient;

  return new ServiceClass(address, grpc.credentials.createInsecure());
}

/**
 * Convert gRPC server streaming call to AsyncIterable
 */
function streamToAsyncIterable<T>(
  callFn: () => grpc.ClientReadableStream<T>,
): AsyncIterableStream<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const stream = callFn();

      const queue: T[] = [];
      let resolve: ((value: IteratorResult<T>) => void) | null = null;
      let done = false;
      let error: Error | null = null;

      stream.on("data", (data: T) => {
        if (resolve) {
          resolve({ value: data, done: false });
          resolve = null;
        } else {
          queue.push(data);
        }
      });

      stream.on("end", () => {
        done = true;
        if (resolve) {
          resolve({ value: undefined as unknown as T, done: true });
          resolve = null;
        }
      });

      stream.on("error", (err: Error) => {
        error = err;
        done = true;
        if (resolve) {
          resolve({ value: undefined as unknown as T, done: true });
          resolve = null;
        }
      });

      while (true) {
        if (error) throw error;

        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (done) {
          return;
        } else {
          const result = await new Promise<IteratorResult<T>>((res) => {
            resolve = res;
          });
          if (result.done) return;
          yield result.value;
        }
      }
    },
  };
}

/**
 * Promisify a unary gRPC call
 */
function promisifyUnary<TReq, TRes>(
  client: GrpcServiceClient,
  methodName: string,
): (request: TReq) => Promise<TRes> {
  return (request: TReq): Promise<TRes> => {
    return new Promise((resolve, reject) => {
      const method = client[methodName] as (
        request: TReq,
        callback: (error: Error | null, response: TRes) => void,
      ) => void;

      method.call(client, request, (error, response) => {
        if (error) reject(error);
        else resolve(response);
      });
    });
  };
}

/**
 * Create a Cline gRPC client connected to the specified address
 */
export async function createClineClient(address: string): Promise<ClineClient> {
  const protoDir = path.join(PROTO_DIR, "cline");

  // Load service clients
  const taskClient = loadProtoClient(
    path.join(protoDir, "task.proto"),
    "TaskService",
    address,
  );

  const stateClient = loadProtoClient(
    path.join(protoDir, "state.proto"),
    "StateService",
    address,
  );

  const uiClient = loadProtoClient(
    path.join(protoDir, "ui.proto"),
    "UiService",
    address,
  );

  return {
    Task: {
      async newTask(request): Promise<string> {
        const response = await promisifyUnary<typeof request, { value: string }>(
          taskClient,
          "newTask",
        )(request);
        return response.value;
      },

      async askResponse(request): Promise<void> {
        await promisifyUnary<typeof request, Record<string, never>>(
          taskClient,
          "askResponse",
        )(request);
      },

      async cancelTask(): Promise<void> {
        await promisifyUnary<Record<string, never>, Record<string, never>>(
          taskClient,
          "cancelTask",
        )({});
      },
    },

    State: {
      subscribeToState(): AsyncIterableStream<StateUpdate> {
        return streamToAsyncIterable(() =>
          (stateClient.subscribeToState as (req: Record<string, never>) => grpc.ClientReadableStream<StateUpdate>)({}),
        );
      },

      async getLatestState(): Promise<StateUpdate> {
        return promisifyUnary<Record<string, never>, StateUpdate>(
          stateClient,
          "getLatestState",
        )({});
      },

      async togglePlanActModeProto(request): Promise<void> {
        await promisifyUnary<typeof request, { value: boolean }>(
          stateClient,
          "togglePlanActModeProto",
        )(request);
      },

      async updateAutoApprovalSettings(request): Promise<void> {
        await promisifyUnary<typeof request, Record<string, never>>(
          stateClient,
          "updateAutoApprovalSettings",
        )(request);
      },

      async updateSettings(request): Promise<void> {
        await promisifyUnary<typeof request, Record<string, never>>(
          stateClient,
          "updateSettings",
        )(request);
      },

      async getProcessInfo(): Promise<{ pid: number; address: string }> {
        const response = await promisifyUnary<
          Record<string, never>,
          { processId: number; version?: string }
        >(stateClient, "getProcessInfo")({});
        return { pid: response.processId, address };
      },
    },

    Ui: {
      subscribeToPartialMessage(): AsyncIterableStream<ClineMessage> {
        return streamToAsyncIterable(() =>
          (uiClient.subscribeToPartialMessage as (req: Record<string, never>) => grpc.ClientReadableStream<ClineMessage>)({}),
        );
      },
    },
  };
}

/**
 * Wait for gRPC server to be ready
 */
export async function waitForGrpcReady(
  address: string,
  timeoutMs: number = 30000,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const client = await createClineClient(address);
      await client.State.getProcessInfo();
      return true;
    } catch {
      // Server not ready yet, wait and retry
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return false;
}
