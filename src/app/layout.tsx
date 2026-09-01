import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter, JetBrains_Mono } from "next/font/google";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { QueryProvider } from "@/components/query-provider";
import { PendingPromptProvider } from "@/components/pending-prompt-provider";
import { HeaderActions } from "@/components/header-actions";
import "./globals.css";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";

const jetbrainsMonoHeading = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-heading",
});

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Semla",
  description: "Traceable Agent Harness",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={cn(
        "h-full",
        "dark",
        "antialiased",
        geistSans.variable,
        geistMono.variable,
        "font-sans",
        inter.variable,
        jetbrainsMonoHeading.variable,
      )}
    >
      <body className="h-full flex flex-col">
        <QueryProvider>
          <PendingPromptProvider>
            <TooltipProvider>
              <SidebarProvider className="flex-1 min-h-0">
                <AppSidebar />
                <main className="flex w-full flex-col">
                  {/* Named group: controls that only appear on hover key off
                      the header as a whole, not off whatever sits nearest. */}
                  <header className="group/header flex h-11 shrink-0 items-center gap-1 border-b border-border/40 px-2">
                    <SidebarTrigger />
                    <HeaderActions />
                  </header>
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    {children}
                  </div>
                </main>
              </SidebarProvider>
            </TooltipProvider>
          </PendingPromptProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
