/**
 * Integration tests for Cline ACP Agent
 *
 * These tests verify the integration with actual Cline processes.
 * Requires a running Cline instance. Start one with: `cline instance new`
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  ClineAcpAgent,
  ClineProcessManager,
  createClineClient,
  waitForGrpcReady,
} from "../cline/index.js";

describe("ClineAcpAgent Integration Tests", () => {
    let processManager: ClineProcessManager;
    let address: string;
    let setupError: Error | null = null;

    beforeAll(async () => {
      processManager = new ClineProcessManager({
        verbose: true,
        useExisting: true,
      });

      try {
        const instance = await processManager.startInstance();
        address = instance.address;

        if (processManager.isUsingExistingInstance()) {
          console.log(`Connected to existing Cline instance at ${address}`);
        } else {
          console.log(`Created new Cline instance at ${address}`);
        }
      } catch (error) {
        setupError = error instanceof Error ? error : new Error(String(error));
      }
    }, 120000);

    afterAll(async () => {
      if (processManager) {
        await processManager.stopInstance();
      }
    });

    // Helper to check if we can run tests
    function requireClineInstance() {
      if (setupError) {
        throw new Error(
          `No Cline instance available. Start one with: cline instance new\n\n` +
          `Original error: ${setupError.message}`
        );
      }
    }

    it("should connect to Cline gRPC server", async () => {
      requireClineInstance();
      const client = await createClineClient(address);
      const info = await client.State.getProcessInfo();
      expect(info.pid).toBeGreaterThan(0);
      expect(info.address).toBe(address);
    });

    it("should create a new task", async () => {
      requireClineInstance();
      const client = await createClineClient(address);
      const taskId = await client.Task.newTask({
        text: "Hello, this is a test task",
        images: [],
        files: [],
      });
      expect(taskId).toBeDefined();
      expect(typeof taskId).toBe("string");
    });

    it("should subscribe to state updates", async () => {
      requireClineInstance();
      const client = await createClineClient(address);
      const stateStream = client.State.subscribeToState();

      let stateReceived = false;
      for await (const state of stateStream) {
        expect(state.stateJson).toBeDefined();
        stateReceived = true;
        break;
      }

      expect(stateReceived).toBe(true);
    });

    it("should toggle plan/act mode", async () => {
      requireClineInstance();
      const client = await createClineClient(address);

      await client.State.togglePlanActModeProto({
        metadata: {},
        mode: "act" as any,
      });

      await client.State.togglePlanActModeProto({
        metadata: {},
        mode: "plan" as any,
      });
    });
  });

// Unit tests for ClineProcessManager
describe("ClineProcessManager Unit Tests", () => {
  it("should report not running initially", () => {
    const manager = new ClineProcessManager();
    expect(manager.isRunning()).toBe(false);
    expect(manager.getInstance()).toBeNull();
  });
});

describe("waitForGrpcReady Unit Tests", () => {
  it("should return false when server is unreachable", async () => {
    // Use a port that's definitely not running a gRPC server
    const result = await waitForGrpcReady("localhost:59999", 1000);
    expect(result).toBe(false);
  }, 5000);
});

describe("ClineAcpAgent with AutoStart", () => {
  it("should have autoStart option in constructor", () => {
    const agent = new ClineAcpAgent({
      autoStart: true,
      verbose: false,
    });

    // ProcessManager should not be created until initialize() is called
    expect(agent.getProcessManager()).toBeNull();
  });

  it("should not auto-start when clineClient is injected", async () => {
    const mockClient = {
      Task: {
        newTask: vi.fn().mockResolvedValue("task-123"),
        askResponse: vi.fn().mockResolvedValue(undefined),
        cancelTask: vi.fn().mockResolvedValue(undefined),
      },
      State: {
        subscribeToState: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {},
        }),
        getLatestState: vi.fn().mockResolvedValue({ stateJson: "{}" }),
        togglePlanActModeProto: vi.fn().mockResolvedValue(undefined),
        updateAutoApprovalSettings: vi.fn().mockResolvedValue(undefined),
        updateSettings: vi.fn().mockResolvedValue(undefined),
        getProcessInfo: vi.fn().mockResolvedValue({ pid: 123, address: "localhost:50051" }),
      },
      Ui: {
        subscribeToPartialMessage: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {},
        }),
      },
    };

    const agent = new ClineAcpAgent({
      autoStart: true,
      clineClient: mockClient as any,
    });

    // Mock the ACP client
    agent.setClient({
      sessionUpdate: vi.fn(),
      requestPermission: vi.fn(),
    } as any);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });

    // Should use injected client, not start processes
    expect(agent.getProcessManager()).toBeNull();
    expect(agent.getClineClient()).toBe(mockClient);
  });

  it("should shutdown cleanly", async () => {
    const mockClient = {
      Task: {
        newTask: vi.fn().mockResolvedValue("task-123"),
        askResponse: vi.fn().mockResolvedValue(undefined),
        cancelTask: vi.fn().mockResolvedValue(undefined),
      },
      State: {
        subscribeToState: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {},
        }),
        getLatestState: vi.fn().mockResolvedValue({ stateJson: "{}" }),
        togglePlanActModeProto: vi.fn().mockResolvedValue(undefined),
        updateAutoApprovalSettings: vi.fn().mockResolvedValue(undefined),
        updateSettings: vi.fn().mockResolvedValue(undefined),
        getProcessInfo: vi.fn().mockResolvedValue({ pid: 123, address: "localhost:50051" }),
      },
      Ui: {
        subscribeToPartialMessage: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {},
        }),
      },
    };

    const agent = new ClineAcpAgent({
      clineClient: mockClient as any,
    });

    await agent.shutdown();

    // Client should be cleared
    expect(agent.getClineClient()).toBeNull();
  });
});
