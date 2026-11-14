import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · gameHome" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          gameHome
        </Link>
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm text-neutral-600">
          We&apos;ll email you a link. No password needed. New here? The same link creates your account.
        </p>
        <Suspense fallback={<div className="mt-6 h-[104px]" />}>
          <LoginFormWithParams searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

async function LoginFormWithParams({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : "";
  const linkError = params.error === "link";
  return <LoginForm next={next} linkError={linkError} />;
}
