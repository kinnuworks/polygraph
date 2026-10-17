import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DIR } from "@polygraph/core";

const client = new Anthropic();

/** Drafting (first versions of files) and fixing (patches from real failures) can use different models. */
export const MODELS = {
  draft: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  fix: process.env.SELLER_FIX_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
} as const;
export type ModelRole = keyof typeof MODELS;

export interface ToolFile {
  path: string;
  content: string;
}

export interface FilesReply {
  summary: string;
  files: ToolFile[];
  /** Model that wrote these files. */
  model: string;
}

const fileSchema = {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
  additionalProperties: false,
};

const filesSchema = {
  type: "object",
  properties: { summary: { type: "string" }, files: { type: "array", items: fileSchema } },
  required: ["summary", "files"],
  additionalProperties: false,
};

/** One stateless request whose reply is constrained to `schema`. Every call carries the full context it needs. */
async function askJson(model: string, system: string, prompt: string, schema: Record<string, unknown>): Promise<unknown> {
  const stream = client.messages.stream({
    model,
    max_tokens: 64_000,
    system,
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error(`model declined the request (${message.stop_details?.category ?? "no category"})`);
  }
  if (message.stop_reason === "max_tokens") throw new Error("model reply was cut off at max_tokens");
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`model reply was not valid JSON: ${text.slice(0, 200)}`);
  }
}

/** Rejects absolute paths and parent references so model output can only land inside the tool directory. */
function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === "");
}

function stripToolDir(path: string): string {
  const relative = path.startsWith(`${TOOL_DIR}/`) ? path.slice(TOOL_DIR.length + 1) : path;
  return relative.replace(/^\.\//, "");
}

export async function askForFiles(role: ModelRole, system: string, prompt: string): Promise<FilesReply> {
  const model = MODELS[role];
  const reply = (await askJson(model, system, prompt, filesSchema)) as Omit<FilesReply, "model">;
  // Absolute paths inside the tool directory are accepted and made relative; anything else is refused.
  const files = reply.files.map((file) => ({ ...file, path: stripToolDir(file.path) }));
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) throw new Error(`model proposed an unsafe file path: ${file.path}`);
  }
  return { summary: reply.summary, files, model };
}
