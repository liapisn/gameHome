import "server-only";

/**
 * Fixture tours (third-party listings, internal testing only) are dev-only. A preview deployment
 * can opt specific ones in with INTERNAL_FIXTURE_TOURS=listing-8218,… so the team can review them
 * behind Vercel's deployment protection. Never honoured on production, whatever the env says.
 */
export const INTERNAL_FIXTURE_TOURS: ReadonlySet<string> = new Set(
  process.env.VERCEL_ENV === "production"
    ? []
    : (process.env.INTERNAL_FIXTURE_TOURS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

/** Plans are named `<tour>-<level>`: a plan belongs to an opted-in tour. */
export const isInternalFixturePlan = (planId: string) => [...INTERNAL_FIXTURE_TOURS].some((t) => planId.startsWith(`${t}-`));
