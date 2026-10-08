import { z } from "zod";
import type { ZodRawShape } from "zod";
import { camera } from "@izakyl/blockwright-minecraft";

// Argument pieces more than one tool takes. A tool's arguments are a shape of these, parsed once
// with z.object(shape) and typed with Args<typeof shape>.

export type Args<S extends ZodRawShape> = z.infer<z.ZodObject<S>>;

/** Parses raw arguments against a shape, so a handler gets them typed. */
export function parser<S extends ZodRawShape>(shape: S): (args: unknown) => Args<S> {
  const schema = z.object(shape);
  return (args) => schema.parse(args ?? {});
}

/** An argument an op needs even though the shape leaves it optional. */
export function needs<T extends object, K extends keyof T & string>(args: T, key: K): NonNullable<T[K]> {
  const value = args[key];
  if (value === undefined || value === null) {
    const op = (args as { op?: unknown }).op;
    throw new Error(`${op === undefined ? "this call" : `op ${String(op)}`} needs ${key}`);
  }
  return value as NonNullable<T[K]>;
}

export const roleArg = z.enum(["client", "server"]).optional();

export const vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const boundsArg = z.object({ min: vec3, max: vec3 });

export const cameraArg = z.object({
  position: vec3,
  yaw: z.number(),
  pitch: z.number(),
  dimension: z.string().optional(),
  fov: z.number().optional(),
});

export const presetArg = z.enum(camera.PRESETS as [camera.Preset, ...camera.Preset[]]);
