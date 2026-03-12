import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";
import { AtriaMark } from "@/components/ui/atria-mark";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center text-center max-w-sm">
        <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-5">
          <AtriaMark size={28} color="navy" />
        </div>
        <h1 className="text-4xl font-semibold font-mono text-foreground mb-2">
          404
        </h1>
        <p className="text-sm text-muted-foreground mb-6">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link href="/dashboard">
          <Button className="gap-2">
            <Home className="h-4 w-4" />
            Back to Dashboard
          </Button>
        </Link>
      </div>
    </div>
  );
}
