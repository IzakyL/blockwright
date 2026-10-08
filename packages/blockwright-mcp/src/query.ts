import { z } from "zod";
import { tick, world } from "@izakyl/blockwright-minecraft";
import { formatDecimal as round } from "@izakyl/blockwright-minecraft/internal";
import type { EntityJson } from "@izakyl/blockwright-minecraft";
import { budgetedJson } from "./budget.js";
import { text } from "./result.js";
import type { ToolResult } from "./result.js";
import { vec3 } from "./schema.js";
import type { Args } from "./schema.js";
import type { BlockwrightSession } from "./session.js";

export const QUERY_DOMAINS = [
  "status",
  "tick",
  "time",
  "players",
  "entities",
  "entity",
  "block",
  "container",
  "region",
  "chunk",
  "biome",
  "gamerules",
  "dimensions",
  "performance",
] as const;

export type QueryDomain = (typeof QUERY_DOMAINS)[number];

const boundsFilter = z.union([
  z.object({ min: vec3, max: vec3 }),
  z.object({ center: vec3, radius: z.number().positive() }),
]);

export const queryShape = {
  domain: z.enum(QUERY_DOMAINS),
  dimension: z.string().optional(),
  position: vec3.optional(),
  min: vec3.optional(),
  max: vec3.optional(),
  cells: z.boolean().optional(),
  states: z.boolean().optional(),
  uuid: z.string().optional(),
  id: z.number().int().optional(),
  types: z.array(z.string()).optional(),
  typePatterns: z.array(z.string()).optional(),
  bounds: boundsFilter.optional(),
  nbt: z.boolean().optional(),
  nbtPath: z.string().optional(),
  inventory: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  durationMs: z.number().int().min(100).max(60_000).optional(),
  sampleIntervalMs: z.number().int().min(1).optional(),
};

export type QueryRequest = Args<typeof queryShape>;

const DEFAULT_LIMIT = 20;

const NBT_LIMITS = { maxDepth: 4, maxItems: 24, maxNodes: 400 };

type Pos = { x: number; y: number; z: number };

const floor = (value: Pos): Pos => ({ x: Math.floor(value.x), y: Math.floor(value.y), z: Math.floor(value.z) });

/** The server's view of the world, one domain per call, through @izakyl/blockwright-minecraft's world queries. */
export async function runQuery(session: BlockwrightSession, request: QueryRequest): Promise<ToolResult> {
  const server = session.server();
  const limit = request.limit ?? DEFAULT_LIMIT;
  const place = request.dimension !== undefined ? { dimension: request.dimension } : {};

  switch (request.domain) {
    case "status":
      return report("status", await world.status(server));
    case "tick":
      return report("tick", await tick.status(server));
    case "time":
      return report("time", await world.time(server, place));
    case "gamerules":
      return report("gamerules", await world.gamerules(server, place), { maxKeys: 200 });
    case "dimensions":
      return report("dimensions", await world.dimensions(server));
    case "players": {
      const players = await world.players(server);
      return request.nbt ? report("players", players) : listed("players", players, players.length, limit);
    }
    case "entities": {
      const filter: world.EntityFilter = {
        ...place,
        limit,
        ...(request.types ? { types: request.types } : {}),
        ...(request.typePatterns ? { typePatterns: request.typePatterns } : {}),
        ...(request.bounds ? { bounds: "center" in request.bounds
          ? { center: floor(request.bounds.center), radius: request.bounds.radius }
          : { min: floor(request.bounds.min), max: floor(request.bounds.max) } } : {}),
        ...(request.nbt ? { nbt: true, nbtLimits: NBT_LIMITS } : {}),
        ...(request.nbtPath ? { nbtPath: request.nbtPath } : {}),
      };
      const found = await world.entities(server, filter);
      if (request.nbt) return report("entities", found);
      const more = found.count > found.entities.length
        ? `\n… ${found.count - found.entities.length} more; raise limit (currently ${limit}) or narrow with types/bounds`
        : "";
      return listed("entities", found.entities, found.count, limit, more);
    }
    case "entity": {
      const ref = request.uuid !== undefined ? { uuid: request.uuid, ...(request.id !== undefined ? { id: request.id } : {}) }
        : request.id !== undefined ? { id: request.id } : undefined;
      if (!ref) throw new Error("domain entity needs uuid or id");
      const found = await world.entity(server, ref, {
        ...place,
        ...(request.nbt ? { nbt: true, nbtLimits: NBT_LIMITS } : {}),
        ...(request.nbtPath ? { nbtPath: request.nbtPath } : {}),
        ...(request.inventory ? { inventory: true } : {}),
      });
      return found ? report("entity", found) : text(`entity: not found (${JSON.stringify(ref)})`);
    }
    case "block":
      return report("block", await world.block(server, needPosition(request), { ...place, ...(request.nbt ? { nbt: true } : {}) }));
    case "container":
      return report("container", await world.container(server, needPosition(request), { ...place, ...(request.nbt ? { nbt: true } : {}) }));
    case "region": {
      if (!request.min || !request.max) throw new Error("domain region needs min and max {x, y, z}");
      return report("region", await world.region(server, floor(request.min), floor(request.max), {
        ...place,
        ...(request.cells ? { cells: true } : {}),
        ...(request.states ? { states: true } : {}),
      }));
    }
    case "chunk":
      return report("chunk", await world.chunk(server, needPosition(request), place));
    case "biome":
      return report("biome", await world.biome(server, needPosition(request), place));
    case "performance":
      return report("performance", await world.performance(server, {
        ...place,
        durationMs: request.durationMs ?? 2_000,
        ...(request.sampleIntervalMs !== undefined ? { sampleIntervalMs: request.sampleIntervalMs } : {}),
      }));
  }
}

function needPosition(request: QueryRequest): Pos {
  if (!request.position) throw new Error(`domain ${request.domain} needs a position {x, y, z}`);
  return floor(request.position);
}

function report(label: string, value: unknown, budget: { maxKeys?: number } = {}): ToolResult {
  return text(`${label}:\n${budgetedJson(value, budget)}`);
}

function listed(label: string, items: EntityJson[], count: number, limit: number, tail = ""): ToolResult {
  const lines = items.slice(0, limit).map((item) => `  ${describeEntity(item)}`);
  return text(`${label}: ${Math.min(items.length, limit)} shown of ${count}\n${lines.join("\n")}${tail}`);
}

function describeEntity(entity: EntityJson & { health?: number }): string {
  const parts = [entity.name || entity.type, `@ ${round(entity.position.x)},${round(entity.position.y)},${round(entity.position.z)}`, entity.dimension];
  if (typeof entity.health === "number") parts.push(`hp ${round(entity.health)}`);
  parts.push(`#${entity.id}`, entity.uuid.slice(0, 8));
  return parts.join(" ");
}
