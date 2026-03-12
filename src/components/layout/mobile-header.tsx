"use client";

import { Bell } from "lucide-react";
import { AtriaMark } from "@/components/ui/atria-mark";

interface MobileHeaderProps {
  userEmail: string;
  title?: string;
  subtitle?: string;
}

export function MobileHeader({ userEmail, title, subtitle }: MobileHeaderProps) {
  const initial = userEmail ? userEmail[0].toUpperCase() : "U";
  const firstName = userEmail.split("@")[0];
  const greeting = getGreeting();

  return (
    <div className="lg:hidden px-5 pt-[env(safe-area-inset-top)] pb-2">
      <div className="flex items-center justify-between pt-4 pb-3">
        {/* Left: avatar + greeting */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-heading flex items-center justify-center text-white font-semibold text-sm shadow-lg shadow-heading/20">
            {initial}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{greeting}</p>
            <p className="text-sm font-semibold text-heading capitalize truncate max-w-[180px]">
              {firstName}
            </p>
          </div>
        </div>

        {/* Right: logo + notification */}
        <div className="flex items-center gap-2">
          <button
            aria-label="Notifications"
            className="relative p-2 rounded-xl bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Bell className="h-5 w-5" />
          </button>
          <div className="flex items-center justify-center h-9 w-9">
            <AtriaMark size={28} color="navy" />
          </div>
        </div>
      </div>

      {/* Page title */}
      {title && (
        <div className="pb-2">
          <h1 className="text-xl font-semibold text-heading">{title}</h1>
          {subtitle && (
            <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
          )}
        </div>
      )}
    </div>
  );
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}
