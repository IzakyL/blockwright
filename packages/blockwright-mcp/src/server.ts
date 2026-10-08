import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorToString } from "@izakyl/blockwright-client";
import { budgetedJson } from "./budget.js";
import { BlockwrightSession } from "./session.js";
import type { SessionOptions } from "./session.js";
import { DEFAULT_CAPS, selectTools } from "./tools.js";
import type { Cap } from "./tools.js";

export interface CreateServerOptions extends SessionOptions {
  caps?: Cap[];
  session?: BlockwrightSession;
}

export interface CreatedServer {
  server: McpServer;
  session: BlockwrightSession;
}

export function createServer(options: CreateServerOptions = {}): CreatedServer {
  const session = options.session ?? new BlockwrightSession(options);
  const server = new McpServer(
    { name: "blockwright", version: createRequire(import.meta.url)("../package.json").version },
    {
      instructions:
        "Drives a live Minecraft client and server through Blockwright. blockwright_launch starts a fresh "
        + "pair that belongs to this session. Ticks are frozen by default, so the world holds still between your calls "
        + "and only moves when you call blockwright_tick — the same freeze the test runner uses, which is why "
        + "what you find here reproduces in a spec. Every action answers with what changed on the client. "
        + "Set up state with blockwright_command, or with blockwright_task when no command reaches it — a Java "
        + "task (whole source, a run(ctx) body, or a .java file, with library modules loaded first) that runs in "
        + "the game and can call the mod's own code. Observe with blockwright_observe "
        + "(mode=evidence gives what a failing test attaches), "
        + "blockwright_query, blockwright_logs and blockwright_screenshot (bounds + preset frames a build from "
        + "every side). A round trip costs far more than the "
        + "work, so carry a whole intent per call: blockwright_batch for a sequence, tick until "
        + "for a condition, one screenshot for several cameras. When the flow works, blockwright_export "
        + "op=spec writes it as a Playwright test. Screens are read through UI adapters, "
        + `each a layer of the [eN] refs: ${session.ui.adapters().map((adapter) => `${adapter.id} (${adapter.summary})`).join("; ")}.`,
    },
  );

  for (const tool of selectTools(options.caps ?? DEFAULT_CAPS)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive ?? false,
          idempotentHint: tool.idempotent ?? false,
          openWorldHint: false,
        },
      },
      (async (args: Record<string, unknown>) => {
        try {
          return (await tool.handler(session, args ?? {})) as never;
        } catch (error) {
          return {
            content: [{ type: "text", text: describeToolError(error) }],
            isError: true,
          } as never;
        }
      }) as never,
    );
  }

  return { server, session };
}


/**
 * A tool failure as an agent needs it: the error's name and message, the game's detail (compile diagnostics,
 * what a wait last saw) when there is one, and a stack only for errors that are bugs rather than answers.
 */
export function describeToolError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const detail = (error as { detail?: unknown }).detail;
  const answered = detail !== undefined || /^(Minecraft|Blockwright|World|Session)\w*Error$/.test(error.name);
  const lines = [`${error.name}: ${error.message}`];
  if (detail !== undefined) lines.push(`detail:\n${budgetedJson(detail, { maxItems: 20, maxDepth: 5, maxString: 2000 })}`);
  return answered ? lines.join("\n") : errorToString(error);
}
