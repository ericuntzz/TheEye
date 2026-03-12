import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardContent } from "@/components/dashboard/dashboard-content";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent user={user} />
    </Suspense>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex h-screen bg-background">
      <div className="hidden lg:block w-60 bg-sidebar border-r border-sidebar-border" />
      <div className="flex-1 p-8">
        <div className="max-w-[1280px] mx-auto space-y-6">
          <div className="h-8 w-48 bg-card border border-border rounded-lg animate-pulse" />
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 rounded-2xl bg-card border border-border animate-pulse" />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-52 rounded-xl bg-card border border-border animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
