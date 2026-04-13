"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  ClipboardList,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Loader2,
  Check,
  X,
  Package,
  Truck,
  Send,
  Mail,
  Phone,
} from "lucide-react";

interface RestockOrderItem {
  id: string;
  name: string;
  amazonAsin: string | null;
  quantity: number;
  roomName: string | null;
  source: string;
  status: string;
}

interface RestockOrder {
  id: string;
  status: string;
  amazonCartUrl: string | null;
  totalItems: number;
  notes: string | null;
  createdAt: string;
  confirmedAt: string | null;
  orderedAt: string | null;
  deliveredAt: string | null;
  items: RestockOrderItem[];
}

interface Vendor {
  id: string;
  name: string;
  category: string;
  email: string | null;
  phone: string | null;
  isPreferred: boolean;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: "bg-gray-100", text: "text-gray-700", label: "Draft" },
  confirmed: { bg: "bg-blue-100", text: "text-blue-700", label: "Confirmed" },
  ordered: { bg: "bg-amber-100", text: "text-amber-700", label: "Ordered" },
  delivered: { bg: "bg-green-100", text: "text-green-700", label: "Delivered" },
  cancelled: { bg: "bg-red-100", text: "text-red-700", label: "Cancelled" },
};

export function RestockOrders({ propertyId }: { propertyId: string }) {
  const [orders, setOrders] = useState<RestockOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [dispatchOrderId, setDispatchOrderId] = useState<string | null>(null);
  const [dispatchingVendorId, setDispatchingVendorId] = useState<string | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch(`/api/properties/${propertyId}/restock`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setOrders(data);
      }
    } catch (err) {
      console.error("Failed to fetch restock orders:", err);
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  const fetchVendors = useCallback(async () => {
    try {
      const res = await fetch(`/api/properties/${propertyId}/vendors?category=supplies`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setVendors(data);
      }
    } catch (err) {
      console.error("Failed to fetch vendors:", err);
    }
  }, [propertyId]);

  useEffect(() => {
    fetchOrders();
    fetchVendors();
  }, [fetchOrders, fetchVendors]);

  const handleDispatch = async (orderId: string, vendor: Vendor, method: "email" | "sms") => {
    setDispatchingVendorId(vendor.id);
    try {
      const res = await fetch(`/api/properties/${propertyId}/restock/${orderId}/dispatch`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId: vendor.id, method }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => null);
        window.alert(error?.error || "Could not prepare the vendor message.");
        return;
      }
      const data = await res.json();
      const deepLink = method === "email" ? data.deepLinks?.email : data.deepLinks?.sms;
      if (!deepLink) {
        window.alert("No vendor link was generated for this dispatch.");
        return;
      }

      window.open(deepLink, "_blank");
      // After user returns from compose, confirm the dispatch
      // Use a small delay to let the compose sheet open
      setTimeout(async () => {
        if (!window.confirm("Did you send the message to the vendor?")) {
          return;
        }

        const confirmRes = await fetch(`/api/properties/${propertyId}/restock/${orderId}/dispatch`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmed: true,
            vendorId: vendor.id,
            method,
          }),
        });

        if (!confirmRes.ok) {
          const error = await confirmRes.json().catch(() => null);
          window.alert(error?.error || "Could not confirm the vendor dispatch.");
          return;
        }

        await fetchOrders();
      }, 500);
    } catch (err) {
      console.error("Failed to dispatch order:", err);
      window.alert("Could not send this order to the vendor. Please try again.");
    } finally {
      setDispatchingVendorId(null);
      setDispatchOrderId(null);
    }
  };

  const updateOrderStatus = async (orderId: string, status: string) => {
    setUpdatingId(orderId);
    try {
      await fetch(`/api/properties/${propertyId}/restock/${orderId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await fetchOrders();
    } catch (err) {
      console.error("Failed to update order:", err);
    } finally {
      setUpdatingId(null);
    }
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  if (loading) {
    return (
      <div className="py-4">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading orders...
        </div>
      </div>
    );
  }

  if (orders.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-base font-semibold text-foreground lg:text-lg mb-3 hover:text-foreground/80 transition-colors"
      >
        <ClipboardList className="h-4 w-4" />
        Restock Orders ({orders.length})
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="space-y-3">
          {orders.map((order) => {
            const style = STATUS_STYLES[order.status] || STATUS_STYLES.draft;
            const activeItems = order.items.filter((i) => i.status !== "removed");
            const isUpdating = updatingId === order.id;

            return (
              <div
                key={order.id}
                className="rounded-xl border border-border bg-card p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
                      {style.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(order.createdAt)}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {activeItems.length} item{activeItems.length !== 1 ? "s" : ""}
                  </span>
                </div>

                <div className="space-y-1.5 mb-3">
                  {activeItems.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 text-sm">
                      <span className="w-6 h-6 rounded-md bg-secondary flex items-center justify-center text-xs font-medium text-muted-foreground shrink-0">
                        {item.quantity}
                      </span>
                      <span className="text-foreground truncate flex-1">{item.name}</span>
                      {item.roomName && (
                        <span className="text-[11px] text-muted-foreground shrink-0">{item.roomName}</span>
                      )}
                      {item.amazonAsin && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 font-medium shrink-0">
                          ASIN
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {order.amazonCartUrl && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-amber-700 border-amber-200 hover:bg-amber-50"
                      onClick={() => window.open(order.amazonCartUrl!, "_blank")}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open Amazon Cart
                    </Button>
                  )}

                  {order.status === "draft" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => updateOrderStatus(order.id, "confirmed")}
                      disabled={isUpdating}
                    >
                      {isUpdating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Confirm
                    </Button>
                  )}

                  {order.status === "confirmed" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => updateOrderStatus(order.id, "ordered")}
                        disabled={isUpdating}
                      >
                        {isUpdating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Package className="h-3.5 w-3.5" />}
                        Mark Ordered
                      </Button>
                      {vendors.length > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 text-blue-700 border-blue-200 hover:bg-blue-50"
                          onClick={() => setDispatchOrderId(dispatchOrderId === order.id ? null : order.id)}
                        >
                          <Send className="h-3.5 w-3.5" />
                          Send to Vendor
                        </Button>
                      )}
                    </>
                  )}

                  {order.status === "ordered" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-green-700 border-green-200 hover:bg-green-50"
                      onClick={() => updateOrderStatus(order.id, "delivered")}
                      disabled={isUpdating}
                    >
                      {isUpdating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Truck className="h-3.5 w-3.5" />}
                      Mark Delivered
                    </Button>
                  )}

                  {(order.status === "draft" || order.status === "confirmed") && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-red-500 hover:text-red-700 hover:bg-red-50"
                      onClick={() => updateOrderStatus(order.id, "cancelled")}
                      disabled={isUpdating}
                    >
                      <X className="h-3.5 w-3.5" />
                      Cancel
                    </Button>
                  )}
                </div>

                {/* Vendor dispatch picker */}
                {dispatchOrderId === order.id && (
                  <div className="mt-3 pt-3 border-t border-border space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Choose a vendor to send this order to:</p>
                    {vendors.map((vendor) => {
                      const isDispatching = dispatchingVendorId === vendor.id;
                      return (
                        <div key={vendor.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-secondary/50">
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium text-foreground">{vendor.name}</span>
                            {vendor.isPreferred && (
                              <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">★ Preferred</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {vendor.email && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1 h-7 text-xs"
                                onClick={() => handleDispatch(order.id, vendor, "email")}
                                disabled={isDispatching}
                              >
                                {isDispatching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mail className="h-3 w-3" />}
                                Email
                              </Button>
                            )}
                            {vendor.phone && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1 h-7 text-xs"
                                onClick={() => handleDispatch(order.id, vendor, "sms")}
                                disabled={isDispatching}
                              >
                                {isDispatching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Phone className="h-3 w-3" />}
                                SMS
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
