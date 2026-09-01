import { getPiRuntimeConfig } from "@/lib/pi/runtime-config";
import { NewSessionClient } from "@/components/new-session-client";

/**
 * A session that does not exist yet.
 *
 * `?project=<name>` is how the home page's project cards arrive. They used to
 * POST a session and wait for its id before navigating anywhere, which cost
 * about half a second of nothing happening on a click, and left an empty
 * session behind whenever somebody opened a card and changed their mind. The
 * project rides in the URL instead, and the session is created with the first
 * prompt like any other.
 */
export default async function NewSessionPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <NewSessionClient
        defaultTools={[...getPiRuntimeConfig().tools]}
        project={project ?? null}
      />
    </div>
  );
}
