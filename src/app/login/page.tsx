import { LoginForm } from "./login-form";

function getSafeNextPath(next: string | undefined) {
  if (next?.startsWith("/") && !next.startsWith("//")) {
    return next;
  }

  return "/";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="text-gray-600">Use your Supabase account to continue.</p>
        </div>
        <LoginForm nextPath={getSafeNextPath(next)} />
      </div>
    </main>
  );
}
