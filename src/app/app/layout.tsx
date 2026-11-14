import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/admin/data";
import { signOut } from "./actions";

export const metadata: Metadata = { title: "Properties · gameHome", robots: { index: false } };

export default function AdminLayout({ children }: LayoutProps<"/app">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-black/10 bg-[#fbf9f5]">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-6">
            <Link href="/app" className="text-sm font-semibold tracking-tight">
              gameHome
            </Link>
            <nav className="text-sm">
              <Link href="/app" className="text-neutral-600 hover:text-neutral-900">
                Properties
              </Link>
            </nav>
          </div>
          <Suspense fallback={<div className="h-8" />}>
            <AccountMenu />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

async function AccountMenu() {
  const { user, org } = await requireSession();
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="hidden text-neutral-500 sm:inline" title={user.email ?? undefined}>
        {org.name}
      </span>
      <form action={signOut}>
        <button type="submit" className="rounded-lg border border-black/15 px-3 py-1.5 hover:bg-black/5">
          Sign out
        </button>
      </form>
    </div>
  );
}
