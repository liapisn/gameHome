/**
 * Search the fal model catalogue, to confirm the endpoint ids the model builder uses still exist.
 *   npx tsx --env-file=.env.local scripts/fal-models.mts [query ...]
 * With no query, checks the four endpoints of src/lib/models3d.
 *
 * Adapted from https://github.com/apekshik/anyscene (generate/models.mjs), MIT licence.
 */
const KEY = process.env.FAL_KEY ?? process.env.FAL_API_KEY;
if (!KEY) throw new Error("FAL_KEY is not set (.env.local)");

const WANTED = [
  "openai/gpt-image-2.5/sunburst/edit",
  "openai/gpt-image-2.5/sunburst/text-to-image",
  "tripo3d/h3.1/image-to-3d",
  "meshy/v7.1/image-to-3d",
];
const queries = process.argv.slice(2);

async function search(q: string) {
  const r = await fetch(`https://api.fal.ai/v1/models?q=${encodeURIComponent(q)}&limit=40`, { headers: { authorization: `Key ${KEY}` } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const j = (await r.json()) as { models?: { endpoint_id: string; metadata?: { display_name?: string; status?: string; updated_at?: string } }[] };
  return j.models ?? [];
}

if (queries.length) {
  for (const q of queries) {
    console.log(`## ${q}`);
    for (const m of await search(q)) console.log(m.endpoint_id, "|", m.metadata?.display_name, "|", m.metadata?.status, "|", m.metadata?.updated_at?.slice(0, 10));
  }
} else {
  let missing = 0;
  for (const id of WANTED) {
    const found = (await search(id)).find((m) => m.endpoint_id === id);
    console.log(`${found ? "  ok " : "MISSING"} ${id}${found ? ` (${found.metadata?.status ?? "?"})` : ""}`);
    if (!found) missing++;
  }
  process.exit(missing ? 1 : 0);
}
