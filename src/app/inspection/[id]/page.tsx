import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { AppLayout } from "@/components/layout/app-layout";
import { MobileNav } from "@/components/layout/mobile-nav";
import { Button } from "@/components/ui/button";
import { Smartphone, ArrowLeft } from "lucide-react";

export default async function InspectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <AppLayout userEmail={user.email || ""} mobileNav={<MobileNav />}>
      <div className="max-w-2xl px-4 py-10 lg:px-8">
        <div className="rounded-3xl border border-border bg-card p-6 lg:p-8">
          <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
            <Smartphone className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold text-foreground lg:text-2xl">
            Inspections run in the iPhone app
          </h1>
          <p className="mt-2 text-sm text-muted-foreground lg:text-base">
            The website still supports accounts, properties, and history, but the live inspection experience
            depends on native camera, sensor, and on-device AI features that are only available in the iPhone app today.
          </p>
          <div className="mt-5 rounded-2xl border border-border bg-secondary/40 px-4 py-3 text-sm text-muted-foreground">
            Beta access and download instructions are coming soon. For now, use the iPhone app build for
            inspections.
          </div>
          <div className="mt-6">
            <Link href="/dashboard?tab=properties">
              <Button variant="outline" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Back to Properties
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
