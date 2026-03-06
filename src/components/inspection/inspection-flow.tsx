"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { User } from "@supabase/supabase-js";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  ArrowLeft,
  Camera,
  CheckCircle,
  AlertTriangle,
  Loader2,
  XCircle,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";

const SCORE_THRESHOLDS = { good: 80, warning: 50 } as const;

interface Finding {
  category: string;
  description: string;
  severity: string;
  confidence: number;
}

interface InspectionData {
  id: string;
  propertyId: string;
  status: string;
  readinessScore: number | null;
  property: {
    id: string;
    name: string;
  };
  rooms: Array<{
    id: string;
    name: string;
    roomType: string | null;
    coverImageUrl: string | null;
    baselineImages: Array<{
      id: string;
      imageUrl: string;
      label: string | null;
    }>;
  }>;
  results: Array<{
    id: string;
    roomId: string;
    status: string;
    score: number | null;
    findings: Finding[];
  }>;
}

export function InspectionFlow({
  inspectionId,
  user,
}: {
  inspectionId: string;
  user: User;
}) {
  const [inspection, setInspection] = useState<InspectionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [comparing, setComparing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchInspection = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`/api/inspections/${inspectionId}`, {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error("Failed to load inspection");
      }
      const data = await res.json();
      setInspection(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inspection");
    } finally {
      setLoading(false);
    }
  }, [inspectionId]);

  useEffect(() => {
    fetchInspection();
  }, [fetchInspection]);

  async function handleCaptureRoom(roomId: string, baselineImageId: string) {
    if (!fileInputRef.current || !baselineImageId) return;

    setActiveRoomId(roomId);

    fileInputRef.current.dataset.roomId = roomId;
    fileInputRef.current.dataset.baselineImageId = baselineImageId;
    // Reset value so re-selecting the same file triggers onChange
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !inspection) return;

    const roomId = e.target.dataset.roomId;
    const baselineImageId = e.target.dataset.baselineImageId;

    if (!roomId || !baselineImageId) return;

    setUploading(true);
    setError(null);

    try {
      // Upload the current image
      const formData = new FormData();
      formData.append("file", file);
      formData.append("propertyId", inspection.propertyId);

      const uploadRes = await fetch("/api/upload", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!uploadRes.ok) throw new Error("Upload failed");

      const uploadData = await uploadRes.json();

      setUploading(false);
      setComparing(true);

      // Submit for comparison
      const compareRes = await fetch(`/api/inspections/${inspectionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          baselineImageId,
          currentImageUrl: uploadData.fileUrl,
        }),
        credentials: "include",
      });

      if (!compareRes.ok) throw new Error("Comparison failed");

      // Refresh inspection data
      await fetchInspection();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Capture failed. Please try again.");
    } finally {
      setUploading(false);
      setComparing(false);
      setActiveRoomId(null);
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

  if (!inspection) {
    return (
      <AppLayout userEmail={user.email || ""}>
        <div className="p-6">
          <p className="text-muted-foreground">
            {error || "Inspection not found."}
          </p>
          <Link href="/dashboard">
            <Button variant="ghost" className="mt-4 gap-2">
              <ArrowLeft className="h-4 w-4" /> Back to Dashboard
            </Button>
          </Link>
        </div>
      </AppLayout>
    );
  }

  const completedRoomIds = new Set(inspection.results.map((r) => r.roomId));
  const totalRooms = inspection.rooms.length;
  const completedCount = completedRoomIds.size;

  // Calculate score only from rooms that have been scored (exclude nulls)
  const scoredResults = inspection.results.filter((r) => r.score != null);
  const overallScore =
    scoredResults.length > 0
      ? Math.round(
          scoredResults.reduce((sum, r) => sum + r.score!, 0) /
            scoredResults.length,
        )
      : null;

  function getScoreColor(score: number) {
    if (score >= SCORE_THRESHOLDS.good) return "text-green-400";
    if (score >= SCORE_THRESHOLDS.warning) return "text-yellow-400";
    return "text-destructive";
  }

  return (
    <AppLayout userEmail={user.email || ""}>
      <div className="p-6 lg:p-8 max-w-5xl">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          aria-label="Capture room photo"
          onChange={handleFileSelected}
        />

        {/* Back + Header */}
        <Link href={`/property/${inspection.propertyId}`}>
          <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground mb-6">
            <ArrowLeft className="h-4 w-4" /> Back to{" "}
            {inspection.property?.name || "Property"}
          </Button>
        </Link>

        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              Inspection — {inspection.property?.name}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Capture current photos of each room for AI comparison
            </p>
          </div>
          {overallScore !== null && (
            <div className="text-right">
              <div className={`text-3xl font-bold ${getScoreColor(overallScore)}`}>
                {overallScore}
              </div>
              <p className="text-xs text-muted-foreground">Readiness Score</p>
            </div>
          )}
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

        {/* Progress bar */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">
              {completedCount} of {totalRooms} rooms inspected
            </span>
            <span className="text-xs text-muted-foreground">
              {totalRooms > 0
                ? Math.round((completedCount / totalRooms) * 100)
                : 0}
              %
            </span>
          </div>
          <div className="h-2 rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{
                width: `${totalRooms > 0 ? (completedCount / totalRooms) * 100 : 0}%`,
              }}
            />
          </div>
        </div>

        {/* Room list */}
        <div className="space-y-3">
          {inspection.rooms.map((room) => {
            const result = inspection.results.find(
              (r) => r.roomId === room.id,
            );
            const isActive = activeRoomId === room.id;
            const isCompleted = !!result;
            const hasBaseline = room.baselineImages.length > 0;

            return (
              <Card
                key={room.id}
                className={`bg-card border-border ${
                  isCompleted ? "opacity-80" : ""
                }`}
              >
                <CardContent className="py-4">
                  <div className="flex items-center gap-4">
                    {/* Room image thumbnail */}
                    <div className="w-16 h-16 rounded-lg bg-secondary flex items-center justify-center overflow-hidden shrink-0">
                      {room.baselineImages[0]?.imageUrl ? (
                        <img
                          src={room.baselineImages[0].imageUrl}
                          alt={room.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <Camera className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>

                    {/* Room info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm text-foreground">
                          {room.name}
                        </p>
                        {room.roomType && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground capitalize">
                            {room.roomType}
                          </span>
                        )}
                      </div>

                      {/* Result */}
                      {result && (
                        <div className="mt-1 flex items-center gap-2">
                          {result.status === "passed" ? (
                            <CheckCircle className="h-3.5 w-3.5 text-green-400" />
                          ) : (
                            <AlertTriangle className="h-3.5 w-3.5 text-yellow-400" />
                          )}
                          <span className="text-xs text-muted-foreground">
                            Score: {result.score ?? "--"}/100
                            {result.findings && result.findings.length > 0 && (
                              <> — {result.findings.length} finding{result.findings.length !== 1 ? "s" : ""}</>
                            )}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Action */}
                    <div className="shrink-0">
                      {isActive && (uploading || comparing) ? (
                        <div className="flex items-center gap-2 text-sm text-primary">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {uploading ? "Uploading..." : "Comparing..."}
                        </div>
                      ) : isCompleted && hasBaseline ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            handleCaptureRoom(
                              room.id,
                              room.baselineImages[0].id,
                            )
                          }
                          className="text-xs"
                        >
                          Recapture
                        </Button>
                      ) : hasBaseline ? (
                        <Button
                          size="sm"
                          onClick={() =>
                            handleCaptureRoom(
                              room.id,
                              room.baselineImages[0].id,
                            )
                          }
                          className="gap-1"
                        >
                          <Camera className="h-3.5 w-3.5" />
                          Capture
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          No baseline
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Findings details */}
                  {result &&
                    result.findings &&
                    result.findings.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-border space-y-2">
                        {result.findings.map((finding, i) => (
                          <div
                            key={i}
                            className="flex items-start gap-2 text-xs"
                          >
                            <SeverityIcon severity={finding.severity} />
                            <div>
                              <span className="text-foreground">
                                {finding.description}
                              </span>
                              <div className="flex gap-2 mt-0.5 text-muted-foreground">
                                <span className="capitalize">
                                  {finding.category}
                                </span>
                                <span>
                                  {Math.round(finding.confidence * 100)}%
                                  confidence
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* All done */}
        {completedCount === totalRooms && totalRooms > 0 && (
          <Card className="mt-6 bg-green-500/5 border-green-500/20">
            <CardContent className="flex items-center gap-4 py-6">
              <CheckCircle className="h-8 w-8 text-green-400 shrink-0" />
              <div>
                <p className="font-medium text-foreground">
                  Inspection Complete
                </p>
                <p className="text-sm text-muted-foreground">
                  All {totalRooms} rooms inspected. Overall readiness score:{" "}
                  <span
                    className={`font-bold ${getScoreColor(overallScore ?? 0)}`}
                  >
                    {overallScore}/100
                  </span>
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}

function SeverityIcon({ severity }: { severity: string }) {
  switch (severity) {
    case "critical":
      return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />;
    case "high":
      return <AlertTriangle className="h-3.5 w-3.5 text-orange-400 shrink-0 mt-0.5" />;
    case "medium":
      return <AlertTriangle className="h-3.5 w-3.5 text-yellow-400 shrink-0 mt-0.5" />;
    default:
      return <CheckCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />;
  }
}
