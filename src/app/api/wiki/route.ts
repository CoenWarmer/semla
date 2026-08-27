import { NextResponse } from "next/server";
import {
  getWikiConfig,
  getWikiRegistry,
  isWikiInitialized,
} from "@/lib/wiki";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isWikiInitialized()) {
    return NextResponse.json({ initialized: false }, { status: 404 });
  }

  const config = getWikiConfig();
  const registry = getWikiRegistry();

  return NextResponse.json({ initialized: true, config, registry });
}
