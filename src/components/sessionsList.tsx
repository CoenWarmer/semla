import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { createClient } from "@/app/utils/supabase/server";
import Link from "next/link";

export async function SessionsList() {
  const supabase = await createClient();

  const { data: sessions } = await supabase.from("sessions").select();

  return (
    <ItemGroup className="max-w-sm">
      {sessions?.map(({ id, created_at, title }) => (
        <Item key={id} variant="outline">
          <Link href={`/sessions/${id}`}>
            <ItemContent className="gap-1">
              <ItemTitle>{title}</ItemTitle>
              <ItemDescription>{created_at}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button variant="ghost" size="icon" className="rounded-full">
                {/* <PlusIcon /> */}
              </Button>
            </ItemActions>
          </Link>
        </Item>
      ))}
    </ItemGroup>
  );
}
