/**
 * Cline Process Manager - Uses the cline CLI to manage instances
 */

import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { ClineInstance } from "./types.js";
import { waitForGrpcReady } from "./grpc-client.js";

export interface ProcessManagerOptions {
  clinePath?: string;
  verbose?: boolean;
  // If true, use an existing Cline instance if available instead of creating a new one
  useExisting?: boolean;
}

/**
 * Find cline binary path
 * Uses 'cline' from PATH - the system should have the correct version configured
 */
function findClinePath(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  // Just use "cline" and let the shell resolve it from PATH
  // This respects the user's mise/nvm/asdf configuration
  return "cline";
}

/**
 * Parse instance info from cline instance list output
 */
interface InstanceInfo {
  address: string;
  pid: number;
  isDefault: boolean;
}

function parseInstanceList(output: string): InstanceInfo[] {
  const instances: InstanceInfo[] = [];
  const lines = output.trim().split("\n");

  for (const line of lines) {
    // Skip header line
    if (line.startsWith("ADDRESS") || line.trim() === "") continue;

    // Parse table format:
    // ADDRESS          STATUS   VERSION  LAST SEEN  PID    PLATFORM  DEFAULT
    // 127.0.0.1:61397  SERVING  3.37.0   12:19:14   66268  CLI       ✓
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5) {
      const address = parts[0];
      // PID is at index 4 in the table format
      const pid = parseInt(parts[4], 10);
      const isDefault = line.includes("✓") || parts.includes("✓");

      if (address.match(/^(localhost|127\.0\.0\.1):\d+$/) && !isNaN(pid)) {
        instances.push({
          isDefault,
          address,
          pid,
        });
      }
    }
  }

  return instances;
}

export class ClineProcessManager {
  private options: ProcessManagerOptions;
  private instance: ClineInstance | null = null;
  private clinePath: string;
  private usingExistingInstance: boolean = false;

  constructor(options: ProcessManagerOptions = {}) {
    this.options = {
      verbose: options.verbose || false,
      useExisting: options.useExisting ?? true, // Default to using existing instances
      ...options,
    };
    this.clinePath = findClinePath(options.clinePath);
  }

  /**
   * Get existing Cline instances
   */
  getExistingInstances(): InstanceInfo[] {
    try {
      const listOutput = execSync(`${this.clinePath} instance list --output-format plain`, {
        encoding: "utf-8",
      });
      return parseInstanceList(listOutput);
    } catch {
      return [];
    }
  }

  /**
   * Start or connect to a Cline instance
   * If useExisting is true and an instance is available, connects to it
   * Otherwise creates a new instance
   */
  async startInstance(): Promise<ClineInstance> {
    // Check for existing instances first if useExisting is enabled
    if (this.options.useExisting) {
      const existingInstances = this.getExistingInstances();

      if (existingInstances.length > 0) {
        // Prefer the default instance, otherwise use the first one
        const instance = existingInstances.find((i) => i.isDefault) || existingInstances[0];

        if (this.options.verbose) {
          console.log(`Using existing Cline instance at ${instance.address}`);
        }

        // Verify the instance is reachable
        const ready = await waitForGrpcReady(instance.address, 5000);
        if (ready) {
          this.usingExistingInstance = true;
          this.instance = {
            pid: instance.pid,
            address: instance.address,
            clineCorePid: instance.pid,
            clineHostPid: instance.pid,
          };
          return this.instance;
        } else if (this.options.verbose) {
          console.log(`Existing instance at ${instance.address} is not reachable, creating new one...`);
        }
      }
    }

    // Create a new instance
    if (this.options.verbose) {
      console.log("Creating new Cline instance...");
    }

    // Create a new instance using cline CLI
    // Note: Do NOT pass --verbose to cline CLI as it causes failures
    const args = ["instance", "new", "--output-format", "plain"];

    try {
      const result = execSync(`${this.clinePath} ${args.join(" ")}`, {
        encoding: "utf-8",
        timeout: 30000,
      });

      if (this.options.verbose) {
        console.log("Instance creation output:", result);
      }

      // Parse the address from the output
      // Output format:
      //   Successfully started new instance:
      //     Address: 127.0.0.1:61809
      const addressMatch = result.match(/(localhost|127\.0\.0\.1):\d+/);
      if (!addressMatch) {
        throw new Error(`Could not parse instance address from output: ${result}`);
      }

      const address = addressMatch[0];

      // Wait for gRPC server to be ready
      if (this.options.verbose) {
        console.log(`Waiting for services at ${address} to start...`);
      }

      const ready = await waitForGrpcReady(address, 30000);
      if (!ready) {
        throw new Error("Cline services failed to start within 30 seconds");
      }

      if (this.options.verbose) {
        console.log("Services started successfully!");
      }

      // Get the PID from instance list
      const listOutput = execSync(`${this.clinePath} instance list --output-format plain`, {
        encoding: "utf-8",
      });

      const instances = parseInstanceList(listOutput);
      const instanceInfo = instances.find((i) => i.address === address);
      const pid = instanceInfo?.pid || 0;

      this.usingExistingInstance = false;
      this.instance = {
        pid,
        address,
        clineCorePid: pid,
        clineHostPid: pid, // In the new architecture, it's a single process
      };

      return this.instance;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create Cline instance: ${message}`);
    }
  }

  /**
   * Stop the current instance
   * Only kills instances that were created by this manager, not pre-existing ones
   */
  async stopInstance(): Promise<void> {
    if (!this.instance) return;

    // Don't kill instances we didn't create
    if (this.usingExistingInstance) {
      if (this.options.verbose) {
        console.log("Not stopping pre-existing instance");
      }
      this.instance = null;
      return;
    }

    try {
      execSync(`${this.clinePath} instance kill ${this.instance.address}`, {
        encoding: "utf-8",
        timeout: 10000,
      });
    } catch {
      // Instance may have already exited
      if (this.options.verbose) {
        console.log("Instance may have already stopped");
      }
    }

    this.instance = null;
  }

  /**
   * Check if using a pre-existing instance
   */
  isUsingExistingInstance(): boolean {
    return this.usingExistingInstance;
  }

  /**
   * Get the current instance info
   */
  getInstance(): ClineInstance | null {
    return this.instance;
  }

  /**
   * Check if an instance is running
   */
  isRunning(): boolean {
    return this.instance !== null;
  }
}

/**
 * Create and start a new Cline process manager
 */
export async function startClineProcesses(
  options: ProcessManagerOptions = {},
): Promise<{ manager: ClineProcessManager; instance: ClineInstance }> {
  const manager = new ClineProcessManager(options);
  const instance = await manager.startInstance();
  return { manager, instance };
}
