import { NextResponse } from "next/server";

import { getWorkspaceProjects } from "@/lib/pi/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getWorkspaceProjects());
}
