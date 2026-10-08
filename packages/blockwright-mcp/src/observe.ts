import { evidence } from "@izakyl/blockwright-minecraft";
import { diffObservations } from "./diff.js";
import type { ToolResult } from "./result.js";
import type { BlockwrightSession } from "./session.js";

/** Answers an action with its header, the settle verdict and what changed on the client since the last look. */
export async function observed(session: BlockwrightSession, header: string, options: { failed?: boolean } = {}): Promise<ToolResult> {
  const sections: string[] = [header];
  const settled = await session.settle();
  if (settled !== undefined) sections.push(settled);
  if (session.uiSections().size > 0) {
    const previous = session.lastObservation();
    const observation = await session.observe();
    if (!previous) {
      sections.push(`\n${evidence.formatObservation(observation)}`);
    } else {
      const changes = diffObservations(previous, observation, { sections: session.uiSections() });
      sections.push(`\n${changes.length > 0 ? changes : "no change visible; blockwright_observe mode=full shows the whole state"}`);
    }
  }
  return { content: [{ type: "text", text: sections.join("\n") }], ...(options.failed ? { isError: true } : {}) };
}
