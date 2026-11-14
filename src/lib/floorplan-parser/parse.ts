import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ParsedPlanSchema, type ParsedPlan } from "./schema";

const SYSTEM_PROMPT = `You convert architectural floor plan drawings into precise geometry for a 3D renderer.

Coordinate system: meters, origin at the top-left of the drawing, x to the right, y downward.

Scale: rooms usually carry printed interior dimensions such as "4.81m x 4.86m". The first number is the horizontal extent on the drawing and the second the vertical, unless the label is rotated with the room. Use them to fix the scale, then measure unlabeled spaces (closets, stairs, small storage) proportionally from the drawing. If there are no printed dimensions, estimate from typical door widths (~0.8-0.9 m) and set scaleMethod to "estimated".

Rooms:
- Return every enclosed space, including closets, storage, hallways and the stair area (type "stairs").
- Trace each outline on the wall centerlines, so two rooms that share a wall use exactly the same coordinate for it. A printed interior dimension is about one wall thickness (0.1-0.25 m) smaller than the centerline extent.
- Use 4-point rectangles where the room is rectangular, and more points for L-shapes or angled walls. List points clockwise.
- Rooms must not overlap, and the overall footprint should be continuous, with no gaps between neighbouring rooms.

Openings:
- Include every door (swing arc), window (thin double line in an exterior wall), and open passage without a door ("opening").
- Give the center point on the wall line and the clear width.

List anything ambiguous in warnings instead of guessing silently.`;

export interface ParseOptions {
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  /** Extra context, e.g. "upper floor of a two-storey house". */
  hint?: string;
}

export interface ParseResult {
  parsed: ParsedPlan;
  model: string;
  usage: Anthropic.Usage;
}

/**
 * Uses ANTHROPIC_API_KEY directly when set. Otherwise routes through Vercel AI Gateway,
 * authenticating with AI_GATEWAY_API_KEY or the linked project's VERCEL_OIDC_TOKEN.
 */
export function createClient(): { client: Anthropic; model: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    return { client: new Anthropic(), model: "claude-opus-5-5" };
  }
  const token = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    throw new Error(
      "No credentials: set ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY, or run `vercel env pull` for VERCEL_OIDC_TOKEN.",
    );
  }
  return {
    client: new Anthropic({ apiKey: null, authToken: token, baseURL: "https://ai-gateway.vercel.sh" }),
    model: "anthropic/claude-opus-5.5",
  };
}

export async function parseFloorPlanImage(opts: ParseOptions): Promise<ParseResult> {
  const { client, model } = createClient();

  // Streamed because long outputs exceed the SDK's non-streaming timeout; finalMessage() still parses.
  const stream = client.messages.stream({
    model,
    max_tokens: 32000,
    output_config: { effort: "high", format: zodOutputFormat(ParsedPlanSchema) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: opts.mediaType, data: opts.imageBase64 } },
          {
            type: "text",
            text: `Convert this floor plan into rooms and openings.${opts.hint ? ` Context: ${opts.hint}` : ""}`,
          },
        ],
      },
    ],
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === "refusal") {
    throw new Error(`Model refused: ${response.stop_details?.explanation ?? "no explanation"}`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Output hit max_tokens before the plan was complete");
  }
  if (!response.parsed_output) {
    throw new Error("Model output did not match the floor plan schema");
  }

  return { parsed: response.parsed_output, model: response.model, usage: response.usage };
}
