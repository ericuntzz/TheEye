"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Phone,
  Mail,
  Star,
  Users,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface Vendor {
  id: string;
  name: string;
  category: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  isPreferred: boolean;
  isActive: boolean;
}

const CATEGORIES = [
  { value: "cleaning", label: "Cleaning" },
  { value: "maintenance", label: "Maintenance" },
  { value: "supplies", label: "Supplies" },
  { value: "linen", label: "Linen" },
  { value: "landscaping", label: "Landscaping" },
  { value: "pool", label: "Pool" },
  { value: "pest_control", label: "Pest Control" },
  { value: "other", label: "Other" },
];

const CATEGORY_COLORS: Record<string, string> = {
  cleaning: "bg-blue-100 text-blue-700",
  maintenance: "bg-orange-100 text-orange-700",
  supplies: "bg-green-100 text-green-700",
  linen: "bg-amber-100 text-amber-700",
  landscaping: "bg-emerald-100 text-emerald-700",
  pool: "bg-cyan-100 text-cyan-700",
  pest_control: "bg-red-100 text-red-700",
  other: "bg-gray-100 text-gray-600",
};

export default function VendorContacts({ propertyId }: { propertyId: string }) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formCategory, setFormCategory] = useState("cleaning");
  const [formEmail, setFormEmail] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formIsPreferred, setFormIsPreferred] = useState(false);

  const fetchVendors = useCallback(async () => {
    try {
      const res = await fetch(`/api/properties/${propertyId}/vendors`);
      if (res.ok) {
        const data = await res.json();
        setVendors(data);
      }
    } catch (err) {
      console.error("Failed to fetch vendors:", err);
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    fetchVendors();
  }, [fetchVendors]);

  const resetForm = () => {
    setFormName("");
    setFormCategory("cleaning");
    setFormEmail("");
    setFormPhone("");
    setFormNotes("");
    setFormIsPreferred(false);
    setEditingVendor(null);
  };

  const openAdd = () => {
    resetForm();
    setShowDialog(true);
  };

  const openEdit = (vendor: Vendor) => {
    setEditingVendor(vendor);
    setFormName(vendor.name);
    setFormCategory(vendor.category);
    setFormEmail(vendor.email || "");
    setFormPhone(vendor.phone || "");
    setFormNotes(vendor.notes || "");
    setFormIsPreferred(vendor.isPreferred);
    setShowDialog(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || (!formEmail.trim() && !formPhone.trim())) return;
    setSaving(true);

    try {
      if (editingVendor) {
        const res = await fetch(`/api/properties/${propertyId}/vendors`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vendorId: editingVendor.id,
            name: formName.trim(),
            category: formCategory,
            email: formEmail.trim() || null,
            phone: formPhone.trim() || null,
            notes: formNotes.trim() || null,
            isPreferred: formIsPreferred,
          }),
        });
        if (res.ok) {
          const updated = await res.json();
          setVendors((prev) =>
            prev.map((v) => (v.id === updated.id ? updated : v)),
          );
        }
      } else {
        const res = await fetch(`/api/properties/${propertyId}/vendors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formName.trim(),
            category: formCategory,
            email: formEmail.trim() || undefined,
            phone: formPhone.trim() || undefined,
            notes: formNotes.trim() || undefined,
            isPreferred: formIsPreferred,
          }),
        });
        if (res.ok) {
          const created = await res.json();
          setVendors((prev) => [...prev, created]);
        }
      }
      setShowDialog(false);
      resetForm();
    } catch (err) {
      console.error("Failed to save vendor:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (vendorId: string) => {
    try {
      const res = await fetch(`/api/properties/${propertyId}/vendors`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId }),
      });
      if (res.ok) {
        setVendors((prev) => prev.filter((v) => v.id !== vendorId));
      }
    } catch (err) {
      console.error("Failed to delete vendor:", err);
    }
  };

  // Group vendors by category
  const grouped = vendors.reduce(
    (acc, v) => {
      if (!acc[v.category]) acc[v.category] = [];
      acc[v.category].push(v);
      return acc;
    },
    {} as Record<string, Vendor[]>,
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-left"
        >
          <Users className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold">
            Vendor Contacts
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({vendors.length})
            </span>
          </h3>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        <Button onClick={openAdd} size="sm" variant="outline">
          <Plus className="mr-1 h-4 w-4" />
          Add Vendor
        </Button>
      </div>

      {expanded && (
        <div className="space-y-4">
          {vendors.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
              <Users className="mx-auto mb-2 h-8 w-8 opacity-50" />
              <p className="text-sm">No vendor contacts yet</p>
              <p className="text-xs">
                Add cleaning crews, maintenance teams, and supply vendors
              </p>
            </div>
          ) : (
            Object.entries(grouped).map(([category, categoryVendors]) => (
              <div key={category} className="space-y-2">
                <h4 className="text-sm font-medium capitalize text-muted-foreground">
                  {category.replace("_", " ")}
                </h4>
                <div className="space-y-2">
                  {categoryVendors.map((vendor) => (
                    <div
                      key={vendor.id}
                      className="flex items-start justify-between rounded-lg border bg-card p-3"
                    >
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{vendor.name}</span>
                          {vendor.isPreferred && (
                            <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                          )}
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                              CATEGORY_COLORS[vendor.category] || CATEGORY_COLORS.other
                            }`}
                          >
                            {vendor.category.replace("_", " ")}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                          {vendor.email && (
                            <a
                              href={`mailto:${vendor.email}`}
                              className="flex items-center gap-1 hover:text-foreground"
                            >
                              <Mail className="h-3.5 w-3.5" />
                              {vendor.email}
                            </a>
                          )}
                          {vendor.phone && (
                            <a
                              href={`tel:${vendor.phone}`}
                              className="flex items-center gap-1 hover:text-foreground"
                            >
                              <Phone className="h-3.5 w-3.5" />
                              {vendor.phone}
                            </a>
                          )}
                        </div>
                        {vendor.notes && (
                          <p className="text-xs text-muted-foreground">
                            {vendor.notes}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openEdit(vendor)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={() => handleDelete(vendor.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingVendor ? "Edit Vendor" : "Add Vendor Contact"}
            </DialogTitle>
            <DialogDescription>
              {editingVendor
                ? "Update vendor contact information"
                : "Add a vendor or service provider for this property"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. CleanPro Services"
              />
            </div>

            <div className="space-y-2">
              <Label>Category *</Label>
              <select
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="vendor@example.com"
                />
              </div>
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  placeholder="+1 (555) 123-4567"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Input
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="e.g. Available weekdays only, minimum 24hr notice"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isPreferred"
                checked={formIsPreferred}
                onChange={(e) => setFormIsPreferred(e.target.checked)}
                className="rounded border-gray-300"
              />
              <Label htmlFor="isPreferred" className="cursor-pointer text-sm">
                Preferred vendor (shown first in dispatch)
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !formName.trim() || (!formEmail.trim() && !formPhone.trim())}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editingVendor ? "Update" : "Add Vendor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
