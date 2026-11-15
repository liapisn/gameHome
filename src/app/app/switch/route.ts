import { NextResponse, type NextRequest } from "next/server";
import { isUuid, requireSession } from "@/lib/admin/data";
import { setActiveWorkspace } from "@/lib/admin/workspace-cookie";
import { safeNext } from "@/lib/safe-next";

/**
 * /app/switch?to=<workspace>&next=<path>: makes `to` the active workspace, then continues to `next`.
 * Pages redirect here when they show something from another of the user's workspaces
 * (a page can't set the cookie itself while rendering).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const to = searchParams.get("to") ?? "";
  const next = safeNext(searchParams.get("next"));

  const { workspaces } = await requireSession();
  if (isUuid(to) && workspaces.some((w) => w.id === to)) await setActiveWorkspace(to);

  return NextResponse.redirect(`${origin}${next}`);
}
