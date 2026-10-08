import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import type { GameConnection } from "./game-channel.js";
import type { TaskSpec } from "./run.js";

/** One run the fake agent received. */
export interface FakeRun {
  id: number;
  task: TaskSpec;
  socket: Socket;
  emit(value: unknown): void;
  /** One binary output; `chunks` splits the frame (header and payload together) into writes of these sizes. */
  emitBytes(data: Buffer, meta?: unknown, chunks?: number[]): Promise<void>;
  end(status: "ok" | "cancelled"): void;
  fail(error: { code: string; message: string; detail?: unknown }): void;
  /** Replaces the default reaction to a cancel request (ending the run `cancelled`). */
  onCancel(listener: () => void): void;
  /** Resolves when the client asked to cancel or the connection closed. */
  readonly stopped: Promise<"cancel" | "disconnect">;
}

export interface FakeAgentOptions {
  token?: string;
  /** Called for every run; the default ends it ok with its args echoed as one output. */
  onRun?(run: FakeRun): void | Promise<void>;
  /** Answers `load`, `unload` and `status`; a thrown `{code, message}` becomes an error reply. */
  onRequest?(frame: Record<string, any>): unknown | Promise<unknown>;
  /** What the welcome says; defaults to the real protocol. */
  welcome?: Record<string, unknown>;
}

export interface FakeAgent {
  descriptor: GameConnection;
  /** Every client frame after the handshake, in order. */
  frames: Array<Record<string, any>>;
  /** Connections accepted so far. */
  connections(): number;
  /** Open sockets. */
  sockets(): Socket[];
  /** Destroys every open connection. */
  drop(): void;
  close(): Promise<void>;
}

/** A game agent speaking the game channel protocol from neoforge-agent/API.md, in this process. */
export async function startFakeAgent(options: FakeAgentOptions = {}): Promise<FakeAgent> {
  const token = options.token ?? "test-token";
  const sockets = new Set<Socket>();
  const frames: Array<Record<string, any>> = [];
  let accepted = 0;
  const server: Server = createServer((socket) => {
    accepted++;
    sockets.add(socket);
    socket.setNoDelay(true);
    const runs = new Map<number, { cancel(): void; disconnect(): void }>();
    socket.on("close", () => {
      sockets.delete(socket);
      for (const run of runs.values()) run.disconnect();
      runs.clear();
    });
    socket.on("error", () => {});
    const send = (frame: unknown) => {
      if (!socket.destroyed) socket.write(JSON.stringify(frame) + "\n");
    };
    let authenticated = false;
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (!authenticated) {
          if (frame.token !== token) {
            socket.destroy();
            return;
          }
          authenticated = true;
          send(options.welcome ?? { type: "welcome", protocol: "blockwright-game" });
          continue;
        }
        frames.push(frame);
        void handle(frame);
      }
    });

    async function handle(frame: Record<string, any>): Promise<void> {
      if (frame.op === "run") {
        let ended = false;
        let cancelListener: (() => void) | undefined;
        let stop!: (why: "cancel" | "disconnect") => void;
        const stopped = new Promise<"cancel" | "disconnect">((resolve) => (stop = resolve));
        const endWith = (value: Record<string, unknown>) => {
          if (ended) return;
          ended = true;
          runs.delete(frame.id);
          send({ run: frame.id, ...value });
        };
        const run: FakeRun = {
          id: frame.id,
          task: frame.task,
          socket,
          stopped,
          emit: (value) => send({ run: frame.id, out: value }),
          emitBytes: async (data, meta = null, chunks) => {
            const whole = Buffer.concat([Buffer.from(JSON.stringify({ run: frame.id, bytes: data.length, meta }) + "\n"), data]);
            if (!chunks) {
              socket.write(whole);
              return;
            }
            let offset = 0;
            for (const size of chunks) {
              socket.write(whole.subarray(offset, offset + size));
              offset += size;
              await new Promise((resolve) => setTimeout(resolve, 2));
            }
            if (offset < whole.length) socket.write(whole.subarray(offset));
          },
          end: (status) => endWith({ end: status }),
          fail: (error) => endWith({ end: "error", error }),
          onCancel: (listener) => {
            cancelListener = listener;
          },
        };
        runs.set(frame.id, {
          cancel: () => {
            stop("cancel");
            if (cancelListener) cancelListener();
            else run.end("cancelled");
          },
          disconnect: () => {
            ended = true;
            stop("disconnect");
          },
        });
        if (options.onRun) await options.onRun(run);
        else {
          if (frame.task.args !== undefined) run.emit(frame.task.args);
          run.end("ok");
        }
        return;
      }
      if (frame.op === "cancel") {
        const run = runs.get(frame.run);
        if (!run) {
          send({ id: frame.id, error: { code: "unknown-run", message: `no live run ${frame.run}` } });
          return;
        }
        send({ id: frame.id, result: { cancelled: true } });
        run.cancel();
        return;
      }
      try {
        const result = options.onRequest ? await options.onRequest(frame) : defaultAnswer(frame);
        send({ id: frame.id, result: result ?? null });
      } catch (error) {
        const { code, message } = error as { code?: string; message?: string };
        send({ id: frame.id, error: { code: code ?? "error", message: message ?? String(error) } });
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    descriptor: { protocol: "blockwright-game", host: "127.0.0.1", port, token },
    frames,
    connections: () => accepted,
    sockets: () => [...sockets],
    drop: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function defaultAnswer(frame: Record<string, any>): unknown {
  switch (frame.op) {
    case "load":
      return { loaded: frame.module.name };
    case "unload":
      return { unloaded: frame.all ? "all" : frame.module };
    case "status":
      return { runs: 0, modules: [] };
    default:
      throw { code: "unknown-op", message: `unknown op ${frame.op}` };
  }
}
