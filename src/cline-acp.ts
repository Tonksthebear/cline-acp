/**
 * Cline ACP Agent runner
 */

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";
import { ClineAcpAgent } from "./cline/cline-acp-agent.js";

export function runClineAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  // Enable verbose logging with CLINE_ACP_VERBOSE=1 or CLINE_ACP_DEBUG=1
  const verbose =
    process.env.CLINE_ACP_VERBOSE === "1" ||
    process.env.CLINE_ACP_VERBOSE === "true" ||
    process.env.CLINE_ACP_DEBUG === "1" ||
    process.env.CLINE_ACP_DEBUG === "true";

  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => {
    const agent = new ClineAcpAgent({
      verbose,
      // autoStart and useExisting default to true
    });
    agent.setClient(client);
    return agent;
  }, stream);
}
