"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  Eye,
  Home,
  ClipboardCheck,
  LogOut,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface SidebarProps {
  userEmail: string;
}

const navItems = [
  { href: "/dashboard", label: "Properties", icon: Home },
  { href: "/dashboard?tab=inspections", label: "Inspections", icon: ClipboardCheck },
];

export function Sidebar({ userEmail }: SidebarProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <aside
      className={`flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-200 ${
        collapsed ? "w-16" : "w-56"
      }`}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 h-14 border-b border-sidebar-border">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
          <Eye className="h-5 w-5 text-primary" />
        </div>
        {!collapsed && (
          <span className="text-foreground font-semibold text-base">The Eye</span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-2 space-y-1">
        {navItems.map((item) => {
          const hrefPath = item.href.split("?")[0];
          const isActive =
            pathname === hrefPath ||
            (hrefPath !== "/dashboard" && pathname.startsWith(hrefPath));
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
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
      </nav>

      {/* Bottom section */}
      <div className="border-t border-sidebar-border py-3 px-2 space-y-1">
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-foreground w-full transition-colors"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4 shrink-0" />
          ) : (
            <ChevronLeft className="h-4 w-4 shrink-0" />
          )}
          {!collapsed && <span>Collapse</span>}
        </button>

        <button
          onClick={handleSignOut}
          aria-label="Sign out"
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-foreground w-full transition-colors"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && (
            <div className="flex flex-col items-start overflow-hidden">
              <span className="truncate text-xs text-muted-foreground max-w-[140px]">
                {userEmail}
              </span>
              <span>Sign Out</span>
            </div>
          )}
        </button>
      </div>
    </aside>
  );
}
