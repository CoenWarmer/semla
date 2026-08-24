import { getWorkspaceProjects } from "@/lib/pi/workspace";
import { ProjectsGrid } from "@/components/projects-grid";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Page() {
  const projects = getWorkspaceProjects();

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6 sm:p-10">
      <div className="space-y-1">
        <h1 className="font-heading text-3xl font-semibold">Projects</h1>
        <p className="text-sm text-muted-foreground">
          Git repositories found in the workspace.
        </p>
      </div>
      <ProjectsGrid projects={projects} />
    </div>
  );
}
