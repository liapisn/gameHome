/**
 * Provider-neutral "image(s) + prompt → JSON matching a zod schema".
 *
 * Gemini is used when GEMINI_API_KEY is set (REST, no SDK). Otherwise Claude, via
 * ANTHROPIC_API_KEY or Vercel AI Gateway. GEMINI_MODEL / CLAUDE_MODEL override the defaults;
 * a request's own `model` overrides both (Gemini only).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; data: string /* base64 */; mediaType: ImageMediaType };

export interface StructuredRequest<T extends z.ZodType> {
  schema: T;
  system: string;
  /** Leading parts shared across many calls (plans, reference images): cached where the provider supports it. */
  shared?: Part[];
  parts: Part[];
  /** Spend more reasoning on hard visual geometry. */
  effort?: "low" | "medium" | "high";
  /** Gemini model id for this call only (e.g. the object workers' GEMINI_MODEL_OBJECT). */
  model?: string;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  usage: { input: number; output: number };
}

export function activeProvider(): "gemini" | "claude" {
  return process.env.GEMINI_API_KEY ? "gemini" : "claude";
}

export async function generateStructured<T extends z.ZodType>(
  req: StructuredRequest<T>,
): Promise<StructuredResult<z.infer<T>>> {
  return activeProvider() === "gemini" ? gemini(req) : claude(req);
}

// --------------------------------------------------------------------------- Gemini

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * One call's limit, stream included. Read on every call, not at import: a script's imports run
 * before its own code. The model build raises it (build:models sets GEMINI_CALL_TIMEOUT_MS).
 */
const callTimeoutMs = () => Number(process.env.GEMINI_CALL_TIMEOUT_MS ?? 90_000);
const ATTEMPTS = 3;

/** Output token limits from the models API (GET /v1beta/models/<id>). */
const MAX_OUTPUT: Record<string, number> = { "gemini-4-carbon": 32768, "gemini-4-hydrogen": 65536 };

/** Default for every Gemini call; GEMINI_MODEL overrides it (benchmark in docs/two-layer-plan.md). */
export const GEMINI_DEFAULT_MODEL = "gemini-4-hydrogen";
/** Item code: one call per item, all in parallel. */
export const geminiObjectModel = () => process.env.GEMINI_MODEL_OBJECT ?? "gemini-4-hydrogen";
/** The room agent (design sheet, room critique) and the house review. */
export const geminiRoomModel = () => process.env.GEMINI_MODEL_ROOM ?? "gemini-4-carbon";

// --------------------------------------------------------------------------- step deadline

const deadline = new AsyncLocalStorage<number>();

/**
 * Run `fn` with a time budget: every model call inside it (however deep) shortens its timeout to
 * fit, and starts no retry it can't finish. For Vercel workflow steps, which have a hard limit.
 */
export function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return deadline.run(Date.now() + ms, fn);
}

/** Time left in the current `withDeadline` budget; Infinity outside one. */
export function remainingMs(): number {
  const end = deadline.getStore();
  return end === undefined ? Infinity : end - Date.now();
}

/** JSON Schema for Gemini's responseJsonSchema: drop keys it rejects. */
function geminiSchema(schema: z.ZodType): unknown {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === "$schema" || k === "additionalProperties") continue;
        out[k] = strip(v);
      }
      return out;
    }
    return node;
  };
  return strip(z.toJSONSchema(schema, { target: "draft-2020-12" }));
}

async function gemini<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
  const model = req.model ?? process.env.GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL;
  const toPart = (p: Part) =>
    p.type === "text" ? { text: p.text } : { inline_data: { mime_type: p.mediaType, data: p.data } };

  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [...(req.shared ?? []), ...req.parts].map(toPart) }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: geminiSchema(req.schema),
      // Gemini 4 accepts low, medium and high (not minimal). Thought summaries are streamed (and
      // skipped below) because without them nothing, not even headers, arrives until thinking ends:
      // past fetch's 5-minute header timeout on long calls.
      thinkingConfig: { thinkingLevel: req.effort ?? "low", includeThoughts: true },
      // The model's full output budget (thinking counts against it): the default is lower, and
      // long placements at high thinking ran out (finishReason MAX_TOKENS).
      maxOutputTokens: MAX_OUTPUT[model] ?? 32768,
    },
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    // Inside a step's budget: keep 10 s for the step's own work, and start nothing under 20 s.
    const left = remainingMs();
    if (left < 20_000) throw new Error(`out of step time${lastError ? ` (last error: ${String((lastError as Error)?.message ?? lastError).slice(0, 160)})` : ""}`);
    const timeout = Math.min(callTimeoutMs(), left - 10_000);
    const backoff = () => {
      // One line per retry, so a slow step says what is happening instead of going quiet.
      console.warn(`gemini ${model}: attempt ${attempt + 1} failed (${String((lastError as Error)?.message ?? lastError).slice(0, 160)}); retrying`);
      return new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    };
    // Streamed (SSE) with thought summaries: data flows while the model thinks, so long calls stay
    // inside fetch's header and body timeouts.
    let res: Response;
    try {
      res = await fetch(`${GEMINI_URL}/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
        body: JSON.stringify(body),
        // A whole call (stream included) gets at most this long, then it is retried: a stalled
        // stream would otherwise hang the build for good.
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      lastError = e; // network error: retry
      await backoff();
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
      await backoff();
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);

    let text = "";
    let finishReason: string | undefined;
    let last: { modelVersion?: string; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }; promptFeedback?: unknown } = {};
    try {
      let buf = "";
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const ev = JSON.parse(line.slice(5));
          last = ev;
          const cand = ev.candidates?.[0];
          for (const p of (cand?.content?.parts ?? []) as { text?: string; thought?: boolean }[]) if (p.text && !p.thought) text += p.text;
          if (cand?.finishReason) finishReason = cand.finishReason;
        }
      }
    } catch (e) {
      lastError = e; // stream cut off: retry
      await backoff();
      continue;
    }
    if (finishReason === "MAX_TOKENS" && body.generationConfig.thinkingConfig.thinkingLevel !== "low") {
      // Thinking used up the output budget: once more with less thinking.
      lastError = new Error("Gemini did not finish: MAX_TOKENS");
      body.generationConfig.thinkingConfig.thinkingLevel = body.generationConfig.thinkingConfig.thinkingLevel === "high" ? "medium" : "low";
      await backoff();
      continue;
    }
    if (finishReason !== "STOP") {
      throw new Error(`Gemini did not finish: ${finishReason ?? JSON.stringify(last.promptFeedback)}`);
    }
    return {
      data: req.schema.parse(JSON.parse(text)),
      model: last.modelVersion ?? model,
      usage: { input: last.usageMetadata?.promptTokenCount ?? 0, output: last.usageMetadata?.candidatesTokenCount ?? 0 },
    };
  }
  throw lastError;
}

// --------------------------------------------------------------------------- Claude

export function createClaudeClient(): { client: Anthropic; model: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    return { client: new Anthropic(), model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5" };
  }
  const token = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    throw new Error(
      "No model credentials: set GEMINI_API_KEY, ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY, or run `vercel env pull`.",
    );
  }
  return {
    client: new Anthropic({ apiKey: null, authToken: token, baseURL: "https://ai-gateway.vercel.sh" }),
    model: process.env.CLAUDE_MODEL ?? "anthropic/claude-opus-5.5",
  };
}

async function claude<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
  const { client, model } = createClaudeClient();
  const toBlock = (p: Part): Anthropic.ContentBlockParam =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } };

  const shared = (req.shared ?? []).map(toBlock);
  if (shared.length) {
    const last = shared[shared.length - 1] as { cache_control?: { type: "ephemeral" } };
    last.cache_control = { type: "ephemeral" };
  }

  // Streamed because long outputs exceed the SDK's non-streaming timeout; finalMessage() still parses.
  const stream = client.messages.stream({
    model,
    max_tokens: 32000,
    output_config: { effort: req.effort ?? "low", format: zodOutputFormat(req.schema) },
    system: req.system,
    messages: [{ role: "user", content: [...shared, ...req.parts.map(toBlock)] }],
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === "refusal") {
    throw new Error(`Model refused: ${response.stop_details?.explanation ?? "no explanation"}`);
  }
  if (response.stop_reason === "max_tokens") throw new Error("Output hit max_tokens before completing");
  if (!response.parsed_output) throw new Error("Model output did not match the schema");
  return {
    data: response.parsed_output as z.infer<T>,
    model: response.model,
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}
