"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Home, ClipboardCheck, User, Plus } from "lucide-react";

const navItems = [
  { href: "/dashboard", label: "Properties", icon: Home },
  { href: "/dashboard?tab=inspections", label: "Inspections", icon: ClipboardCheck },
  { href: "/dashboard?tab=profile", label: "Profile", icon: User },
];

interface MobileNavProps {
  onAddProperty?: () => void;
}

export function MobileNav({ onAddProperty }: MobileNavProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams.get("tab");

  function isActive(href: string) {
    const [hrefPath, hrefQuery] = href.split("?");
    if (hrefQuery) {
      const params = new URLSearchParams(hrefQuery);
      return pathname === hrefPath && currentTab === params.get("tab");
    }
    return pathname === hrefPath && !currentTab;
  }

  return (
    <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50">
      {/* Blur backdrop */}
      <div className="absolute inset-0 bg-background/80 backdrop-blur-xl border-t border-border" />

      <nav className="relative flex items-center justify-around px-2 pb-[env(safe-area-inset-bottom)] h-16">
        {navItems.map((item) => {
          const active = isActive(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                active
                  ? "text-primary"
                  : "text-muted-foreground"
              }`}
            >
              <div className={`p-1.5 rounded-xl transition-colors ${active ? "bg-primary/10" : ""}`}>
                <Icon className="h-5 w-5" />
              </div>
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}

        {/* Floating add button */}
        {onAddProperty && (
          <button
            onClick={onAddProperty}
            className="flex flex-col items-center gap-0.5 px-4 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary rounded-xl"
          >
            <div className="p-1.5 rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
              <Plus className="h-5 w-5" />
            </div>
            <span className="text-[10px] font-medium text-primary">Add</span>
          </button>
        )}
      </nav>
    </div>
  );
}
