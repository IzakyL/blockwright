import { Run, type InstanceRole, type ModuleSpec, type Output, type RunEnd, type TaskSpec } from "@izakyl/blockwright-client";
import type { GameInstance } from "./instance.js";

/** What a fake run does: emit these outputs, then end. */
export interface FakeAnswer {
  outputs?: unknown[];
  end?: RunEnd;
}

/** An in-memory GameInstance: records ensured modules and tasks, answers runs from `answer`. */
export class FakeInstance implements GameInstance {
  readonly instanceId: string;
  readonly role: InstanceRole;
  readonly instanceDir: string;
  readonly tracePath: string;
  readonly ensured: string[][] = [];
  readonly tasks: TaskSpec[] = [];
  answer: (task: TaskSpec) => FakeAnswer;

  constructor(role: InstanceRole, answer: (task: TaskSpec) => FakeAnswer = () => ({ outputs: [null] }), id = `${role}-1`) {
    this.role = role;
    this.instanceId = id;
    this.instanceDir = `/nonexistent/${id}`;
    this.tracePath = `/nonexistent/${id}.ndjson`;
    this.answer = answer;
  }

  async ensureModules(modules: readonly ModuleSpec[]) {
    this.ensured.push(modules.map((module) => module.name));
    return { loaded: modules.map((module) => module.name), skipped: [] };
  }

  run<T = unknown>(task: TaskSpec): Run<T> {
    this.tasks.push(task);
    const answer = this.answer(task);
    return new Run<T>((controller) => {
      queueMicrotask(() => {
        for (const value of answer.outputs ?? []) controller.output({ kind: "json", value } as Output<T>);
        controller.end(answer.end ?? { status: "ok" });
      });
      return { cancel: async () => {} };
    });
  }

  /** Tasks whose source mentions `marker`. */
  tasksWith(marker: string): TaskSpec[] {
    return this.tasks.filter((task) => task.source.includes(marker));
  }
}
