import type { UiNode } from "./contract.js";
import type { UiView } from "./host.js";

const DEFAULT_LIMIT = 80;

interface Listed {
  adapter: string;
  node: UiNode;
  ref: string;
  depth: number;
}

function listed(view: UiView): Listed[] {
  const out: Listed[] = [];
  for (const layer of view.layers) {
    const visit = (node: UiNode, depth: number) => {
      const ref = view.refOf.get(node);
      if (ref !== undefined) {
        out.push({ adapter: layer.adapter, node, ref, depth });
      }
      node.children.forEach((child) => visit(child, ref === undefined ? depth : depth + 1));
    };
    layer.roots.forEach((root) => visit(root, 0));
  }
  return out;
}

/** An empty slot with nothing else to say about it, listed only as a ref in a range. */
function isEmptySlot(node: UiNode): boolean {
  return node.role === "slot" && node.item === undefined && node.states.hittable && node.states.enabled;
}

export function describeNode(node: UiNode): string {
  const parts: string[] = [node.role === "unknown" ? shortClass(node.className) : node.role];
  if (node.item) {
    parts.push(`${node.item.id}${node.item.count === undefined || node.item.count === 1 ? "" : ` x${node.item.count}`}`);
  } else if (node.name !== undefined && node.name !== "") {
    parts.push(JSON.stringify(node.name));
  }
  if (node.value !== undefined) {
    parts.push(`value=${JSON.stringify(node.value)}`);
  }
  const box = node.visibleBounds ?? node.bounds;
  parts.push(`${num(box.x)},${num(box.y)} ${num(box.width)}x${num(box.height)}`);
  if (!node.states.enabled) {
    parts.push("disabled");
  }
  if (node.states.blockedBy !== undefined) {
    parts.push(`covered by ${node.states.blockedBy}`);
  } else if (!node.states.hittable) {
    parts.push("not hittable");
  }
  return parts.join(" ");
}

/** The tree as text: refs on everything addressable, empty slots folded into ranges. */
export function formatView(view: UiView, options: { limit?: number } = {}): string {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const lines: string[] = [];
  const rows = listed(view);
  let shown = 0;
  let hidden = 0;
  for (const layer of view.layers) {
    const mine = rows.filter((row) => row.adapter === layer.adapter);
    if (mine.length === 0) {
      continue;
    }
    lines.push(`${layer.adapter}:`);
    const empty: string[] = [];
    for (const row of mine) {
      if (isEmptySlot(row.node)) {
        empty.push(row.ref);
        continue;
      }
      if (shown >= limit) {
        hidden += 1;
        continue;
      }
      lines.push(`${"  ".repeat(row.depth + 1)}[${row.ref}] ${describeNode(row.node)}`);
      shown += 1;
    }
    if (empty.length > 0) {
      lines.push(`  empty slots: ${ranges(empty)}`);
    }
  }
  if (hidden > 0) {
    lines.push(`… ${hidden} more elements not listed`);
  }
  for (const error of view.errors) {
    lines.push(`ui unreadable: ${error}`);
  }
  return lines.length > 0 ? lines.join("\n") : "nothing addressable on screen";
}

/** What changed between two reads, keyed by adapter and node key. */
export function diffViews(previous: UiView | undefined, next: UiView, options: { limit?: number } = {}): string[] {
  const limit = options.limit ?? 12;
  const before = new Map(previous ? listed(previous).map((row) => [`${row.adapter}\u0000${row.node.key}`, row]) : []);
  const after = new Map(listed(next).map((row) => [`${row.adapter}\u0000${row.node.key}`, row]));
  const appeared: Listed[] = [];
  const changed: string[] = [];
  for (const [identity, row] of after) {
    const old = before.get(identity);
    if (!old) {
      appeared.push(row);
      continue;
    }
    const was = describeNode(old.node);
    const now = describeNode(row.node);
    if (was !== now) {
      changed.push(`  [${row.ref}] ${was} -> ${now}`);
    }
  }
  const gone = [...before.entries()].filter(([identity]) => !after.has(identity)).map(([, row]) => row);
  const lines: string[] = [];
  if (appeared.length > 0) {
    const listedNow = appeared.filter((row) => !isEmptySlot(row.node));
    const empty = appeared.filter((row) => isEmptySlot(row.node)).map((row) => row.ref);
    lines.push(`ui appeared (${appeared.length}):`);
    for (const row of listedNow.slice(0, limit)) {
      lines.push(`  [${row.ref}] ${describeNode(row.node)}`);
    }
    if (listedNow.length > limit) {
      lines.push(`  … ${listedNow.length - limit} more; a full read lists them`);
    }
    if (empty.length > 0) {
      lines.push(`  empty slots: ${ranges(empty)}`);
    }
  }
  if (gone.length > 0) {
    const names = gone.slice(0, limit).map((row) => `${row.ref} ${row.node.name ?? row.node.role}`);
    lines.push(`ui gone (${gone.length}): ${names.join(", ")}${gone.length > limit ? ", …" : ""}`);
  }
  if (changed.length > 0) {
    lines.push(`ui changed (${changed.length}):`, ...changed.slice(0, limit));
    if (changed.length > limit) {
      lines.push(`  … ${changed.length - limit} more`);
    }
  }
  return lines;
}

function ranges(refs: string[]): string {
  const numbers = refs.map((ref) => Number(ref.slice(1))).sort((a, b) => a - b);
  const parts: string[] = [];
  let start = numbers[0]!;
  let end = start;
  for (const value of [...numbers.slice(1), Number.NaN]) {
    if (value === end + 1) {
      end = value;
      continue;
    }
    parts.push(start === end ? `e${start}` : `e${start}-e${end}`);
    start = value;
    end = value;
  }
  return parts.join(" ");
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function shortClass(className: string): string {
  return className.slice(className.lastIndexOf(".") + 1);
}
