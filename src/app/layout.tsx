import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter, JetBrains_Mono } from "next/font/google";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { QueryProvider } from "@/components/query-provider";
import { PendingPromptProvider } from "@/components/pending-prompt-provider";
import { BottomBar } from "@/components/bottom-bar";
import { BottomPanelProvider } from "@/components/bottom-panel";
import { ElementTargetProvider } from "@/components/element-target-provider";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeColorProvider } from "@/components/theme-color-provider";
import "./globals.css";

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
          <ThemeColorProvider />
          <PendingPromptProvider>
            <ElementTargetProvider>
              <TooltipProvider>
                {/* Above both the frame and the page: the bar lives in one and
                    its panels are rendered by the other. */}
                <BottomPanelProvider>
                  <SidebarProvider
                    className="flex-1 min-h-0"
                    defaultOpen={false}
                  >
                    <AppSidebar />
                    <main className="flex min-w-0 w-full flex-col">
                      <div className="flex-1 min-h-0 overflow-y-auto">
                        {children}
                      </div>
                      {/* Bottom of the frame, outside the scroll container, so it
                          stays put rather than scrolling away with the page. */}
                      <BottomBar />
                    </main>
                  </SidebarProvider>
                </BottomPanelProvider>
              </TooltipProvider>
            </ElementTargetProvider>
          </PendingPromptProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
