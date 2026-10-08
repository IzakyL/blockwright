export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type ToolContent = ToolTextContent | ToolImageContent;

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function failure(value: string): ToolResult {
  return { content: [{ type: "text", text: value }], isError: true };
}
