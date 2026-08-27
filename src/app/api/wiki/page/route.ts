import { NextRequest, NextResponse } from "next/server";
import { getWikiPageContent, getWikiRegistry } from "@/lib/wiki";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get("path");

  if (!path) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }

  const registry = getWikiRegistry();
  const meta = registry?.pages[path] ?? null;
  const content = getWikiPageContent(path);

  if (!content) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  return NextResponse.json({ content, meta });
}
