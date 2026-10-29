import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Alert } from "../../lib/alert";
import { formatMoney, fromMinor, parseAmount, toMinor } from "../../lib/money";
import type { Member, ReceiptData } from "../../lib/types";
import { Button, Card, Chip, Input, Label, useTheme } from "../ui";

/**
 * The scanned line items, with who had each one when splitting by item.
 * Memoized: a long receipt is a lot of chips, and typing elsewhere in the
 * form shouldn't redraw them all.
 */
export const ReceiptItems = memo(function ReceiptItems({
  receipt,
  currency,
  byItem,
  members,
  memberIds,
  assignments,
  onToggle,
  onAddItem,
  onEditItem,
  onDeleteItem,
  taxText,
  onTaxChange,
  tipText,
  onTipChange,
  feesText,
  onFeesChange,
  amount,
  onSetAmount,
}: {
  receipt?: ReceiptData;
  currency: string;
  byItem: boolean;
  members: Member[];
  memberIds: string[];
  assignments: Record<number, string[]>;
  onToggle: (item: number, memberId: string) => void;
  onAddItem: (title: string, price: number, qty: number) => void;
  onEditItem: (index: number, title: string, price: number, qty: number) => void;
  onDeleteItem: (index: number) => void;
  taxText: string;
  onTaxChange: (t: string) => void;
  tipText: string;
  onTipChange: (t: string) => void;
  feesText: string;
  onFeesChange: (t: string) => void;
  amount: number | null;
  onSetAmount: (amt: number) => void;
}) {
  const { colors, styles } = useTheme();

  const [isAdding, setIsAdding] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addPrice, setAddPrice] = useState("");
  const [addQty, setAddQty] = useState("1");

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editQty, setEditQty] = useState("1");

  const items = receipt?.items ?? [];
  const itemsSubtotal = items.reduce((sum, it) => sum + it.price, 0);
  const tax = parseAmount(taxText, currency) ?? 0;
  const tip = parseAmount(tipText, currency) ?? 0;
  const fees = parseAmount(feesText, currency) ?? 0;
  const calculatedTotal = fromMinor(
    toMinor(itemsSubtotal + tax + tip + fees, currency),
    currency,
  );

  const isInSync = () =>
    amount == null ||
    amount === 0 ||
    toMinor(amount, currency) === toMinor(calculatedTotal, currency);

  const submitAdd = () => {
    const trimmed = addTitle.trim();
    const priceVal = parseAmount(addPrice, currency);
    if (!trimmed) {
      Alert.alert("Missing name", "Please enter an item name.");
      return;
    }
    if (priceVal == null) {
      Alert.alert("Invalid price", "Please enter a valid price for the item.");
      return;
    }
    const qtyVal = Math.max(1, parseInt(addQty, 10) || 1);
    const sync = isInSync();
    onAddItem(trimmed, priceVal, qtyVal);
    setAddTitle("");
    setAddPrice("");
    setAddQty("1");
    setIsAdding(false);
    if (sync) {
      const nextTotal = fromMinor(
        toMinor(Math.max(0, itemsSubtotal + priceVal + tax + tip + fees), currency),
        currency,
      );
      onSetAmount(nextTotal);
    }
  };

  const startEdit = (i: number) => {
    const item = items[i];
    if (!item) return;
    setIsAdding(false);
    setEditingIndex(i);
    setEditTitle(item.translatedName || item.name);
    setEditPrice(String(item.price));
    setEditQty(String(item.quantity));
  };

  const submitEdit = () => {
    if (editingIndex == null || !items[editingIndex]) return;
    const trimmed = editTitle.trim();
    const priceVal = parseAmount(editPrice, currency);
    if (!trimmed) {
      Alert.alert("Missing name", "Please enter an item name.");
      return;
    }
    if (priceVal == null) {
      Alert.alert("Invalid price", "Please enter a valid price for the item.");
      return;
    }
    const qtyVal = Math.max(1, parseInt(editQty, 10) || 1);
    const oldPrice = items[editingIndex].price;
    const sync = isInSync();
    onEditItem(editingIndex, trimmed, priceVal, qtyVal);
    if (sync) {
      const nextTotal = fromMinor(
        toMinor(Math.max(0, itemsSubtotal - oldPrice + priceVal + tax + tip + fees), currency),
        currency,
      );
      onSetAmount(nextTotal);
    }
    setEditingIndex(null);
  };

  return (
    <Card>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <Text style={styles.h2} accessibilityRole="header">
          Line items {receipt?.language && <Text style={[styles.muted, { fontSize: 13 }]}>· {receipt.language}</Text>}
        </Text>
        {items.length > 0 && (
          <Text style={{ fontWeight: "700", color: colors.text }} accessibilityLiveRegion="polite">
            Subtotal: {formatMoney(itemsSubtotal, currency)}
          </Text>
        )}
      </View>

      {!!receipt?.merchant && !!receipt.merchantTranslated && (
        <Text style={[styles.muted, { marginBottom: 8 }]}>{receipt.merchant}</Text>
      )}

      {items.length === 0 ? (
        <Text style={[styles.muted, { marginVertical: 8, fontStyle: "italic" }]}>
          No line items added yet. Add items below to split individually.
        </Text>
      ) : (
        items.map((item, i) => {
          const isEditingThis = editingIndex === i;
          if (isEditingThis) {
            return (
              <View
                key={i}
                style={{
                  paddingVertical: 10,
                  borderTopWidth: i ? 1 : 0,
                  borderTopColor: colors.border,
                  backgroundColor: colors.primarySoft,
                  paddingHorizontal: 8,
                  borderRadius: 8,
                  marginVertical: 4,
                }}
              >
                <Text style={[styles.label, { color: colors.text }]}>Edit Item</Text>
                <Input
                  accessibilityLabel="Item name"
                  placeholder="Item name"
                  value={editTitle}
                  onChangeText={setEditTitle}
                  style={{ marginBottom: 6 }}
                />
                <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                  <Input
                    accessibilityLabel="Item price"
                    placeholder="Price"
                    value={editPrice}
                    onChangeText={setEditPrice}
                    keyboardType="decimal-pad"
                    style={{ flex: 2 }}
                  />
                  <Input
                    accessibilityLabel="Item quantity"
                    placeholder="Qty"
                    value={editQty}
                    onChangeText={setEditQty}
                    keyboardType="number-pad"
                    style={{ flex: 1 }}
                  />
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Button title="Save" onPress={submitEdit} style={{ flex: 1, paddingVertical: 8 }} />
                  <Button
                    title="Cancel"
                    variant="ghost"
                    onPress={() => setEditingIndex(null)}
                    style={{ flex: 1, paddingVertical: 8 }}
                  />
                </View>
              </View>
            );
          }

          const assigned = (assignments[i] ?? []).filter((mid) => memberIds.includes(mid));
          const isUnassigned = assigned.length === 0;
          const itemName = item.translatedName || item.name;

          return (
            <View
              key={i}
              style={{ paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: colors.border }}
            >
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "600", color: colors.text }}>
                    {item.quantity > 1 ? `${item.quantity}× ` : ""}
                    {itemName}
                  </Text>
                  {item.translatedName && item.name && item.translatedName !== item.name && (
                    <Text style={[styles.muted, { fontSize: 12 }]}>{item.name}</Text>
                  )}
                </View>
                <Text style={{ color: colors.text, fontWeight: "600", marginRight: 10 }}>
                  {formatMoney(item.price, currency)}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${itemName}`}
                  onPress={() => startEdit(i)}
                  style={{ paddingHorizontal: 6, paddingVertical: 4 }}
                >
                  <Text style={{ color: colors.tint, fontSize: 13, fontWeight: "600" }}>Edit</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${itemName}`}
                  accessibilityHint="Removes this line item from the receipt"
                  onPress={() => {
                    const sync = isInSync();
                    const deletedPrice = item.price;
                    onDeleteItem(i);
                    setEditingIndex(null);
                    if (sync) {
                      const nextTotal = fromMinor(
                        toMinor(Math.max(0, itemsSubtotal - deletedPrice + tax + tip + fees), currency),
                        currency,
                      );
                      onSetAmount(nextTotal);
                    }
                  }}
                  style={{ paddingHorizontal: 6, paddingVertical: 4 }}
                >
                  <Text style={{ color: colors.negative, fontSize: 13, fontWeight: "600" }}>✕</Text>
                </Pressable>
              </View>

              {byItem && (
                <>
                  <View style={[styles.chips, { marginTop: 6 }]}>
                    {memberIds.map((mid) => {
                      const memberName = members.find((m) => m.id === mid)?.name ?? "?";
                      return (
                        <Chip
                          key={mid}
                          label={memberName}
                          selected={(assignments[i] ?? []).includes(mid)}
                          accessibilityLabel={`${memberName} shares ${itemName}`}
                          onPress={() => onToggle(i, mid)}
                        />
                      );
                    })}
                  </View>
                  <Text style={[styles.muted, { fontSize: 11, marginTop: 2 }]}>
                    {memberIds.length === 0
                      ? "Select members to split with above"
                      : isUnassigned
                        ? `Shared by all ${memberIds.length} members (${formatMoney(item.price / memberIds.length, currency)} each)`
                        : assigned.length === 1
                          ? `Assigned to ${members.find((m) => m.id === assigned[0])?.name ?? "?"}`
                          : `Split between ${assigned.length} members (${formatMoney(item.price / assigned.length, currency)} each)`}
                  </Text>
                </>
              )}
            </View>
          );
        })
      )}

      {/* Add Item form */}
      {isAdding ? (
        <View
          style={{
            marginTop: 10,
            padding: 10,
            borderRadius: 8,
            backgroundColor: colors.primarySoft,
          }}
        >
          <Text style={[styles.label, { color: colors.text }]}>Add New Item</Text>
          <Input
            accessibilityLabel="New item name"
            placeholder="Item title (e.g. Pasta, Coffee)"
            value={addTitle}
            onChangeText={setAddTitle}
            style={{ marginBottom: 6 }}
          />
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
            <Input
              accessibilityLabel="New item price"
              placeholder="Price"
              value={addPrice}
              onChangeText={setAddPrice}
              keyboardType="decimal-pad"
              style={{ flex: 2 }}
            />
            <Input
              accessibilityLabel="New item quantity"
              placeholder="Qty (1)"
              value={addQty}
              onChangeText={setAddQty}
              keyboardType="number-pad"
              style={{ flex: 1 }}
            />
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title="Add item" onPress={submitAdd} style={{ flex: 1, paddingVertical: 8 }} />
            <Button
              title="Cancel"
              variant="ghost"
              onPress={() => {
                setIsAdding(false);
                setAddTitle("");
                setAddPrice("");
                setAddQty("1");
              }}
              style={{ flex: 1, paddingVertical: 8 }}
            />
          </View>
        </View>
      ) : (
        <Button
          title="+ Add line item"
          variant="secondary"
          onPress={() => {
            setEditingIndex(null);
            setIsAdding(true);
          }}
          style={{ marginTop: 10 }}
        />
      )}

      {/* Tax, Tip & Fees section */}
      <View style={{ marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
        <Label>Tax, Tip &amp; Service Charges</Label>
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.muted, { fontSize: 11, marginBottom: 4 }]}>Tax ({currency})</Text>
            <Input
              accessibilityLabel={`Tax in ${currency}`}
              placeholder="0"
              value={taxText}
              onChangeText={(t) => {
                const sync = isInSync();
                onTaxChange(t);
                if (sync) {
                  const newTax = parseAmount(t, currency) ?? 0;
                  const nextTotal = fromMinor(
                    toMinor(itemsSubtotal + newTax + tip + fees, currency),
                    currency,
                  );
                  onSetAmount(nextTotal);
                }
              }}
              keyboardType="decimal-pad"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.muted, { fontSize: 11, marginBottom: 4 }]}>Tip ({currency})</Text>
            <Input
              accessibilityLabel={`Tip in ${currency}`}
              placeholder="0"
              value={tipText}
              onChangeText={(t) => {
                const sync = isInSync();
                onTipChange(t);
                if (sync) {
                  const newTip = parseAmount(t, currency) ?? 0;
                  const nextTotal = fromMinor(
                    toMinor(itemsSubtotal + tax + newTip + fees, currency),
                    currency,
                  );
                  onSetAmount(nextTotal);
                }
              }}
              keyboardType="decimal-pad"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.muted, { fontSize: 11, marginBottom: 4 }]}>Fees ({currency})</Text>
            <Input
              accessibilityLabel={`Service charges in ${currency}`}
              placeholder="0"
              value={feesText}
              onChangeText={(t) => {
                const sync = isInSync();
                onFeesChange(t);
                if (sync) {
                  const newFees = parseAmount(t, currency) ?? 0;
                  const nextTotal = fromMinor(
                    toMinor(itemsSubtotal + tax + tip + newFees, currency),
                    currency,
                  );
                  onSetAmount(nextTotal);
                }
              }}
              keyboardType="decimal-pad"
            />
          </View>
        </View>

        {(itemsSubtotal > 0 || tax > 0 || tip > 0 || fees > 0) && (
          <View style={{ marginTop: 4, padding: 8, borderRadius: 8, backgroundColor: colors.bg }}>
            <Text
              style={{ fontSize: 13, color: colors.text }}
              accessibilityLiveRegion="polite"
              accessibilityLabel={`Items ${formatMoney(itemsSubtotal, currency)}${tax > 0 ? `, tax ${formatMoney(tax, currency)}` : ""}${tip > 0 ? `, tip ${formatMoney(tip, currency)}` : ""}${fees > 0 ? `, fees ${formatMoney(fees, currency)}` : ""}, total ${formatMoney(calculatedTotal, currency)}`}
            >
              Items: {formatMoney(itemsSubtotal, currency)}
              {tax > 0 ? ` + Tax: ${formatMoney(tax, currency)}` : ""}
              {tip > 0 ? ` + Tip: ${formatMoney(tip, currency)}` : ""}
              {fees > 0 ? ` + Fees: ${formatMoney(fees, currency)}` : ""}
              {" = "}
              <Text style={{ fontWeight: "700" }}>{formatMoney(calculatedTotal, currency)}</Text>
            </Text>
            {toMinor(amount ?? 0, currency) !== toMinor(calculatedTotal, currency) && calculatedTotal > 0 && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Set bill amount to ${formatMoney(calculatedTotal, currency)}`}
                onPress={() => onSetAmount(calculatedTotal)}
                style={{ marginTop: 6, alignSelf: "flex-start" }}
              >
                <Text style={{ color: colors.tint, fontWeight: "600", fontSize: 13 }}>
                  ↳ Set bill amount to {formatMoney(calculatedTotal, currency)}
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </Card>
  );
});
