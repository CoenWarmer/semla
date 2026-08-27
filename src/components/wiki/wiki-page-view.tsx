"use client";

import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { WikiPageMeta, WikiPageType } from "@/lib/wiki-types";

const TYPE_COLORS: Record<WikiPageType, string> = {
  entity: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  concept: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  synthesis: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  analysis: "bg-green-500/15 text-green-400 border-green-500/30",
  requirement: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  source: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

const WIKI_SCHEME = "wiki://";

interface WikiPageViewProps {
  path: string;
  meta: WikiPageMeta | undefined;
  pages: Record<string, WikiPageMeta>;
  titleToPath: Record<string, string>;
  backlinkPaths: string[];
  onNavigate: (path: string) => void;
}

interface PageData {
  content: string;
  meta: WikiPageMeta | null;
}

export function WikiPageView({
  path,
  meta,
  pages,
  titleToPath,
  backlinkPaths,
  onNavigate,
}: WikiPageViewProps) {
  const query = useQuery({
    queryKey: ["wiki-page", path],
    queryFn: async (): Promise<PageData> => {
      const res = await fetch(
        `/api/wiki/page?path=${encodeURIComponent(path)}`,
      );
      if (!res.ok) throw new Error(`Failed to load page (${res.status})`);
      return res.json() as Promise<PageData>;
    },
  });

  const effectiveMeta = query.data?.meta ?? meta;

  const resolvedContent = query.data?.content
    ? resolveWikiLinks(query.data.content, titleToPath)
    : null;

  const backlinks = backlinkPaths
    .map((p) => [p, pages[p]] as [string, WikiPageMeta])
    .filter(([, m]) => m != null);

  return (
    <div className="mx-auto max-w-3xl p-8">
      {effectiveMeta && (
        <div className="mb-6 flex items-center gap-3">
          <Badge variant="outline" className={TYPE_COLORS[effectiveMeta.type]}>
            {effectiveMeta.type}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {effectiveMeta.updated
              ? `Updated ${effectiveMeta.updated}`
              : effectiveMeta.created
                ? `Created ${effectiveMeta.created}`
                : null}
          </span>
        </div>
      )}

      {query.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}

      {query.isError && (
        <p className="text-sm text-destructive">
          {query.error instanceof Error
            ? query.error.message
            : "Unknown error"}
        </p>
      )}

      {resolvedContent && (
        <div className="prose prose-sm prose-invert max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => url}
            components={{
              a: ({ href, children }) => {
                if (href?.startsWith(WIKI_SCHEME)) {
                  const target = href.slice(WIKI_SCHEME.length);
                  return (
                    <button
                      onClick={() => onNavigate(target)}
                      className="text-blue-400 underline-offset-2 hover:underline"
                    >
                      {children}
                    </button>
                  );
                }
                return (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                );
              },
            }}
          >
            {resolvedContent}
          </ReactMarkdown>
        </div>
      )}

      {backlinks.length > 0 && (
        <div className="mt-10 border-t pt-6">
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Referenced by
          </p>
          <ul className="flex flex-wrap gap-2">
            {backlinks.map(([backPath, backMeta]) => (
              <li key={backPath}>
                <button
                  onClick={() => onNavigate(backPath)}
                  className="rounded-md border px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                >
                  {backMeta.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function resolveWikiLinks(
  content: string,
  titleToPath: Record<string, string>,
): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (_, title: string) => {
    const target = titleToPath[title];
    return target ? `[${title}](${WIKI_SCHEME}${target})` : title;
  });
}
