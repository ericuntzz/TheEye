"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { User } from "@supabase/supabase-js";
import { AppLayout } from "@/components/layout/app-layout";
import { MobileNav } from "@/components/layout/mobile-nav";
import { Button } from "@/components/ui/button";
// Card components available if needed for future UI additions
import {
  ArrowLeft,
  ScanLine,
  CheckCircle,
  AlertTriangle,
  Loader2,
  XCircle,
  AlertCircle,
  ChevronLeft,
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
      <AppLayout userEmail={user.email || ""} mobileNav={<MobileNav />}>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-8 w-8 text-primary animate-spin" />
        </div>
      </AppLayout>
    );
  }

  if (!inspection) {
    return (
      <AppLayout userEmail={user.email || ""} mobileNav={<MobileNav />}>
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

  const scoredResults = inspection.results.filter((r) => r.score != null);
  const overallScore =
    scoredResults.length > 0
      ? Math.round(
          scoredResults.reduce((sum, r) => sum + r.score!, 0) /
            scoredResults.length,
        )
      : null;

  function getScoreColor(score: number) {
    if (score >= SCORE_THRESHOLDS.good) return "text-green-600";
    if (score >= SCORE_THRESHOLDS.warning) return "text-yellow-600";
    return "text-destructive";
  }

  function getScoreLabel(score: number) {
    if (score >= SCORE_THRESHOLDS.good) return "Good";
    if (score >= SCORE_THRESHOLDS.warning) return "Fair";
    return "Needs Attention";
  }

  const progressPercent = totalRooms > 0 ? Math.round((completedCount / totalRooms) * 100) : 0;

  return (
    <AppLayout userEmail={user.email || ""} mobileNav={<MobileNav />}>
      <div className="px-4 pb-6 lg:p-8 max-w-5xl">
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

        {/* Mobile header */}
        <div className="lg:hidden pt-4 pb-3">
          <Link href={`/property/${inspection.propertyId}`}>
            <button className="flex items-center gap-1 text-sm text-muted-foreground mb-3">
              <ChevronLeft className="h-4 w-4" /> {inspection.property?.name || "Property"}
            </button>
          </Link>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-foreground">Inspection</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Capture photos for AI comparison
              </p>
            </div>
            {overallScore !== null && (
              <div className="flex items-center gap-2">
                <div className={`text-2xl font-semibold font-mono ${getScoreColor(overallScore)}`}>
                  {overallScore}
                </div>
                <div className="text-right">
                  <span className={`text-[10px] font-medium ${getScoreColor(overallScore)}`}>
                    {getScoreLabel(overallScore)}
                  </span>
                  <br />
                  <span className="text-[10px] text-muted-foreground">Score</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Desktop header */}
        <div className="hidden lg:block">
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
                <div className={`text-3xl font-semibold font-mono ${getScoreColor(overallScore)}`}>
                  {overallScore}
                </div>
                <p className={`text-xs font-medium ${getScoreColor(overallScore)}`}>
                  {getScoreLabel(overallScore)}
                </p>
                <p className="text-xs text-muted-foreground">Readiness Score</p>
              </div>
            )}
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-3 rounded-xl bg-destructive/5 border border-destructive/20 px-4 py-3 mb-4">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
            <p className="text-sm text-foreground">{error}</p>
          </div>
        )}

        {/* Progress bar */}
        <div className="mb-5 lg:mb-8">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">
              {completedCount} of {totalRooms} rooms
            </span>
            <span className="text-xs font-medium text-foreground">{progressPercent}%</span>
          </div>
          <div className="h-2 rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Room list */}
        <div className="space-y-2.5 lg:space-y-3">
          {inspection.rooms.map((room) => {
            const result = inspection.results.find(
              (r) => r.roomId === room.id,
            );
            const isActive = activeRoomId === room.id;
            const isCompleted = !!result;
            const hasBaseline = room.baselineImages.length > 0;

            return (
              <div
                key={room.id}
                className={`rounded-2xl bg-card border border-border p-3 lg:p-4 ${
                  isCompleted ? "opacity-80" : ""
                }`}
              >
                <div className="flex items-center gap-3 lg:gap-4">
                  {/* Room thumbnail */}
                  <div className="w-12 h-12 lg:w-16 lg:h-16 rounded-xl bg-secondary flex items-center justify-center overflow-hidden shrink-0">
                    {room.baselineImages[0]?.imageUrl ? (
                      <img
                        src={room.baselineImages[0].imageUrl}
                        alt={room.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <ScanLine className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>

                  {/* Room info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm text-foreground truncate">
                        {room.name}
                      </p>
                      {room.roomType && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-lg bg-secondary text-muted-foreground capitalize whitespace-nowrap">
                          {room.roomType}
                        </span>
                      )}
                    </div>

                    {result && (
                      <div className="mt-1 flex items-center gap-2">
                        {result.status === "passed" ? (
                          <CheckCircle className="h-3.5 w-3.5 text-green-600" />
                        ) : (
                          <AlertTriangle className="h-3.5 w-3.5 text-yellow-600" />
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
                      <div className="flex items-center gap-1.5 text-xs text-primary">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="hidden sm:inline">
                          {uploading ? "Uploading..." : "Comparing..."}
                        </span>
                      </div>
                    ) : isCompleted && hasBaseline ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          handleCaptureRoom(room.id, room.baselineImages[0].id)
                        }
                        className="text-xs rounded-xl"
                      >
                        Redo
                      </Button>
                    ) : hasBaseline ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          handleCaptureRoom(room.id, room.baselineImages[0].id)
                        }
                        className="gap-1 rounded-xl"
                      >
                        <ScanLine className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Capture</span>
                      </Button>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        No baseline
                      </span>
                    )}
                  </div>
                </div>

                {/* Findings */}
                {result &&
                  result.findings &&
                  result.findings.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-border space-y-2">
                      {result.findings.map((finding, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <SeverityIcon severity={finding.severity} />
                          <div>
                            <span className="text-foreground">{finding.description}</span>
                            <div className="flex gap-2 mt-0.5 text-muted-foreground">
                              <span className="capitalize">{finding.category}</span>
                              <span>{Math.round(finding.confidence * 100)}% confidence</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            );
          })}
        </div>

        {/* Completion banner */}
        {completedCount === totalRooms && totalRooms > 0 && (
          <div className="mt-5 flex items-center gap-4 rounded-2xl bg-green-500/5 border border-green-500/20 p-4 lg:py-6">
            <CheckCircle className="h-8 w-8 text-green-600 shrink-0" />
            <div>
              <p className="font-medium text-foreground">Inspection Complete</p>
              <p className="text-sm text-muted-foreground">
                All {totalRooms} rooms inspected. Score:{" "}
                <span className={`font-semibold font-mono ${getScoreColor(overallScore ?? 0)}`}>
                  {overallScore}/100
                </span>
              </p>
            </div>
          </div>
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
      return <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />;
    case "medium":
      return <AlertTriangle className="h-3.5 w-3.5 text-yellow-600 shrink-0 mt-0.5" />;
    default:
      return <CheckCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />;
  }
}
