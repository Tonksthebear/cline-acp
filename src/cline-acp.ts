/**
 * Cline ACP Agent runner
 */

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";
import { ClineAcpAgent } from "./cline/cline-acp-agent.js";

export function runClineAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  new AgentSideConnection(
    (client) => {
      const agent = new ClineAcpAgent({
        verbose: false,
        // autoStart and useExisting default to true
      });
      agent.setClient(client);
      return agent;
    },
    stream,
  );
}
