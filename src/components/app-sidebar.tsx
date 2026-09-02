import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { BookOpen, Settings } from "lucide-react";
import Link from "next/link";
import { NewSessionButton } from "./new-session-button";
import { ProjectsCombobox } from "./projects-combobox";
import { SessionsList } from "./sessions-list";

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader className="flex flex-row items-center justify-between p-0">
        <SidebarGroup>
          <SidebarGroupContent className="px-2">
            <ProjectsCombobox />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <div className="flex flex-row justify-between items-center mb-2">
            <span>Sessions</span>
            <NewSessionButton />
          </div>
          <SessionsList />
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/wiki" />}
              tooltip="Wiki"
            >
              <BookOpen />
              <span>Wiki</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/settings" />}
              tooltip="Settings"
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
