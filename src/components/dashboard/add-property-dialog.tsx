"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowRight } from "lucide-react";

interface AddPropertyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function AddPropertyDialog({
  open,
  onOpenChange,
  onSuccess,
}: AddPropertyDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  // Reset form and error when dialog opens
  useEffect(() => {
    if (open) {
      setError(null);
      setNameError(null);
      setAddressError(null);
      setNotesError(null);
      formRef.current?.reset();
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNameError(null);
    setAddressError(null);
    setNotesError(null);

    const formData = new FormData(e.currentTarget);
    const name = (formData.get("name") as string || "").trim();
    const address = (formData.get("address") as string || "").trim();
    const notes = (formData.get("notes") as string || "").trim();

    if (!name) {
      setNameError("Property name is required");
      return;
    }
    if (name.length < 2) {
      setNameError("Property name must be at least 2 characters");
      return;
    }
    if (name.length > 120) {
      setNameError("Property name must be 120 characters or fewer");
      return;
    }
    if (address.length > 200) {
      setAddressError("Address must be 200 characters or fewer");
      return;
    }
    if (notes.length > 500) {
      setNotesError("Notes must be 500 characters or fewer");
      return;
    }

    setLoading(true);

    const data = {
      name,
      address: address || null,
      notes: notes || null,
    };

    try {
      const res = await fetch("/api/properties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });

      if (!res.ok) {
        let errorMessage = "Failed to create property";
        try {
          const errJson = await res.json();
          errorMessage = errJson.error || errorMessage;
        } catch {
          // Non-JSON response, use generic message
        }
        throw new Error(errorMessage);
      }

      const property = await res.json();
      onOpenChange(false);
      onSuccess();
      router.push(`/property/${property.id}?mode=training`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New Property</DialogTitle>
          <DialogDescription>
            Name your property, then upload photos to train the AI.
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Property Name *</Label>
            <Input
              id="name"
              name="name"
              placeholder="e.g. Beach House, Mountain Cabin"
              required
              aria-invalid={!!nameError}
              aria-describedby={nameError ? "name-error" : undefined}
              className={nameError ? "border-destructive focus-visible:ring-destructive" : ""}
              onChange={() => nameError && setNameError(null)}
            />
            {nameError && (
              <p id="name-error" className="text-xs text-destructive mt-1">{nameError}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="address">Address</Label>
            <Input
              id="address"
              name="address"
              placeholder="e.g. 123 Ocean Drive, Malibu"
              maxLength={200}
              aria-invalid={!!addressError}
              aria-describedby={addressError ? "address-error" : undefined}
              className={addressError ? "border-destructive focus-visible:ring-destructive" : ""}
              onChange={() => addressError && setAddressError(null)}
            />
            {addressError && (
              <p id="address-error" className="text-xs text-destructive mt-1">{addressError}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              name="notes"
              placeholder="Any additional notes"
              rows={3}
              maxLength={500}
              aria-invalid={!!notesError}
              aria-describedby={notesError ? "notes-error" : undefined}
              className={notesError ? "border-destructive focus-visible:ring-destructive" : ""}
              onChange={() => notesError && setNotesError(null)}
            />
            {notesError && (
              <p id="notes-error" className="text-xs text-destructive mt-1">{notesError}</p>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading} className="gap-1.5">
              {loading ? "Creating..." : (
                <>
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
