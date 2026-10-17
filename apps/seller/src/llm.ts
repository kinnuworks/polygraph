import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DIR } from "@polygraph/core";

const client = new Anthropic();
const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";

export interface ToolFile {
  path: string;
  content: string;
}

export interface FilesReply {
  summary: string;
  files: ToolFile[];
}

export interface AttackPlan {
  id: string;
  label: string;
  goal: string;
  /** Python 3 source run in an empty working directory to create the hostile inputs. */
  setup: string;
  /** Arguments passed to convert.py, relative to that working directory. */
  args: string[];
  /** Bash run in the working directory afterwards; exit 0 means the attack got through. */
  escapeCheck: string;
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

const attackSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    goal: { type: "string" },
    setup: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    escapeCheck: { type: "string" },
  },
  required: ["id", "label", "goal", "setup", "args", "escapeCheck"],
  additionalProperties: false,
};

const attacksSchema = {
  type: "object",
  properties: { attacks: { type: "array", items: attackSchema } },
  required: ["attacks"],
  additionalProperties: false,
};

/** One stateless request whose reply is constrained to `schema`. Every call carries the full context it needs. */
async function askJson(system: string, prompt: string, schema: Record<string, unknown>): Promise<unknown> {
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

export async function askForFiles(system: string, prompt: string): Promise<FilesReply> {
  const reply = (await askJson(system, prompt, filesSchema)) as FilesReply;
  // Absolute paths inside the tool directory are accepted and made relative; anything else is refused.
  const files = reply.files.map((file) => ({ ...file, path: stripToolDir(file.path) }));
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) throw new Error(`model proposed an unsafe file path: ${file.path}`);
  }
  return { summary: reply.summary, files };
}

export async function askForAttacks(system: string, prompt: string): Promise<AttackPlan[]> {
  const reply = (await askJson(system, prompt, attacksSchema)) as { attacks: AttackPlan[] };
  const seen = new Set<string>();
  return reply.attacks.map((attack) => {
    const id = attack.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "attack";
    const unique = seen.has(id) ? `${id}-${seen.size}` : id;
    seen.add(unique);
    return { ...attack, id: unique };
  });
}

export async function askForAttack(system: string, prompt: string): Promise<AttackPlan> {
  const [attack] = await askForAttacks(system, prompt);
  if (!attack) throw new Error("model returned no attack");
  return attack;
}

export const modelName = model;
