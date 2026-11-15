import "server-only";
import { cookies } from "next/headers";

/** Which of the user's workspaces /app shows. Only a preference: requireSession checks membership. */
export const ACTIVE_WORKSPACE_COOKIE = "ws";

/** Server Functions and Route Handlers only (cookies can't be set while rendering). */
export async function setActiveWorkspace(orgId: string) {
  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function clearActiveWorkspace() {
  (await cookies()).delete(ACTIVE_WORKSPACE_COOKIE);
}
