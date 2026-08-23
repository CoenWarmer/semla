import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

export async function SessionsList() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: sessions } = await supabase
    .from("sessions")
    .select("id, created_at, title")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (!sessions?.length) {
    return null;
  }

  return (
    <ItemGroup className="max-w-sm">
      {sessions.map(({ id, created_at, title }) => {
        const date = new Date(created_at).toLocaleDateString("nl-NL", {
          day: "2-digit",
          month: "2-digit",
          year: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        return (
          <Item key={id} variant="outline">
            <Link href={`/sessions/${id}`}>
              <ItemContent className="gap-1">
                <ItemTitle>{title}</ItemTitle>
                <ItemDescription>{date}</ItemDescription>
              </ItemContent>
            </Link>
          </Item>
        );
      })}
    </ItemGroup>
  );
}
