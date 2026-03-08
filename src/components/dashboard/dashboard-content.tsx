"use client";

import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import { AddPropertyDialog } from "./add-property-dialog";
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
  createdAt: string;
}

export function DashboardContent({ user }: { user: User }) {
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
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
      const res = await fetch("/api/inspections", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setInspectionCount(data.length);
      }
    } catch {
      // Non-critical, fail silently
    }
  }, []);

  useEffect(() => {
    fetchProperties();
    fetchInspections();
  }, [fetchProperties, fetchInspections]);

  function handlePropertyAdded() {
    fetchProperties();
  }

  const trainedCount = properties.filter((p) => p.trainingStatus === "trained").length;

  return (
    <AppLayout
      userEmail={user.email || ""}
      mobileNav={<MobileNav onAddProperty={() => setDialogOpen(true)} />}
    >
      {/* Mobile header */}
      <MobileHeader
        userEmail={user.email || ""}
        title="Properties"
        subtitle="Manage your inspections"
      />

      <div className="px-4 pb-6 lg:p-8 max-w-7xl">
        {/* Desktop header — hidden on mobile */}
        <div className="hidden lg:flex mb-8 items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Properties</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Manage your luxury property inspections
            </p>
          </div>
          <Button onClick={() => setDialogOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            Add Property
          </Button>
        </div>

        {/* Quick Stats — horizontal scroll on mobile */}
        <div className="flex gap-3 overflow-x-auto pb-1 mb-5 lg:mb-8 scrollbar-hide lg:grid lg:grid-cols-3 lg:gap-4 lg:overflow-visible">
          <StatCard
            label="Properties"
            value={properties.length}
            sub="Total managed"
            icon={<Home className="h-4 w-4 text-primary" />}
          />
          <StatCard
            label="Trained"
            value={trainedCount}
            sub="AI-ready"
            icon={<Zap className="h-4 w-4 text-primary" />}
          />
          <StatCard
            label="Inspections"
            value={inspectionCount ?? "--"}
            sub="Completed"
            icon={<ClipboardCheck className="h-4 w-4 text-primary" />}
          />
        </div>

        {/* Error state */}
        {error && (
          <div className="flex items-center gap-3 rounded-xl bg-destructive/5 border border-destructive/20 px-4 py-3 mb-5 lg:mb-8">
            <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
            <p className="text-sm text-foreground flex-1">{error}</p>
            <Button variant="outline" size="sm" onClick={fetchProperties} className="shrink-0">
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
          <EmptyState onAdd={() => setDialogOpen(true)} />
        ) : (
          <>
            {/* Mobile: compact list cards */}
            <div className="space-y-3 lg:hidden">
              {properties.map((property) => (
                <MobilePropertyCard key={property.id} property={property} />
              ))}
            </div>

            {/* Desktop: grid cards */}
            <div className="hidden lg:grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {properties.map((property) => (
                <DesktopPropertyCard key={property.id} property={property} />
              ))}
            </div>
          </>
        )}
      </div>

      <AddPropertyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={handlePropertyAdded}
      />
    </AppLayout>
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
    <div className="min-w-[140px] flex-shrink-0 lg:min-w-0 lg:flex-shrink rounded-2xl bg-card border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
          {icon}
        </div>
      </div>
      <div className="text-2xl font-bold text-foreground">{value}</div>
      <p className="text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

/* ─── Mobile Property Card ─────────────────────────────────── */
function MobilePropertyCard({ property }: { property: Property }) {
  return (
    <Link href={`/property/${property.id}`}>
      <div className="flex items-center gap-3.5 p-3 rounded-2xl bg-card border border-border active:bg-card/70 transition-colors">
        {/* Thumbnail */}
        <div className="h-14 w-14 rounded-xl bg-secondary flex items-center justify-center overflow-hidden shrink-0">
          {property.coverImageUrl ? (
            <img
              src={property.coverImageUrl}
              alt={property.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <Home className="h-6 w-6 text-muted-foreground" />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-foreground truncate">
              {property.name}
            </p>
            <TrainingBadge status={property.trainingStatus} />
          </div>
          {(property.address || property.city) && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5 truncate">
              <MapPin className="h-3 w-3 shrink-0" />
              {[property.city, property.state].filter(Boolean).join(", ")}
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

        {/* Arrow */}
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
      </div>
    </Link>
  );
}

/* ─── Desktop Property Card ────────────────────────────────── */
function DesktopPropertyCard({ property }: { property: Property }) {
  return (
    <Link href={`/property/${property.id}`}>
      <Card className="bg-card border-border cursor-pointer hover:border-primary/50 transition-all group">
        <div className="h-32 bg-secondary rounded-t-lg flex items-center justify-center overflow-hidden">
          {property.coverImageUrl ? (
            <img
              src={property.coverImageUrl}
              alt={property.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <Home className="h-8 w-8 text-muted-foreground" />
          )}
        </div>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base text-foreground group-hover:text-primary transition-colors">
              {property.name}
            </CardTitle>
            <TrainingBadge status={property.trainingStatus} />
          </div>
          {(property.address || property.city) && (
            <CardDescription className="flex items-center gap-1 text-muted-foreground">
              <MapPin className="h-3 w-3" />
              {[property.address, property.city, property.state]
                .filter(Boolean)
                .join(", ")}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex gap-3 text-xs text-muted-foreground">
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
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20 whitespace-nowrap">
        Trained
      </span>
    );
  }
  if (status === "training") {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 whitespace-nowrap">
        Training
      </span>
    );
  }
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border whitespace-nowrap">
      Untrained
    </span>
  );
}
