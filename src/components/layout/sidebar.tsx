"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Home,
  ClipboardCheck,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Bell,
} from "lucide-react";
import { AtriaMark } from "@/components/ui/atria-mark";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface SidebarProps {
  userEmail: string;
}

const navItems = [
  { href: "/dashboard", label: "Properties", icon: Home, tab: null },
  { href: "/dashboard?tab=inspections", label: "Inspections", icon: ClipboardCheck, tab: "inspections" },
];

export function Sidebar({ userEmail }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams.get("tab");
  const [collapsed, setCollapsed] = useState(false);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <aside
      className={`flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-200 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-sidebar-border">
        <div className="flex items-center justify-center w-8 h-8 shrink-0">
          <AtriaMark size={28} color="white" />
        </div>
        {!collapsed && (
          <span className="text-white font-semibold text-[15px] tracking-[0.18em]">ATRIA</span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-2 space-y-1">
        {navItems.map((item) => {
          // Active if on /dashboard and tab matches
          const isActive =
            pathname === "/dashboard" &&
            (item.tab === null ? !currentTab : currentTab === item.tab);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}

        {/* Notification bell — coming soon */}
        <button
          aria-label="Notifications (coming soon)"
          title="Coming soon"
          disabled
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-sidebar-foreground/40 cursor-not-allowed w-full"
        >
          <Bell className="h-4 w-4 shrink-0" />
          {!collapsed && (
            <span className="flex items-center gap-2">
              Notifications
              <span className="text-[10px] font-medium bg-sidebar-accent/30 text-sidebar-foreground/50 px-1.5 py-0.5 rounded">Soon</span>
            </span>
          )}
        </button>
      </nav>

      {/* Bottom section */}
      <div className="border-t border-sidebar-border py-3 px-2 space-y-1">
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-foreground w-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4 shrink-0" />
          ) : (
            <ChevronLeft className="h-4 w-4 shrink-0" />
          )}
          {!collapsed && <span>Collapse</span>}
        </button>

        {!collapsed && (
          <div className="px-3 py-1.5">
            <p className="truncate text-xs text-sidebar-foreground/60" title={userEmail}>
              {userEmail}
            </p>
          </div>
        )}
        <button
          onClick={handleSignOut}
          aria-label="Sign out"
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-foreground w-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && <span>Sign Out</span>}
        </button>
      </div>
    </aside>
  );
}
