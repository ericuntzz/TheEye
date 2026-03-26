"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { AppLayout } from "@/components/layout/app-layout";
import { MobileHeader } from "@/components/layout/mobile-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Home,
  ClipboardCheck,
  Plus,
  MapPin,
  Zap,
  ArrowRight,
  Upload,
  AlertCircle,
  ChevronRight,
  Calendar,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  User as UserIcon,
  Mail,
  LogOut,
  Shield,
  ArrowUpDown,
  Filter,
  Trash2,
  Ban,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AddPropertyDialog } from "./add-property-dialog";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

interface Property {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  propertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  notes: string | null;
  coverImageUrl: string | null;
  trainingStatus: string | null;
  readinessScore: number | null;
  createdAt: string;
}

interface Inspection {
  id: string;
  propertyId: string;
  inspectorId: string;
  status: string;
  inspectionMode: string;
  startedAt: string;
  completedAt: string | null;
}

type Tab = "properties" | "inspections" | "profile";

function getScoreColor(score: number) {
  if (score >= 80) return "text-green-600";
  if (score >= 50) return "text-yellow-600";
  return "text-destructive";
}

export function DashboardContent({ user }: { user: User }) {
  const searchParams = useSearchParams();
  const rawTab = searchParams.get("tab");
  const validTabs: Tab[] = ["properties", "inspections", "profile"];
  const currentTab: Tab = validTabs.includes(rawTab as Tab) ? (rawTab as Tab) : "properties";

  const [properties, setProperties] = useState<Property[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [loading, setLoading] = useState(true);
  const [inspectionsLoading, setInspectionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inspectionCount, setInspectionCount] = useState<number | null>(null);

  const fetchProperties = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/properties", { credentials: "include" });
      if (!res.ok) {
        throw new Error("Failed to load properties");
      }
      const data = await res.json();
      setProperties(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load properties");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchInspections = useCallback(async () => {
    try {
      setInspectionsLoading(true);
      const res = await fetch("/api/inspections", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setInspections(data);
        setInspectionCount(data.length);
      }
    } catch {
      // Non-critical, fail silently
    } finally {
      setInspectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProperties();
    fetchInspections();
  }, [fetchProperties, fetchInspections]);

  function handlePropertyAdded() {
    fetchProperties();
  }

  const trainedCount = useMemo(
    () => properties.filter((p) => p.trainingStatus === "trained").length,
    [properties],
  );

  const tabConfig: Record<Tab, { title: string; subtitle: string }> = {
    properties: { title: "Properties", subtitle: "Manage your inspections" },
    inspections: { title: "Inspections", subtitle: "View inspection history" },
    profile: { title: "Profile", subtitle: "Account settings" },
  };

  const { title, subtitle } = tabConfig[currentTab] || tabConfig.properties;

  return (
    <AppLayout
      userEmail={user.email || ""}
      mobileNav={<MobileNav onAddProperty={() => setDialogOpen(true)} />}
    >
      {/* Mobile header */}
      <MobileHeader
        userEmail={user.email || ""}
        title={title}
        subtitle={subtitle}
      />

      {currentTab === "properties" && (
        <PropertiesTab
          properties={properties}
          loading={loading}
          error={error}
          trainedCount={trainedCount}
          inspectionCount={inspectionCount}
          onAddProperty={() => setDialogOpen(true)}
          onRetry={fetchProperties}
        />
      )}

      {currentTab === "inspections" && (
        <InspectionsTab
          inspections={inspections}
          properties={properties}
          loading={inspectionsLoading}
          onRefresh={fetchInspections}
        />
      )}

      {currentTab === "profile" && (
        <ProfileTab user={user} />
      )}

      <AddPropertyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={handlePropertyAdded}
      />
    </AppLayout>
  );
}

type SortOption = "newest" | "name" | "status";
type FilterOption = "all" | "trained" | "untrained";

/* ─── Properties Tab ──────────────────────────────────────── */
function PropertiesTab({
  properties,
  loading,
  error,
  trainedCount,
  inspectionCount,
  onAddProperty,
  onRetry,
}: {
  properties: Property[];
  loading: boolean;
  error: string | null;
  trainedCount: number;
  inspectionCount: number | null;
  onAddProperty: () => void;
  onRetry: () => void;
}) {
  const [sortBy, setSortBy] = useState<SortOption>("newest");
  const [filterBy, setFilterBy] = useState<FilterOption>("all");

  const filteredAndSorted = useMemo(() => {
    let filtered = properties;
    if (filterBy === "trained") {
      filtered = properties.filter((p) => p.trainingStatus === "trained");
    } else if (filterBy === "untrained") {
      filtered = properties.filter((p) => p.trainingStatus !== "trained");
    }

    return [...filtered].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "status") {
        const order = (s: string | null) => (s === "trained" ? 0 : s === "training" ? 1 : 2);
        return order(a.trainingStatus) - order(b.trainingStatus);
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [properties, sortBy, filterBy]);

  return (
    <div className="px-4 pb-6 lg:p-8 max-w-[1280px] mx-auto">
      {/* Desktop header — hidden on mobile */}
      <div className="hidden lg:flex mb-8 items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-heading">Properties</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage your luxury property inspections
          </p>
        </div>
        <Button onClick={onAddProperty} className="gap-2">
          <Plus className="h-4 w-4" />
          Add Property
        </Button>
      </div>

      {/* Quick Stats — horizontal scroll on mobile, grid on md+ */}
      <div className="flex gap-3 overflow-x-auto pb-1 mb-5 lg:mb-8 scrollbar-hide md:grid md:grid-cols-3 md:gap-4 md:overflow-visible">
        <StatCard
          label="Properties"
          value={loading ? "--" : properties.length}
          sub="Total managed"
          icon={<Home className="h-4 w-4 text-primary" />}
        />
        <StatCard
          label="Trained"
          value={loading ? "--" : trainedCount}
          sub="AI-ready"
          icon={<Zap className="h-4 w-4 text-primary" />}
        />
        <StatCard
          label="Inspections"
          value={inspectionCount ?? "--"}
          sub="Total"
          icon={<ClipboardCheck className="h-4 w-4 text-primary" />}
        />
      </div>

      {/* Filter & Sort */}
      {properties.length > 0 && (
        <div className="flex items-center gap-2 mb-4 lg:mb-6">
          <div className="flex items-center gap-1.5 text-xs">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              value={filterBy}
              onChange={(e) => setFilterBy(e.target.value as FilterOption)}
              aria-label="Filter by status"
              className="bg-card border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <option value="all">All</option>
              <option value="trained">Trained</option>
              <option value="untrained">Untrained</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              aria-label="Sort order"
              className="bg-card border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <option value="newest">Newest First</option>
              <option value="name">Name A-Z</option>
              <option value="status">Status</option>
            </select>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl bg-destructive/5 border border-destructive/20 px-4 py-3 mb-5 lg:mb-8">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
          <p className="text-sm text-foreground flex-1">{error}</p>
          <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
            Retry
          </Button>
        </div>
      )}

      {/* Property List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-card border border-border animate-pulse" />
          ))}
        </div>
      ) : properties.length === 0 && !error ? (
        <EmptyState onAdd={onAddProperty} />
      ) : filteredAndSorted.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-muted-foreground">No properties match the current filter.</p>
        </div>
      ) : (
        <>
          {/* Mobile: compact list cards */}
          <div className="space-y-3 md:hidden">
            {filteredAndSorted.map((property) => (
              <MobilePropertyCard key={property.id} property={property} />
            ))}
          </div>

          {/* Tablet/Desktop: grid cards */}
          <div className="hidden md:grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredAndSorted.map((property) => (
              <DesktopPropertyCard key={property.id} property={property} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Inspections Tab ─────────────────────────────────────── */
function InspectionsTab({
  inspections,
  properties,
  loading,
  onRefresh,
}: {
  inspections: Inspection[];
  properties: Property[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Inspection | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Inspection | null>(null);

  // Create a map of property id → property for quick lookups
  const propertyMap = useMemo(
    () => new Map(properties.map((p) => [p.id, p])),
    [properties],
  );

  async function handleCancel(inspectionId: string) {
    setActionLoading(inspectionId);
    setActionError(null);
    try {
      const res = await fetch(`/api/inspections/${inspectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
        credentials: "include",
      });
      if (res.ok) {
        onRefresh();
      } else {
        const err = await res.json().catch(() => ({ error: "Failed to cancel inspection" }));
        setActionError(err.error || "Failed to cancel inspection");
      }
    } catch {
      setActionError("Network error. Please try again.");
    } finally {
      setActionLoading(null);
      setCancelTarget(null);
    }
  }

  async function handleDelete(inspectionId: string) {
    setActionLoading(inspectionId);
    setActionError(null);
    try {
      const res = await fetch(`/api/inspections/${inspectionId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        onRefresh();
      } else {
        const err = await res.json().catch(() => ({ error: "Failed to delete inspection" }));
        setActionError(err.error || "Failed to delete inspection");
      }
    } catch {
      setActionError("Network error. Please try again.");
    } finally {
      setActionLoading(null);
      setDeleteTarget(null);
    }
  }

  function getStatusConfig(status: string) {
    switch (status) {
      case "completed":
        return { icon: CheckCircle2, label: "Completed", color: "text-green-600", bg: "bg-green-500/10 border-green-500/20" };
      case "in_progress":
        return { icon: Loader2, label: "In Progress", color: "text-primary", bg: "bg-primary/10 border-primary/20" };
      case "cancelled":
        return { icon: Ban, label: "Cancelled", color: "text-muted-foreground", bg: "bg-muted border-border" };
      case "failed":
        return { icon: XCircle, label: "Failed", color: "text-destructive", bg: "bg-destructive/10 border-destructive/20" };
      default:
        return { icon: Clock, label: status, color: "text-muted-foreground", bg: "bg-muted border-border" };
    }
  }

  function formatDate(dateStr: string) {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatTime(dateStr: string) {
    const date = new Date(dateStr);
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function getModeLabel(mode: string) {
    const labels: Record<string, string> = {
      turnover: "Turnover",
      maintenance: "Maintenance",
      owner_arrival: "Owner Arrival",
      vacancy_check: "Vacancy Check",
    };
    return labels[mode] || mode;
  }

  return (
    <div className="px-4 pb-6 lg:p-8 max-w-[1280px] mx-auto">
      {/* Desktop header */}
      <div className="hidden lg:flex mb-8 items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-heading">Inspections</h1>
          <p className="text-muted-foreground text-sm mt-1">
            View and manage your property inspections
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="flex gap-3 overflow-x-auto pb-1 mb-5 lg:mb-8 scrollbar-hide lg:grid lg:grid-cols-3 lg:gap-4 lg:overflow-visible">
        <StatCard
          label="Total"
          value={inspections.length}
          sub="All inspections"
          icon={<ClipboardCheck className="h-4 w-4 text-primary" />}
        />
        <StatCard
          label="Completed"
          value={inspections.filter((i) => i.status === "completed").length}
          sub="Finished"
          icon={<CheckCircle2 className="h-4 w-4 text-green-600" />}
        />
        <StatCard
          label="In Progress"
          value={inspections.filter((i) => i.status === "in_progress").length}
          sub="Active"
          icon={<Loader2 className="h-4 w-4 text-primary" />}
        />
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-card border border-border animate-pulse" />
          ))}
        </div>
      ) : inspections.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-5">
            <ClipboardCheck className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">No Inspections Yet</h3>
          <p className="text-sm text-muted-foreground text-center max-w-[280px] mb-6">
            Train a property first, then start your first inspection from the property detail page.
          </p>
          <Link href="/dashboard">
            <Button variant="outline" className="gap-2 rounded-xl h-11 px-6">
              <Home className="h-4 w-4" />
              View Properties
            </Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {actionError && (
            <div className="flex items-center justify-between p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-sm text-destructive">
              <span>{actionError}</span>
              <button onClick={() => setActionError(null)} className="ml-2 font-medium hover:underline">Dismiss</button>
            </div>
          )}
          {inspections.map((inspection) => {
            const property = propertyMap.get(inspection.propertyId);
            const statusConfig = getStatusConfig(inspection.status);
            const StatusIcon = statusConfig.icon;
            const isLoading = actionLoading === inspection.id;

            return (
              <div key={inspection.id} className="flex items-center gap-3.5 p-4 rounded-2xl bg-card border border-border hover:border-primary/50 transition-all group">
                {/* Clickable area — links to inspection detail */}
                <Link href={`/inspection/${inspection.id}`} className="flex items-center gap-3.5 flex-1 min-w-0">
                  {/* Status icon */}
                  <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 border ${statusConfig.bg}`}>
                    <StatusIcon className={`h-5 w-5 ${statusConfig.color} ${inspection.status === "in_progress" ? "animate-spin" : ""}`} />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-foreground truncate">
                        {property?.name || "Unknown Property"}
                      </p>
                      <span className={`inline-flex items-center text-[10px] leading-normal px-2 py-0.5 rounded-full border whitespace-nowrap ${statusConfig.bg} ${statusConfig.color}`}>
                        {statusConfig.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {formatDate(inspection.startedAt)}
                      </span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatTime(inspection.startedAt)}
                      </span>
                      <span className="text-xs text-muted-foreground capitalize">
                        {getModeLabel(inspection.inspectionMode)}
                      </span>
                    </div>
                  </div>
                </Link>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {inspection.status === "in_progress" && (
                    <button
                      onClick={(e) => { e.preventDefault(); setCancelTarget(inspection); }}
                      disabled={isLoading}
                      className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                      title="Cancel inspection"
                    >
                      <Ban className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.preventDefault(); setDeleteTarget(inspection); }}
                    disabled={isLoading}
                    className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors"
                    title="Delete inspection"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                  <Link href={`/inspection/${inspection.id}`}>
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Cancel Confirmation Dialog */}
      <Dialog open={!!cancelTarget} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Cancel Inspection</DialogTitle>
            <DialogDescription>
              This will mark the inspection as cancelled. You can start a new inspection from the property page.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>Keep Going</Button>
            <Button
              variant="destructive"
              onClick={() => cancelTarget && handleCancel(cancelTarget.id)}
              disabled={!!actionLoading}
              className="gap-1.5"
            >
              <Ban className="h-4 w-4" />
              {actionLoading ? "Cancelling..." : "Cancel Inspection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Inspection</DialogTitle>
            <DialogDescription>
              This will permanently delete this inspection and all its results. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && handleDelete(deleteTarget.id)}
              disabled={!!actionLoading}
              className="gap-1.5"
            >
              <Trash2 className="h-4 w-4" />
              {actionLoading ? "Deleting..." : "Delete Inspection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─── Profile Tab ─────────────────────────────────────────── */
function ProfileTab({ user }: { user: User }) {
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function handleSignOut() {
    setSignOutError(null);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
      window.location.href = "/login";
    } catch {
      setSignOutError("Failed to sign out. Please try again.");
    }
  }

  const createdAt = user.created_at
    ? new Date(user.created_at).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div className="px-4 pb-6 lg:p-8 max-w-[1280px] mx-auto">
      {/* Desktop header */}
      <div className="hidden lg:flex mb-8 items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-heading">Profile</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Your account settings
          </p>
        </div>
      </div>

      <div className="space-y-4 max-w-lg">
        {/* Avatar + Name */}
        <div className="rounded-2xl bg-card border border-border p-6">
          <div className="flex items-center gap-4 mb-6">
            <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <UserIcon className="h-8 w-8 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-foreground truncate">
                {user.user_metadata?.full_name || user.email?.split("@")[0] || "User"}
              </h2>
              <p className="text-sm text-muted-foreground truncate">{user.email}</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Email</p>
                <p className="text-sm text-foreground truncate">{user.email}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Shield className="h-4 w-4 text-muted-foreground shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Account ID</p>
                <p className="text-sm text-foreground font-mono text-[13px]">{user.id.slice(0, 8)}...{user.id.slice(-4)}</p>
              </div>
            </div>

            {createdAt && (
              <div className="flex items-center gap-3">
                <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Member since</p>
                  <p className="text-sm text-foreground">{createdAt}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Sign out error */}
        {signOutError && (
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3">
            <p className="text-sm text-destructive text-center">{signOutError}</p>
          </div>
        )}

        {/* Sign out */}
        <Button
          variant="outline"
          onClick={handleSignOut}
          className="w-full gap-2 rounded-xl h-11 text-destructive hover:text-destructive hover:bg-destructive/5 border-destructive/20"
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </Button>
      </div>
    </div>
  );
}

/* ─── Stat Card ────────────────────────────────────────────── */
function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: number | string;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="min-w-[150px] flex-shrink-0 md:min-w-0 md:flex-shrink rounded-2xl bg-card border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground truncate">{label}</span>
        <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
          {icon}
        </div>
      </div>
      <div className="text-2xl font-semibold font-mono text-foreground">{value}</div>
      <p className="text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

/* ─── Mobile Property Card ─────────────────────────────────── */
function MobilePropertyCard({ property }: { property: Property }) {
  return (
    <Link href={`/property/${property.id}`} aria-label={`View property: ${property.name}`} className="rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
      <div className="flex items-center gap-3.5 p-3 rounded-2xl bg-card border border-border active:bg-card/70 transition-colors">
        {/* Thumbnail */}
        <div className="h-14 w-14 rounded-xl bg-secondary flex items-center justify-center overflow-hidden shrink-0 relative">
          <Home className="h-6 w-6 text-muted-foreground" />
          {property.coverImageUrl && (
            <img
              src={property.coverImageUrl}
              alt={`Photo of ${property.name}`}
              className="absolute inset-0 w-full h-full object-cover"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-foreground truncate" title={property.name}>
              {property.name}
            </p>
            <TrainingBadge status={property.trainingStatus} />
          </div>
          {(property.address || property.city) && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5 min-w-0">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {[property.address, property.city, property.state]
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </p>
          )}
          <div className="flex gap-2 text-[11px] text-muted-foreground mt-1">
            {property.propertyType && (
              <span className="capitalize">{property.propertyType}</span>
            )}
            {property.bedrooms != null && <span>{property.bedrooms} bed</span>}
            {property.bathrooms != null && <span>{property.bathrooms} bath</span>}
          </div>
        </div>

        {/* Readiness score */}
        {property.readinessScore != null && (
          <div className="shrink-0 text-right mr-1">
            <span className={`text-lg font-semibold font-mono ${getScoreColor(property.readinessScore)}`}>
              {property.readinessScore}
            </span>
            <p className="text-[9px] text-muted-foreground leading-tight">Score</p>
          </div>
        )}

        {/* Arrow */}
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
      </div>
    </Link>
  );
}

/* ─── Desktop Property Card ────────────────────────────────── */
function DesktopPropertyCard({ property }: { property: Property }) {
  return (
    <Link href={`/property/${property.id}`} aria-label={`View property: ${property.name}`} className="rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
      <Card className="bg-card border-border cursor-pointer hover:border-primary/50 transition-all group overflow-hidden">
        <div className="h-32 bg-secondary rounded-t-lg flex items-center justify-center overflow-hidden relative">
          <Home className="h-8 w-8 text-muted-foreground" />
          {property.coverImageUrl && (
            <img
              src={property.coverImageUrl}
              alt={`Photo of ${property.name}`}
              className="absolute inset-0 w-full h-full object-cover"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
          )}
        </div>
        <CardHeader className="pb-2 overflow-hidden min-w-0">
          <div className="flex items-center justify-between gap-2 min-w-0 overflow-hidden">
            <CardTitle className="text-sm md:text-base text-foreground group-hover:text-primary transition-colors truncate min-w-0 flex-1" title={property.name}>
              {property.name}
            </CardTitle>
            <TrainingBadge status={property.trainingStatus} />
          </div>
          {(property.address || property.city) && (
            <CardDescription className="flex items-center gap-1 text-muted-foreground min-w-0 overflow-hidden">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {[property.address, property.city, property.state]
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground min-w-0">
              {property.readinessScore != null && (
                <span className={`font-medium font-mono ${getScoreColor(property.readinessScore)}`}>
                  {property.readinessScore}/100
                </span>
              )}
              {property.propertyType && (
                <span className="capitalize">{property.propertyType}</span>
              )}
              {property.bedrooms != null && (
                <span>{property.bedrooms} bed</span>
              )}
              {property.bathrooms != null && (
                <span>{property.bathrooms} bath</span>
              )}
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/* ─── Empty State ──────────────────────────────────────────── */
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-5">
        <Upload className="h-8 w-8 text-primary" />
      </div>
      <h3 className="text-lg font-semibold text-foreground mb-2">Welcome to Atria</h3>
      <p className="text-sm text-muted-foreground text-center max-w-[280px] mb-6">
        Add your first property, upload photos to train the AI, and start inspecting in minutes.
      </p>
      <Button onClick={onAdd} className="gap-2 rounded-xl h-11 px-6">
        <Plus className="h-4 w-4" />
        Add Your First Property
      </Button>
    </div>
  );
}

/* ─── Training Badge ───────────────────────────────────────── */
function TrainingBadge({ status }: { status: string | null }) {
  if (status === "trained") {
    return (
      <span className="inline-flex items-center text-[10px] leading-normal px-2 py-0.5 rounded-full bg-success/10 text-green-800 border border-green-500/20 whitespace-nowrap shrink-0">
        Trained
      </span>
    );
  }
  if (status === "training") {
    return (
      <span className="inline-flex items-center text-[10px] leading-normal px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 whitespace-nowrap shrink-0">
        Training
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-[10px] leading-normal px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border whitespace-nowrap shrink-0">
      Untrained
    </span>
  );
}
