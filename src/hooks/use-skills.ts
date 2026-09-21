import { useQuery } from "@tanstack/react-query";

export type PiSkill = {
  name: string;
  description: string;
  source: string;
};

/**
 * Session-scoped for the same reason `use-tools.ts` is: which skills a
 * session sees depends on its cwd (project skills, ancestor `.agents/skills`
 * walked from that cwd), so a session's answer must not be served from
 * another one's cache entry. Without an id — /sessions/new — the workspace
 * root is the honest answer, same fallback `resolveSessionCwd` itself uses.
 */
export const skillsQueryKey = (sessionId?: string) =>
  ["skills", sessionId ?? null] as const;

const fetchSkills = async (sessionId?: string): Promise<PiSkill[]> => {
  const response = await fetch(
    sessionId ? `/api/skills?sessionId=${encodeURIComponent(sessionId)}` : "/api/skills",
  );

  if (!response.ok) {
    throw new Error("Unable to load skills.");
  }

  const { skills } = (await response.json()) as { skills: PiSkill[] };
  return skills;
};

export const useSkills = (sessionId?: string) =>
  useQuery({
    queryFn: () => fetchSkills(sessionId),
    queryKey: skillsQueryKey(sessionId),
  });
