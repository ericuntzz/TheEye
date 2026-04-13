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
  ShoppingCart,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Package,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface SupplyItem {
  id: string;
  name: string;
  category: string;
  amazonAsin: string | null;
  amazonUrl: string | null;
  defaultQuantity: number;
  parLevel: number | null;
  currentStock: number | null;
  unit: string | null;
  vendor: string | null;
  notes: string | null;
  isActive: boolean;
  roomId: string | null;
}

interface Room {
  id: string;
  name: string;
}

const CATEGORIES = [
  { value: "toiletry", label: "Toiletry" },
  { value: "cleaning", label: "Cleaning" },
  { value: "linen", label: "Linen" },
  { value: "kitchen", label: "Kitchen" },
  { value: "amenity", label: "Amenity" },
  { value: "maintenance", label: "Maintenance" },
  { value: "other", label: "Other" },
];

const CATEGORY_COLORS: Record<string, string> = {
  toiletry: "bg-purple-100 text-purple-700",
  cleaning: "bg-blue-100 text-blue-700",
  linen: "bg-amber-100 text-amber-700",
  kitchen: "bg-orange-100 text-orange-700",
  amenity: "bg-green-100 text-green-700",
  maintenance: "bg-red-100 text-red-700",
  other: "bg-gray-100 text-gray-700",
};

export function SupplyCatalog({
  propertyId,
  rooms,
}: {
  propertyId: string;
  rooms: Room[];
}) {
  const [supplies, setSupplies] = useState<SupplyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<SupplyItem | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formCategory, setFormCategory] = useState("toiletry");
  const [formAsin, setFormAsin] = useState("");
  const [formQuantity, setFormQuantity] = useState("1");
  const [formParLevel, setFormParLevel] = useState("");
  const [formUnit, setFormUnit] = useState("each");
  const [formVendor, setFormVendor] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formRoomId, setFormRoomId] = useState("");

  const fetchSupplies = useCallback(async () => {
    try {
      const res = await fetch(`/api/properties/${propertyId}/supplies`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setSupplies(data);
      }
    } catch (err) {
      console.error("Failed to fetch supplies:", err);
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    fetchSupplies();
  }, [fetchSupplies]);

  const resetForm = () => {
    setFormName("");
    setFormCategory("toiletry");
    setFormAsin("");
    setFormQuantity("1");
    setFormParLevel("");
    setFormUnit("each");
    setFormVendor("");
    setFormNotes("");
    setFormRoomId("");
    setEditingItem(null);
  };

  const openAddDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEditDialog = (item: SupplyItem) => {
    setEditingItem(item);
    setFormName(item.name);
    setFormCategory(item.category);
    setFormAsin(item.amazonAsin || "");
    setFormQuantity(String(item.defaultQuantity));
    setFormParLevel(item.parLevel ? String(item.parLevel) : "");
    setFormUnit(item.unit || "each");
    setFormVendor(item.vendor || "");
    setFormNotes(item.notes || "");
    setFormRoomId(item.roomId || "");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) return;
    setSaving(true);

    try {
      const body: Record<string, unknown> = {
        name: formName.trim(),
        category: formCategory,
        amazonAsin: formAsin.trim() || undefined,
        defaultQuantity: parseInt(formQuantity, 10) || 1,
        parLevel: formParLevel ? parseInt(formParLevel, 10) : undefined,
        unit: formUnit,
        vendor: formVendor.trim() || undefined,
        notes: formNotes.trim() || undefined,
        roomId: formRoomId || undefined,
      };

      if (editingItem) {
        body.supplyItemId = editingItem.id;
        await fetch(`/api/properties/${propertyId}/supplies`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        await fetch(`/api/properties/${propertyId}/supplies`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      setDialogOpen(false);
      resetForm();
      await fetchSupplies();
    } catch (err) {
      console.error("Failed to save supply item:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (itemId: string) => {
    try {
      await fetch(`/api/properties/${propertyId}/supplies`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplyItemId: itemId }),
      });
      await fetchSupplies();
    } catch (err) {
      console.error("Failed to delete supply item:", err);
    }
  };

  // Group by category
  const grouped = supplies.reduce<Record<string, SupplyItem[]>>((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {});

  const categoryOrder = ["toiletry", "cleaning", "linen", "kitchen", "amenity", "maintenance", "other"];
  const sortedGroups = categoryOrder
    .filter((cat) => grouped[cat])
    .map((cat) => [cat, grouped[cat]] as const);

  if (loading) {
    return (
      <div className="py-6">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading supplies...
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-base font-semibold text-foreground lg:text-lg hover:text-foreground/80 transition-colors"
        >
          <ShoppingCart className="h-4 w-4" />
          Supplies ({supplies.length})
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        <Button
          variant="outline"
          size="sm"
          onClick={openAddDialog}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Supply
        </Button>
      </div>

      {expanded && (
        <>
          {supplies.length === 0 ? (
            <div className="py-8 text-center rounded-2xl bg-card border border-border">
              <Package className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                No supply items yet. Add items to track restocking needs.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={openAddDialog}
                className="mt-3 gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                Add First Supply
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {sortedGroups.map(([category, items]) => (
                <div key={category}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${CATEGORY_COLORS[category] || CATEGORY_COLORS.other}`}>
                      {CATEGORIES.find((c) => c.value === category)?.label || category}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {items.length} item{items.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {items.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border group hover:border-border/80 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-foreground truncate">
                              {item.name}
                            </p>
                            {item.amazonAsin && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium shrink-0">
                                ASIN
                              </span>
                            )}
                          </div>
                          <div className="flex gap-3 text-[11px] text-muted-foreground mt-0.5">
                            <span>Qty: {item.defaultQuantity} {item.unit}</span>
                            {item.parLevel && <span>Par: {item.parLevel}</span>}
                            {item.vendor && <span>{item.vendor}</span>}
                          </div>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEditDialog(item)}
                            className="p-1.5 rounded-md hover:bg-secondary transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                          </button>
                          <button
                            onClick={() => handleDelete(item.id)}
                            className="p-1.5 rounded-md hover:bg-red-50 transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-red-500" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Add/Edit Supply Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) { resetForm(); } setDialogOpen(open); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Supply Item" : "Add Supply Item"}</DialogTitle>
            <DialogDescription>
              {editingItem ? "Update this supply item." : "Add an item to track for restocking."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="supply-name">Name</Label>
              <Input
                id="supply-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Hand soap, Coffee pods"
              />
            </div>

            <div>
              <Label htmlFor="supply-category">Category</Label>
              <select
                id="supply-category"
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat.value} value={cat.value}>{cat.label}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="supply-qty">Default Qty</Label>
                <Input
                  id="supply-qty"
                  type="number"
                  min="1"
                  value={formQuantity}
                  onChange={(e) => setFormQuantity(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="supply-unit">Unit</Label>
                <Input
                  id="supply-unit"
                  value={formUnit}
                  onChange={(e) => setFormUnit(e.target.value)}
                  placeholder="each, pack, roll"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="supply-asin">Amazon ASIN</Label>
              <Input
                id="supply-asin"
                value={formAsin}
                onChange={(e) => setFormAsin(e.target.value)}
                placeholder="B0XXXXXXXXXX"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Find the ASIN on the Amazon product page to enable one-click cart links.
              </p>
            </div>

            <div>
              <Label htmlFor="supply-par">Par Level</Label>
              <Input
                id="supply-par"
                type="number"
                min="0"
                value={formParLevel}
                onChange={(e) => setFormParLevel(e.target.value)}
                placeholder="Minimum stock before reorder"
              />
            </div>

            <div>
              <Label htmlFor="supply-vendor">Vendor</Label>
              <Input
                id="supply-vendor"
                value={formVendor}
                onChange={(e) => setFormVendor(e.target.value)}
                placeholder="e.g. Amazon, Costco"
              />
            </div>

            {rooms.length > 0 && (
              <div>
                <Label htmlFor="supply-room">Room (optional)</Label>
                <select
                  id="supply-room"
                  value={formRoomId}
                  onChange={(e) => setFormRoomId(e.target.value)}
                  className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">All rooms / property-wide</option>
                  {rooms.map((room) => (
                    <option key={room.id} value={room.id}>{room.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <Label htmlFor="supply-notes">Notes</Label>
              <Input
                id="supply-notes"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="e.g. Guest preference: unscented"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!formName.trim() || saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingItem ? "Save Changes" : "Add Item"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
