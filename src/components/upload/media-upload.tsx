"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Upload, X, Image, Video, Loader2, CheckCircle } from "lucide-react";

interface MediaUploadProps {
  propertyId: string;
  onUploadComplete?: (files: UploadedFile[]) => void;
  accept?: string;
  maxFiles?: number;
}

interface UploadedFile {
  id: string;
  fileUrl: string;
  fileName: string;
  fileType: string;
}

interface FileWithPreview {
  file: File;
  preview: string;
  status: "pending" | "uploading" | "complete" | "error";
  progress: number;
  result?: UploadedFile;
  error?: string;
}

export function MediaUpload({
  propertyId,
  onUploadComplete,
  accept = "image/*,video/*",
  maxFiles = 50,
}: MediaUploadProps) {
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      files.forEach((f) => {
        if (f.preview) URL.revokeObjectURL(f.preview);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback(
    (newFiles: FileList | File[]) => {
      setFiles((prev) => {
        const remaining = maxFiles - prev.length;
        if (remaining <= 0) return prev;
        const fileArray = Array.from(newFiles).slice(0, remaining);
        const newFileEntries: FileWithPreview[] = fileArray.map((file) => ({
          file,
          preview: file.type.startsWith("image/")
            ? URL.createObjectURL(file)
            : "",
          status: "pending" as const,
          progress: 0,
        }));
        return [...prev, ...newFileEntries];
      });
    },
    [maxFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => {
      const updated = [...prev];
      if (updated[index].preview) URL.revokeObjectURL(updated[index].preview);
      updated.splice(index, 1);
      return updated;
    });
  }, []);

  const uploadAll = useCallback(async () => {
    setIsUploading(true);
    const uploadedFiles: UploadedFile[] = [];

    for (let i = 0; i < files.length; i++) {
      if (files[i].status === "complete") {
        if (files[i].result) uploadedFiles.push(files[i].result!);
        continue;
      }

      setFiles((prev) => {
        const updated = [...prev];
        updated[i] = { ...updated[i], status: "uploading", progress: 30 };
        return updated;
      });

      try {
        const formData = new FormData();
        formData.append("file", files[i].file);
        formData.append("propertyId", propertyId);

        const res = await fetch("/api/upload", {
          method: "POST",
          body: formData,
          credentials: "include",
        });

        if (!res.ok) throw new Error("Upload failed");

        const result = await res.json();

        setFiles((prev) => {
          const updated = [...prev];
          updated[i] = {
            ...updated[i],
            status: "complete",
            progress: 100,
            result,
          };
          return updated;
        });

        uploadedFiles.push(result);
      } catch (err) {
        setFiles((prev) => {
          const updated = [...prev];
          updated[i] = {
            ...updated[i],
            status: "error",
            error: err instanceof Error ? err.message : "Upload failed",
          };
          return updated;
        });
      }
    }

    setIsUploading(false);
    if (uploadedFiles.length > 0 && onUploadComplete) {
      onUploadComplete(uploadedFiles);
    }
  }, [files, propertyId, onUploadComplete]);

  const pendingCount = files.filter((f) => f.status === "pending").length;
  const completeCount = files.filter((f) => f.status === "complete").length;

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      addFiles(e.target.files);
    }
    // Reset so selecting the same file again triggers onChange
    e.target.value = "";
  }

  return (
    <div className="space-y-4">
      {/* Dropzone */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload files - click or drag and drop"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
          isDragging
            ? "border-primary bg-primary/5 dropzone-active"
            : "border-border hover:border-primary/50 hover:bg-secondary/30"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Upload className="h-6 w-6 text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              Drop photos or videos here
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              or click to browse. Supports JPG, PNG, MP4, MOV
            </p>
          </div>
        </div>
      </div>

      {/* File previews */}
      {files.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {files.length} file{files.length !== 1 ? "s" : ""} selected
              {completeCount > 0 && ` (${completeCount} uploaded)`}
            </p>
            {pendingCount > 0 && (
              <Button
                onClick={uploadAll}
                disabled={isUploading}
                size="sm"
                className="gap-2"
              >
                {isUploading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Upload className="h-3 w-3" />
                )}
                Upload {pendingCount} file{pendingCount !== 1 ? "s" : ""}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {files.map((f, i) => (
              <div
                key={i}
                className="relative group rounded-lg border border-border bg-secondary/30 overflow-hidden"
              >
                {/* Preview */}
                <div className="aspect-square flex items-center justify-center">
                  {f.preview ? (
                    <img
                      src={f.preview}
                      alt={f.file.name}
                      className="w-full h-full object-cover"
                    />
                  ) : f.file.type.startsWith("video/") ? (
                    <Video className="h-8 w-8 text-muted-foreground" />
                  ) : (
                    <Image className="h-8 w-8 text-muted-foreground" />
                  )}

                  {/* Status overlay */}
                  {f.status === "uploading" && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <Loader2 className="h-6 w-6 text-primary animate-spin" />
                    </div>
                  )}
                  {f.status === "complete" && (
                    <div className="absolute top-1 right-1">
                      <CheckCircle className="h-5 w-5 text-green-400" />
                    </div>
                  )}
                  {f.status === "error" && (
                    <div className="absolute inset-0 bg-red-500/20 flex items-center justify-center">
                      <span className="text-xs text-red-400">Failed</span>
                    </div>
                  )}
                </div>

                {/* Remove button */}
                {f.status !== "uploading" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(i);
                    }}
                    aria-label={`Remove ${f.file.name}`}
                    className="absolute top-1 left-1 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-3 w-3 text-white" />
                  </button>
                )}

                {/* Filename */}
                <div className="px-2 py-1.5">
                  <p className="text-xs text-muted-foreground truncate">
                    {f.file.name}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
