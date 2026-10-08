/** Pure geometry in Minecraft's conventions: yaw 0 faces +z (south) and grows toward -x; positive pitch looks down. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraAngles {
  yaw: number;
  pitch: number;
}

/** A camera placement: where it stands and where it looks, optionally with a field of view. */
export interface CameraPose extends CameraAngles {
  position: Vec3;
  fov?: number;
  dimension?: string;
}

export type Direction = "down" | "up" | "north" | "south" | "west" | "east";

export function faceNormal(face: Direction): Vec3 {
  switch (face) {
    case "down":
      return { x: 0, y: -1, z: 0 };
    case "up":
      return { x: 0, y: 1, z: 0 };
    case "north":
      return { x: 0, y: 0, z: -1 };
    case "south":
      return { x: 0, y: 0, z: 1 };
    case "west":
      return { x: -1, y: 0, z: 0 };
    case "east":
      return { x: 1, y: 0, z: 0 };
    default:
      throw new Error(`unknown face: ${face as string}`);
  }
}

/** The yaw and pitch that look from `position` at `target`. */
export function cameraLookingAt(position: Vec3, target: Vec3): CameraAngles {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const dz = target.z - position.z;
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  return {
    yaw: (Math.atan2(-dx, dz) * 180) / Math.PI,
    pitch: (-Math.atan2(dy, horizontal) * 180) / Math.PI,
  };
}

export const EYE_HEIGHT = 1.62;

export interface AimGeometryOptions {
  /** The face of the block to look at; default "up". */
  face?: Direction;
  /** Where the player stands (feet); default a spot in front of the face. */
  from?: Vec3;
}

export interface AimGeometry {
  /** Where the player's feet go. */
  view: Vec3;
  camera: CameraAngles;
  /** The point looked at: the centre of the face. */
  target: Vec3;
  face: Direction;
}

/**
 * Where a player stands and looks to aim at a face of the block at `pos`. Without `from`, aiming at the
 * top face stands on the block looking straight down (so the player cannot fall); other faces stand 1.5
 * blocks out from the face.
 */
export function aimGeometry(pos: Vec3, options: AimGeometryOptions = {}): AimGeometry {
  const face = options.face ?? "up";
  const normal = faceNormal(face);
  const center = { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 };
  const target = {
    x: center.x + normal.x * 0.5,
    y: center.y + normal.y * 0.5,
    z: center.z + normal.z * 0.5,
  };
  if (!options.from && face === "up") {
    return { view: { x: pos.x + 0.5, y: pos.y + 1, z: pos.z + 0.5 }, camera: { yaw: 0, pitch: 90 }, target, face };
  }
  const view = options.from ?? {
    x: target.x + normal.x * 1.5,
    y: pos.y - (face === "down" ? 2 : 0),
    z: target.z + normal.z * 1.5,
  };
  const eye = { x: view.x, y: view.y + EYE_HEIGHT, z: view.z };
  return { view, camera: cameraLookingAt(eye, target), target, face };
}
