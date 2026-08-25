import { getPiRuntimeConfig } from "@/lib/pi/runtime-config";
import { NewSessionClient } from "@/components/new-session-client";

export default function NewSessionPage() {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <NewSessionClient defaultTools={[...getPiRuntimeConfig().tools]} />
    </div>
  );
}
