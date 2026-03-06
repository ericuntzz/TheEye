"use client";

import { useState } from "react";
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
  Zap,
  Loader2,
  CheckCircle,
  AlertCircle,
  Camera,
  Package,
} from "lucide-react";
import { MediaUpload } from "@/components/upload/media-upload";

interface TrainingModeProps {
  propertyId: string;
  propertyName: string;
  onBack: () => void;
  onComplete: () => void;
}

interface TrainingResult {
  rooms: Array<{
    name: string;
    roomType: string;
    items: Array<{ name: string; category: string }>;
    baselineCount: number;
  }>;
  totalItems: number;
  totalRooms: number;
}

type TrainingStep = "upload" | "analyzing" | "complete" | "error";

export function TrainingMode({
  propertyId,
  propertyName,
  onBack,
  onComplete,
}: TrainingModeProps) {
  const [step, setStep] = useState<TrainingStep>("upload");
  const [uploadedFileIds, setUploadedFileIds] = useState<string[]>([]);
  const [result, setResult] = useState<TrainingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  async function handleAnalyze() {
    if (uploadedFileIds.length === 0 || isAnalyzing) return;

    setStep("analyzing");
    setIsAnalyzing(true);
    setError(null);

    try {
      const res = await fetch(`/api/properties/${propertyId}/train`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaUploadIds: uploadedFileIds }),
        credentials: "include",
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: "Training failed" }));
        throw new Error(errData.error || "Training failed");
      }

      const data = await res.json();
      setResult(data);
      setStep("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Training failed");
      setStep("error");
    } finally {
      setIsAnalyzing(false);
    }
  }

  function handleRetry() {
    setUploadedFileIds([]);
    setError(null);
    setStep("upload");
  }

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      {/* Back */}
      <Button
        variant="ghost"
        size="sm"
        className="gap-1 text-muted-foreground mb-6"
        onClick={onBack}
      >
        <ArrowLeft className="h-4 w-4" /> Back to {propertyName}
      </Button>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Zap className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              Train AI — {propertyName}
            </h1>
            <p className="text-sm text-muted-foreground">
              Upload photos or video of the property in its ideal state
            </p>
          </div>
        </div>
      </div>

      {/* Step: Upload */}
      {step === "upload" && (
        <div className="space-y-6">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base text-foreground">
                Step 1: Upload Media
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Upload photos of every room showing furniture, decor, and items in their correct positions.
                The AI will automatically identify each room and catalog all items.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MediaUpload
                propertyId={propertyId}
                onUploadComplete={(files) =>
                  setUploadedFileIds((prev) => [
                    ...prev,
                    ...files.map((f) => f.id),
                  ])
                }
              />
            </CardContent>
          </Card>

          {uploadedFileIds.length > 0 && (
            <Card className="bg-primary/5 border-primary/20">
              <CardContent className="flex items-center justify-between py-4">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {uploadedFileIds.length} file{uploadedFileIds.length !== 1 ? "s" : ""} uploaded
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Ready to analyze. The AI will identify rooms and items automatically.
                  </p>
                </div>
                <Button onClick={handleAnalyze} disabled={isAnalyzing} className="gap-2">
                  <Zap className="h-4 w-4" />
                  Analyze & Train
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Tips */}
          <div className="grid gap-3 sm:grid-cols-3">
            <TipCard
              title="Capture every angle"
              description="Wide shots and close-ups help the AI understand the full room layout"
            />
            <TipCard
              title="Good lighting"
              description="Well-lit photos produce much better AI analysis results"
            />
            <TipCard
              title="Ideal state only"
              description="Upload media showing how each room should look when perfect"
            />
          </div>
        </div>
      )}

      {/* Step: Analyzing */}
      {step === "analyzing" && (
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Loader2 className="h-12 w-12 text-primary animate-spin mb-4" />
            <p className="text-lg font-medium text-foreground mb-2">
              AI is analyzing your media...
            </p>
            <p className="text-sm text-muted-foreground text-center max-w-md">
              Identifying rooms, cataloging items, and creating baseline references.
              This may take a minute.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Step: Complete */}
      {step === "complete" && result && (
        <div className="space-y-6">
          <Card className="bg-green-500/5 border-green-500/20">
            <CardContent className="flex items-center gap-4 py-6">
              <CheckCircle className="h-8 w-8 text-green-400 shrink-0" />
              <div>
                <p className="text-lg font-medium text-foreground">
                  Training Complete!
                </p>
                <p className="text-sm text-muted-foreground">
                  Identified {result.totalRooms} room{result.totalRooms !== 1 ? "s" : ""} and{" "}
                  {result.totalItems} item{result.totalItems !== 1 ? "s" : ""}.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Detected rooms */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              Detected Rooms
            </h3>
            {result.rooms.map((room, i) => (
              <Card key={i} className="bg-card border-border">
                <CardContent className="py-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Camera className="h-4 w-4 text-primary" />
                      <span className="font-medium text-foreground text-sm">
                        {room.name}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground capitalize">
                        {room.roomType}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {room.baselineCount} baseline image{room.baselineCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  {room.items.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {room.items.map((item, j) => (
                        <span
                          key={j}
                          className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground flex items-center gap-1"
                        >
                          <Package className="h-2.5 w-2.5" />
                          {item.name}
                        </span>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          <Button onClick={onComplete} className="gap-2">
            <CheckCircle className="h-4 w-4" />
            Done — View Property
          </Button>
        </div>
      )}

      {/* Step: Error */}
      {step === "error" && (
        <Card className="bg-destructive/5 border-destructive/20">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <AlertCircle className="h-8 w-8 text-destructive mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">
              Training failed
            </p>
            <p className="text-xs text-muted-foreground mb-4">{error}</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleRetry}
                size="sm"
              >
                Try Again
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TipCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-medium text-foreground mb-1">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
