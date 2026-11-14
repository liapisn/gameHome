/**
 * Provider-neutral "image(s) + prompt → JSON matching a zod schema".
 *
 * Gemini is used when GEMINI_API_KEY is set (REST, no SDK). Otherwise Claude, via
 * ANTHROPIC_API_KEY or Vercel AI Gateway. GEMINI_MODEL / CLAUDE_MODEL override the defaults;
 * a request's own `model` overrides both (Gemini only).
 */
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

/** Default for every Gemini call; GEMINI_MODEL overrides it. */
export const GEMINI_DEFAULT_MODEL = "gemini-4-carbon";
/** The object workers' model (many workers, about a dozen calls each). */
export const geminiObjectModel = () => process.env.GEMINI_MODEL_OBJECT ?? "gemini-4-hydrogen";

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
      // Gemini 4 accepts low, medium and high (not minimal).
      thinkingConfig: { thinkingLevel: req.effort ?? "high" },
    },
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const backoff = () => new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    // Streamed (SSE): Gemini 4 at high thinking can take over 5 minutes before its first byte,
    // longer than fetch's header timeout; a stream sends headers at once.
    let res: Response;
    try {
      res = await fetch(`${GEMINI_URL}/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
        body: JSON.stringify(body),
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
    output_config: { effort: req.effort ?? "high", format: zodOutputFormat(req.schema) },
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
