"use client";

import { useState, useEffect, useCallback } from "react";
import type { User } from "@supabase/supabase-js";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ArrowLeft,
  Camera,
  Zap,
  MapPin,
  Home,
  Loader2,
  Eye,
  Upload,
  CheckCircle,
  Package,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";
import { TrainingMode } from "./training-mode";
import { useRouter } from "next/navigation";

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
}

interface Room {
  id: string;
  name: string;
  description: string | null;
  roomType: string | null;
  coverImageUrl: string | null;
  items: Item[];
  baselineImages: BaselineImage[];
}

interface Item {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  condition: string | null;
  importance: string | null;
}

interface BaselineImage {
  id: string;
  imageUrl: string;
  label: string | null;
}

type ViewMode = "overview" | "training";

export function PropertyDetail({
  propertyId,
  user,
}: {
  propertyId: string;
  user: User;
}) {
  const [property, setProperty] = useState<Property | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("overview");
  const router = useRouter();

  const fetchProperty = useCallback(async () => {
    try {
      const res = await fetch(`/api/properties/${propertyId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load property");
      const data = await res.json();
      setProperty(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load property");
    }
  }, [propertyId]);

  const fetchRooms = useCallback(async () => {
    try {
      const res = await fetch(`/api/properties/${propertyId}/rooms`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setRooms(data);
      }
    } catch {
      // Non-critical — rooms may not exist yet
    }
  }, [propertyId]);

  useEffect(() => {
    Promise.all([fetchProperty(), fetchRooms()]).then(() => setLoading(false));
  }, [fetchProperty, fetchRooms]);

  const handleTrainingComplete = useCallback(() => {
    fetchProperty();
    fetchRooms();
    setViewMode("overview");
  }, [fetchProperty, fetchRooms]);

  async function handleStartInspection() {
    setError(null);
    try {
      const res = await fetch("/api/inspections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId }),
        credentials: "include",
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to start inspection");
      }
      const inspection = await res.json();
      router.push(`/inspection/${inspection.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start inspection");
    }
  }

  if (loading) {
    return (
      <AppLayout userEmail={user.email || ""}>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-8 w-8 text-primary animate-spin" />
        </div>
      </AppLayout>
    );
  }

  if (!property) {
    return (
      <AppLayout userEmail={user.email || ""}>
        <div className="p-6">
          <p className="text-muted-foreground">
            {error || "Property not found."}
          </p>
          <Link href="/dashboard">
            <Button variant="ghost" className="mt-4 gap-2">
              <ArrowLeft className="h-4 w-4" /> Back to Properties
            </Button>
          </Link>
        </div>
      </AppLayout>
    );
  }

  if (viewMode === "training") {
    return (
      <AppLayout userEmail={user.email || ""}>
        <TrainingMode
          propertyId={propertyId}
          propertyName={property.name}
          onBack={() => setViewMode("overview")}
          onComplete={handleTrainingComplete}
        />
      </AppLayout>
    );
  }

  return (
    <AppLayout userEmail={user.email || ""}>
      <div className="p-6 lg:p-8 max-w-7xl">
        {/* Back + Header */}
        <div className="mb-6">
          <Link href="/dashboard">
            <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground mb-4">
              <ArrowLeft className="h-4 w-4" /> Properties
            </Button>
          </Link>

          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">
                {property.name}
              </h1>
              {(property.address || property.city) && (
                <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                  <MapPin className="h-3 w-3" />
                  {[property.address, property.city, property.state]
                    .filter(Boolean)
                    .join(", ")}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setViewMode("training")}
                className="gap-2"
              >
                <Upload className="h-4 w-4" />
                {property.trainingStatus === "trained" ? "Retrain" : "Train AI"}
              </Button>
              {property.trainingStatus === "trained" && (
                <Button onClick={handleStartInspection} className="gap-2">
                  <Eye className="h-4 w-4" />
                  New Inspection
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <Card className="bg-destructive/5 border-destructive/20 mb-6">
            <CardContent className="flex items-center gap-3 py-3">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
              <p className="text-sm text-foreground">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Property info cards */}
        <div className="grid gap-4 sm:grid-cols-4 mb-8">
          <InfoCard label="Type" value={property.propertyType || "—"} icon={Home} />
          <InfoCard
            label="Size"
            value={property.squareFeet ? `${property.squareFeet.toLocaleString()} sqft` : "—"}
            icon={Package}
          />
          <InfoCard
            label="Rooms"
            value={rooms.length.toString()}
            icon={Camera}
          />
          <InfoCard
            label="Status"
            value={
              property.trainingStatus === "trained"
                ? "AI Ready"
                : property.trainingStatus === "training"
                  ? "Training..."
                  : "Untrained"
            }
            icon={Zap}
            highlight={property.trainingStatus === "trained"}
          />
        </div>

        {/* Untrained prompt */}
        {property.trainingStatus !== "trained" && (
          <Card className="bg-primary/5 border-primary/20 mb-8">
            <CardContent className="flex items-center gap-4 py-6">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <Zap className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">
                  Train the AI on this property
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Upload photos or video of each room in its ideal state. The AI will automatically
                  identify rooms, categorize items, and create baseline references for future inspections.
                </p>
              </div>
              <Button onClick={() => setViewMode("training")} size="sm" className="gap-2 shrink-0">
                <Upload className="h-4 w-4" />
                Start Training
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Rooms grid */}
        {rooms.length > 0 ? (
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-4">
              Rooms ({rooms.length})
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rooms.map((room) => (
                <Card key={room.id} className="bg-card border-border">
                  {/* Room cover */}
                  <div className="h-32 bg-secondary rounded-t-lg flex items-center justify-center overflow-hidden">
                    {room.coverImageUrl ? (
                      <img
                        src={room.coverImageUrl}
                        alt={room.name}
                        className="w-full h-full object-cover"
                      />
                    ) : room.baselineImages.length > 0 ? (
                      <img
                        src={room.baselineImages[0].imageUrl}
                        alt={room.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Camera className="h-6 w-6 text-muted-foreground" />
                    )}
                  </div>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-foreground">
                      {room.name}
                    </CardTitle>
                    {room.roomType && (
                      <CardDescription className="capitalize text-muted-foreground">
                        {room.roomType}
                      </CardDescription>
                    )}
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Camera className="h-3 w-3" />
                        {room.baselineImages.length} baseline{room.baselineImages.length !== 1 ? "s" : ""}
                      </span>
                      <span className="flex items-center gap-1">
                        <Package className="h-3 w-3" />
                        {room.items.length} item{room.items.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    {room.items.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {room.items.slice(0, 5).map((item) => (
                          <span
                            key={item.id}
                            className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground"
                          >
                            {item.name}
                          </span>
                        ))}
                        {room.items.length > 5 && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                            +{room.items.length - 5} more
                          </span>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ) : property.trainingStatus === "trained" ? (
          <Card className="bg-card border-border">
            <CardContent className="py-12 text-center">
              <CheckCircle className="h-8 w-8 text-green-400 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                Property is trained but no rooms were detected. Try retraining with more photos.
              </p>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </AppLayout>
  );
}

function InfoCard({
  label,
  value,
  icon: Icon,
  highlight,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  highlight?: boolean;
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="py-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className={`h-4 w-4 ${highlight ? "text-primary" : "text-muted-foreground"}`} />
        </div>
        <p className={`text-sm font-medium ${highlight ? "text-primary" : "text-foreground"}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
