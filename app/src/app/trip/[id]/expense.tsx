import { Alert } from "../../../lib/alert";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Banner, Button, Card, Chip, CurrencyPicker, Field, Input, Label, useTheme } from "../../../components/ui";
import { api, ApiError } from "../../../lib/api";
import { findDuplicate, type DuplicateMatch } from "../../../lib/duplicates";
import { formatMoney, fromMinor, parseAmount, parseRate, toMinor } from "../../../lib/money";
import { describeAge, rateService } from "../../../lib/rates";
import { pickReceiptImage, type ImageSource } from "../../../lib/receiptImage";
import { isCurrencyCode, isISODate, receiptFromScan } from "../../../lib/receiptScan";
import { computeItemizedBreakdown, computeShares } from "../../../lib/split";
import {
  CATEGORIES,
  newId,
  todayISO,
  type Category,
  type Expense,
  type Member,
  type ReceiptData,
  type ReceiptItem,
  type ReceiptScan,
  type Split,
  type Trip,
} from "../../../lib/types";
import {
  useMe,
  useNetwork,
  useQueuedReceipts,
  useSettings,
  useTrip,
  useTripActions,
} from "../../../state/TripsContext";
import { useHomeCurrency } from "../../../state/useHomeCurrency";

/** `queuedId`: finish a receipt snapped offline that couldn't be read automatically. */
type Params = { id: string; expenseId?: string; scan?: ImageSource; queuedId?: string };

export default function ExpenseScreen() {
  const { styles } = useTheme();
  const params = useLocalSearchParams<Params>();
  const trip = useTrip(params.id);
  if (!trip) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.muted}>Trip not found on this device.</Text>
      </View>
    );
  }
  return <ExpenseEditor trip={trip} {...params} />;
}

function ExpenseEditor({ trip, expenseId, scan, queuedId }: Params & { trip: Trip }) {
  const { colors, styles } = useTheme();
  const { saveExpense, saveChanges, deleteExpense, queueReceipt, discardReceipt, refresh, getTrip } = useTripActions();
  const me = useMe(trip.id);
  const settings = useSettings();
  const receipts = useQueuedReceipts();
  const network = useNetwork();
  const existing = expenseId ? trip.expenses.find((e) => e.id === expenseId) : undefined;
  // Captured once: the queue entry is removed when this expense is saved.
  const [queued] = useState(() => (queuedId ? receipts.find((r) => r.id === queuedId) : undefined));
  const draftId = useRef(existing?.id ?? queued?.id ?? newId());
  const { view } = useHomeCurrency(trip);
  const allIds = trip.members.map((m) => m.id);
  // New expenses default to the currency of the last one: you're usually still in the same country.
  // Only the first render needs it, so it isn't worked out again on every keystroke.
  const [lastCurrency] = useState(() => {
    let last: Expense | undefined;
    for (const e of trip.expenses) if (!last || e.createdAt > last.createdAt) last = e;
    return last?.currency;
  });

  const [description, setDescription] = useState(existing?.description ?? "");
  const [category, setCategory] = useState<Category>(existing?.category ?? "food");
  const [amountText, setAmountText] = useState(existing ? String(existing.amount) : "");
  const [currency, setCurrency] = useState(existing?.currency ?? lastCurrency ?? trip.baseCurrency);
  const [rateText, setRateText] = useState(existing ? String(existing.rateToBase) : "");
  const [rateInfo, setRateInfo] = useState<string | null>(null);
  const [liveRate, setLiveRate] = useState<number | null>(null);
  const [rateLoading, setRateLoading] = useState(false);
  const [rateEdited, setRateEdited] = useState(!!existing);
  const [rateCurrency, setRateCurrency] = useState(currency);
  const [rateBase, setRateBase] = useState(trip.baseCurrency);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const rateRequest = useRef(0);
  const invalidateRateRequest = useCallback(() => { ++rateRequest.current; }, []);
  const [paidBy, setPaidBy] = useState(existing?.paidBy ?? queued?.paidBy ?? me ?? allIds[0]);
  const [date, setDate] = useState(existing?.date ?? queued?.capturedOn ?? todayISO());
  const [splitType, setSplitType] = useState<Split["type"]>(existing?.split?.type ?? "equal");
  const [memberIds, setMemberIds] = useState<string[]>(existing?.split?.memberIds ?? queued?.memberIds ?? allIds);
  const [assignments, setAssignments] = useState<Record<number, string[]>>(
    existing?.split?.type === "items" && existing.split.assignments ? existing.split.assignments : {},
  );
  const [receipt, setReceipt] = useState<ReceiptData | undefined>(existing?.receipt);
  const [taxText, setTaxText] = useState(
    existing?.receipt?.tax != null ? String(existing.receipt.tax) : "",
  );
  const [tipText, setTipText] = useState(
    existing?.receipt?.tip != null ? String(existing.receipt.tip) : "",
  );
  const [feesText, setFeesText] = useState(
    existing?.receipt?.serviceCharge != null ? String(existing.receipt.serviceCharge) : "",
  );
  const [preview, setPreview] = useState<string | null>(queued?.imageUri ?? null);
  const [scanning, setScanning] = useState(false);
  const autoScanned = useRef(false);
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);

  const amount = parseAmount(amountText, currency);
  const rate = rateCurrency === currency && rateBase === trip.baseCurrency ? parseRate(rateText) : null;
  const rateWarning = Boolean(rateEdited && liveRate && rate && Math.abs(rate / liveRate - 1) > 0.5);

  const loadRate = async (code: string, force = false) => {
    // Only the latest request counts: the currency can change while a rate is loading.
    const request = ++rateRequest.current;
    setRateText("");
    setLiveRate(null);
    setRateCurrency(code);
    setRateBase(trip.baseCurrency);
    if (code === trip.baseCurrency) {
      setRateText("1");
      setLiveRate(1);
      setRateInfo(null);
      setRateLoading(false);
      return;
    }
    setRateLoading(true);
    try {
      const { rate, table } = await rateService.getRate(code, trip.baseCurrency, force);
      if (request !== rateRequest.current) return;
      setRateText(String(Number(rate.toPrecision(6))));
      setLiveRate(rate);
      setRateInfo(table ? `Live rate · ${table.source} · updated ${describeAge(table.fetchedAt)}` : null);
      setRateEdited(false);
    } catch {
      if (request === rateRequest.current) setRateInfo("Couldn't fetch a live rate — enter one manually.");
    } finally {
      if (request === rateRequest.current) setRateLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    if (!rateEdited || rateCurrency !== currency || rateBase !== trip.baseCurrency) {
      void Promise.resolve().then(() => { if (active) return loadRate(currency); });
    }
    return () => { active = false; invalidateRateRequest(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency, trip.baseCurrency, invalidateRateRequest]);

  const changeCurrency = (code: string) => {
    if (code === currency) return;
    ++rateRequest.current;
    setRateEdited(false);
    setRateText("");
    setLiveRate(null);
    setRateInfo(null);
    setRateLoading(code !== trip.baseCurrency);
    setCurrency(code);
  };

  const runScan = async (source: ImageSource) => {
    let picked;
    try {
      picked = await pickReceiptImage(source);
    } catch (err) {
      Alert.alert("Can't open the camera", err instanceof Error ? err.message : String(err));
      return;
    }
    if (!picked) return;
    setPreview(picked.uri);
    setScanning(true);
    let scanned: ReceiptScan;
    try {
      scanned = await api.scanReceipt(picked.base64, settings.receiptLanguage);
    } catch (err) {
      // No connection, or it timed out: don't lose the photo, read it later instead.
      if (!existing && !queued && !(err instanceof ApiError)) offerToQueue(picked.uri);
      else Alert.alert("Couldn't read the receipt", err instanceof Error ? err.message : String(err));
      return;
    } finally {
      setScanning(false);
    }
    applyScan(scanned);
    checkForDuplicate(scanned);
  };

  // Has someone already added this receipt? Say so before the trip pays for it twice.
  const checkForDuplicate = async (r: ReceiptScan) => {
    setDuplicate(null);
    setCheckingDuplicate(true);
    try {
      await refresh(trip.id); // Pick up what others added since this screen opened.
      const latest = getTrip(trip.id) ?? trip;
      const rateToBase = await rateService.getRate(r.currency, latest.baseCurrency).then(
        ({ rate }) => rate,
        () => null,
      );
      setDuplicate(
        await findDuplicate(api.checkDuplicate, latest, r, {
          rateToBase,
          excludeId: existing?.id ?? queued?.id,
          language: settings.receiptLanguage,
        }),
      );
    } catch {
      // A safety net only: if the check can't run, the expense can still be added as usual.
    } finally {
      setCheckingDuplicate(false);
    }
  };

  const applyScan = (r: ReceiptScan) => {
    setDescription(r.merchant_translated || r.merchant || description);
    setAmountText(String(r.total));
    if (isCurrencyCode(r.currency)) {
      setRateEdited(false);
      if (r.currency === currency) loadRate(r.currency);
      changeCurrency(r.currency);
    }
    if (isISODate(r.date)) setDate(r.date);
    setCategory(r.category);
    setReceipt(receiptFromScan(r));
    setTaxText(r.tax != null ? String(r.tax) : "");
    setTipText(r.tip != null ? String(r.tip) : "");
    setFeesText(r.service_charge != null ? String(r.service_charge) : "");
    setAssignments({});
    if (r.items.length > 0) {
      setSplitType("items");
    }
  };

  const handleAddItem = useCallback(
    (title: string, price: number, qty: number) => {
      const newItem: ReceiptItem = {
        name: title,
        translatedName: title,
        quantity: qty,
        price,
      };
      setReceipt((prev) => {
        const items = [...(prev?.items ?? []), newItem];
        return {
          merchant: prev?.merchant ?? null,
          merchantTranslated: prev?.merchantTranslated ?? null,
          receiptNumber: prev?.receiptNumber ?? null,
          time: prev?.time ?? null,
          language: prev?.language ?? settings.receiptLanguage ?? "English",
          notes: prev?.notes ?? null,
          items,
          tax: parseAmount(taxText, currency) ?? null,
          tip: parseAmount(tipText, currency) ?? null,
          serviceCharge: parseAmount(feesText, currency) ?? null,
        };
      });
    },
    [settings.receiptLanguage, taxText, tipText, feesText, currency],
  );

  const handleEditItem = useCallback(
    (index: number, title: string, price: number, qty: number) => {
      setReceipt((prev) => {
        if (!prev?.items[index]) return prev;
        const prevItem = prev.items[index];
        const updatedItem: ReceiptItem = {
          ...prevItem,
          name: title,
          translatedName: title,
          price,
          quantity: qty,
        };
        const items = prev.items.map((it, idx) => (idx === index ? updatedItem : it));
        return { ...prev, items };
      });
    },
    [],
  );

  const handleDeleteItem = useCallback((index: number) => {
    setReceipt((prev) => {
      if (!prev?.items) return prev;
      const items = prev.items.filter((_, idx) => idx !== index);
      return { ...prev, items };
    });
    setAssignments((prev) => {
      const next: Record<number, string[]> = {};
      for (const [key, val] of Object.entries(prev)) {
        const idx = Number(key);
        if (idx < index) next[idx] = val;
        else if (idx > index) next[idx - 1] = val;
      }
      return next;
    });
  }, []);

  const offerToQueue = (photoUri: string) =>
    Alert.alert(
      "No connection",
      "Save the photo and it will be read and added to the trip automatically once you're back on Wi-Fi.",
      [
        { text: "Enter by hand", style: "cancel" },
        {
          text: "Save for later",
          onPress: async () => {
            try {
              // Already scanning on mobile data, so don't hold this one back for Wi-Fi.
              await queueReceipt(trip.id, photoUri, { paidBy, memberIds, allowCellular: network.cellular });
              router.back();
            } catch (err) {
              Alert.alert("Couldn't save the photo", err instanceof Error ? err.message : String(err));
            }
          },
        },
      ],
    );

  // A queued receipt that was read but couldn't be added (e.g. no exchange rate): start from the scan.
  useEffect(() => {
    if (queued?.scan) applyScan(queued.scan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (scan && !autoScanned.current) {
      autoScanned.current = true;
      runScan(scan);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan]);

  const validDate = isISODate(date);
  const valid = amount != null && amount > 0 && rate != null && rate > 0 && !rateLoading && validDate;
  const split = useMemo<Split>(
    () =>
      splitType === "items" && (receipt?.items.length ?? 0) > 0
        ? { type: "items", memberIds, assignments }
        : { type: "equal", memberIds },
    [splitType, receipt, memberIds, assignments],
  );

  const effectiveReceipt = useMemo<ReceiptData | undefined>(() => {
    const tax = parseAmount(taxText, currency);
    const tip = parseAmount(tipText, currency);
    const fees = parseAmount(feesText, currency);
    if (!receipt && tax == null && tip == null && fees == null) return undefined;
    return {
      merchant: receipt?.merchant ?? null,
      merchantTranslated: receipt?.merchantTranslated ?? null,
      receiptNumber: receipt?.receiptNumber ?? null,
      time: receipt?.time ?? null,
      language: receipt?.language ?? settings.receiptLanguage ?? "English",
      notes: receipt?.notes ?? null,
      items: receipt?.items ?? [],
      tax: tax ?? null,
      tip: tip ?? null,
      serviceCharge: fees ?? null,
    };
  }, [receipt, taxText, tipText, feesText, settings.receiptLanguage, currency]);

  // Only recomputed when an input to the split changes, not on every keystroke elsewhere.
  const shares = useMemo(
    () =>
      amount != null && amount > 0
        ? computeShares({ amount, paidBy, split, receipt: effectiveReceipt, currency })
        : {},
    [amount, paidBy, split, effectiveReceipt, currency],
  );

  const breakdowns = useMemo(
    () =>
      splitType === "items" && (effectiveReceipt?.items.length ?? 0) > 0 && amount != null && amount > 0
        ? computeItemizedBreakdown({
            amount,
            paidBy,
            split,
            receipt: effectiveReceipt,
            currency,
            rateToBase: rate ?? 1,
            baseCurrency: trip.baseCurrency,
          })
        : [],
    [splitType, effectiveReceipt, amount, paidBy, split, currency, rate, trip.baseCurrency],
  );

  const handleCommit = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const expense = createExpenseRecord({
        id: draftId.current,
        existing,
        queued,
        description,
        category,
        amount: amount!,
        currency,
        rateToBase: rate!,
        paidBy,
        date,
        split,
        receipt: effectiveReceipt,
      });
      saveExpense(trip.id, expense);
      await saveChanges();
      if (queued) await discardReceipt(queued.id);
      router.back();
    } catch (error) {
      Alert.alert("Couldn't save the expense", error instanceof Error ? error.message : "Try again. Your receipt photo is still kept.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (!validDate) {
      Alert.alert("Invalid date", "Enter a valid date in YYYY-MM-DD format.");
      return;
    }
    if (!valid) {
      Alert.alert("Missing amount", "Enter the amount and exchange rate.");
      return;
    }
    if (!memberIds.length) {
      Alert.alert("Who's splitting?", "Pick at least one person to split with.");
      return;
    }
    if (duplicateOf) {
      Alert.alert(
        "Add it anyway?",
        `${name(duplicateOf.paidBy)} already added what looks like this receipt. Adding it again charges the trip twice.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Add anyway", style: "destructive", onPress: handleCommit },
        ],
      );
      return;
    }
    handleCommit();
  };

  const handleDelete = () =>
    Alert.alert("Delete this expense?", "This removes it for everyone on the trip.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteExpense(trip.id, existing!.id);
          router.back();
        },
      },
    ]);

  const toggleItemFor = useCallback(
    (item: number, memberId: string) =>
      setAssignments((a) => ({ ...a, [item]: toggle(a[item] ?? [], memberId) })),
    [],
  );

  const name = (memberId: string) => trip.members.find((m) => m.id === memberId)?.name ?? "?";
  const duplicateOf = duplicate ? trip.expenses.find((e) => e.id === duplicate.expenseId) : undefined;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: existing ? "Edit expense" : "New expense" }} />

      <Card style={{ alignItems: "center" }}>
        {preview && (
          <Image source={{ uri: preview }} style={{ width: 120, height: 160, borderRadius: 8, marginBottom: 12 }} />
        )}
        {scanning ? (
          <View style={{ alignItems: "center", gap: 8, paddingVertical: 8 }}>
            <ActivityIndicator />
            <Text style={styles.muted}>Reading and translating the receipt…</Text>
          </View>
        ) : (
          <View style={{ flexDirection: "row", gap: 10, alignSelf: "stretch" }}>
            <Button title="📷 Scan receipt" style={{ flex: 1 }} onPress={() => runScan("camera")} />
            <Button title="🖼️ From photos" variant="secondary" style={{ flex: 1 }} onPress={() => runScan("library")} />
          </View>
        )}
        <Text style={[styles.muted, { marginTop: 8, fontSize: 12, textAlign: "center" }]}>
          Works with receipts in any language — items are translated to {settings.receiptLanguage}.
        </Text>
      </Card>

      {checkingDuplicate && (
        <Text style={[styles.muted, { textAlign: "center", marginBottom: 12 }]}>
          Checking it isn&apos;t already on the trip…
        </Text>
      )}
      {duplicate && duplicateOf && (
        <Card style={{ backgroundColor: colors.warningSoft, borderColor: colors.warning }}>
          <Text style={[styles.h2, { color: colors.warning }]}>
            {duplicate.confidence === "high" ? "Already on the trip" : "Already on the trip?"}
          </Text>
          <Text style={{ color: colors.text }}>
            {name(duplicateOf.paidBy)} paid &quot;{duplicateOf.description || "Expense"}&quot; ·{" "}
            {formatMoney(duplicateOf.amount, duplicateOf.currency)} · {duplicateOf.date}
          </Text>
          <Text style={[styles.muted, { marginTop: 4 }]}>{duplicate.reason}</Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
            <Button
              title="Open that one"
              variant="secondary"
              style={{ flex: 1 }}
              onPress={() =>
                router.replace({ pathname: "/trip/[id]/expense", params: { id: trip.id, expenseId: duplicateOf.id } })
              }
            />
            <Button title="It's different" variant="ghost" style={{ flex: 1 }} onPress={() => setDuplicate(null)} />
          </View>
        </Card>
      )}
      {!!queued?.error && <Banner>This photo couldn&apos;t be added automatically: {queued.error}</Banner>}
      {existing?.needsReview && (
        <Banner tone="info">Read from a photo taken offline. Check the amount and who&apos;s splitting, then save.</Banner>
      )}
      {!!receipt?.notes && <Banner>Check: {receipt.notes}</Banner>}

      <Field label="Description" placeholder="Dinner at Ichiran" value={description} onChangeText={setDescription} />

      <Label>Amount</Label>
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 6 }}>
        <Input
          style={{ flex: 1, fontSize: 22, fontWeight: "700" }}
          keyboardType="decimal-pad"
          placeholder="0"
          value={amountText}
          onChangeText={setAmountText}
        />
        <CurrencyPicker
          compact
          value={currency}
          onChange={changeCurrency}
        />
      </View>

      {currency !== trip.baseCurrency && (
        <Card style={{ marginTop: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: colors.text }}>1 {currency} =</Text>
            <Input
              style={{ flex: 1, paddingVertical: 6 }}
              keyboardType="decimal-pad"
              value={rateText}
              onChangeText={(t) => {
                ++rateRequest.current;
                setRateEdited(true);
                setRateCurrency(currency);
                setRateBase(trip.baseCurrency);
                setRateLoading(false);
                setRateText(t);
                setRateInfo("Custom rate");
              }}
            />
            <Text style={{ color: colors.text }}>{trip.baseCurrency}</Text>
            <Button title="↻" variant="ghost" loading={rateLoading} onPress={() => loadRate(currency, true)} />
          </View>
          {(rateInfo || rateWarning) && (
            <Text style={[styles.muted, { fontSize: 12, marginTop: 6 }]}>
              {rateWarning ? "Custom rate differs greatly from the live rate. Check it carefully." : rateInfo}
            </Text>
          )}
          {amount != null && rate != null && (
            <Text style={{ marginTop: 8, fontSize: 18, fontWeight: "700", color: colors.tint }}>
              ≈ {formatMoney(amount * rate, trip.baseCurrency)}
            </Text>
          )}
        </Card>
      )}

      {amount != null && rate != null && view.translated && currency !== view.home && (
        <Text style={[styles.muted, { marginTop: 2 }]}>
          ≈ {formatMoney(view.convert(amount * rate), view.home)} in your currency
        </Text>
      )}

      <View style={{ height: 8 }} />
      <Field label="Date (YYYY-MM-DD)" value={date} onChangeText={setDate} />

      <Label>Category</Label>
      <View style={[styles.chips, { marginBottom: 8 }]}>
        {CATEGORIES.map((c) => (
          <Chip key={c.key} label={`${c.icon} ${c.label}`} selected={category === c.key} onPress={() => setCategory(c.key)} />
        ))}
      </View>

      <Label>Paid by</Label>
      <View style={[styles.chips, { marginBottom: 8 }]}>
        {trip.members.map((m) => (
          <Chip key={m.id} label={m.name} selected={paidBy === m.id} onPress={() => setPaidBy(m.id)} />
        ))}
      </View>

      <Label>Split between</Label>
      <View style={[styles.chips, { marginBottom: 8 }]}>
        {trip.members.map((m) => (
          <Chip
            key={m.id}
            label={m.name}
            selected={memberIds.includes(m.id)}
            onPress={() => setMemberIds(toggle(memberIds, m.id))}
          />
        ))}
      </View>

      <Label>How to split</Label>
      <View style={[styles.chips, { marginBottom: 8 }]}>
        <Chip label="Equally" selected={splitType === "equal"} onPress={() => setSplitType("equal")} />
        <Chip label="By item" selected={splitType === "items"} onPress={() => setSplitType("items")} />
      </View>

      {(splitType === "items" || (receipt?.items.length ?? 0) > 0) && (
        <ReceiptItems
          receipt={receipt}
          currency={currency}
          byItem={splitType === "items"}
          members={trip.members}
          memberIds={memberIds}
          assignments={assignments}
          onToggle={toggleItemFor}
          onAddItem={handleAddItem}
          onEditItem={handleEditItem}
          onDeleteItem={handleDeleteItem}
          taxText={taxText}
          onTaxChange={setTaxText}
          tipText={tipText}
          onTipChange={setTipText}
          feesText={feesText}
          onFeesChange={setFeesText}
          amount={amount}
          onSetAmount={(amt) => setAmountText(amt > 0 ? String(amt) : "")}
        />
      )}

      {valid && memberIds.length > 0 && splitType === "items" && breakdowns.length > 0 && (
        <Card>
          <Text style={styles.h2}>Each person&apos;s share</Text>
          <Text style={[styles.muted, { fontSize: 12, marginBottom: 10 }]}>
            Detailed breakdown: claimed items, proportional tax &amp; tip, and final totals.
          </Text>
          {breakdowns.map((b) => (
            <View
              key={b.memberId}
              style={{
                marginBottom: 12,
                paddingBottom: 10,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: colors.border,
              }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                <Text style={{ fontWeight: "700", fontSize: 15, color: colors.text }}>{name(b.memberId)}</Text>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={{ fontWeight: "700", fontSize: 15, color: colors.tint }}>
                    {formatMoney(b.totalShare, currency)}
                  </Text>
                  {currency !== trip.baseCurrency && (
                    <Text style={[styles.muted, { fontSize: 12 }]}>
                      ≈ {formatMoney(b.totalShareBase, trip.baseCurrency)}
                    </Text>
                  )}
                </View>
              </View>

              {b.items.length > 0 ? (
                <View style={{ marginVertical: 4, gap: 2 }}>
                  {b.items.map((it, idx) => (
                    <View key={idx} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ flex: 1, color: colors.text, fontSize: 13 }}>
                        {it.quantity > 1 ? `${it.quantity}× ` : ""}
                        {it.translatedName}
                        {it.isUnassigned ? " (shared by all)" : it.sharedCount > 1 ? ` (shared 1/${it.sharedCount})` : ""}
                      </Text>
                      <Text style={{ color: colors.text, fontSize: 13, marginLeft: 8 }}>
                        {formatMoney(it.sharePrice, currency)}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={[styles.muted, { fontSize: 12, fontStyle: "italic", marginVertical: 4 }]}>
                  No items claimed
                </Text>
              )}

              <View style={{ marginTop: 4, gap: 2 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={[styles.muted, { fontSize: 12 }]}>Items subtotal</Text>
                  <Text style={[styles.muted, { fontSize: 12 }]}>{formatMoney(b.itemSubtotal, currency)}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={[styles.muted, { fontSize: 12 }]}>Tax &amp; tip share</Text>
                  <Text style={[styles.muted, { fontSize: 12 }]}>
                    {b.taxAndTipShare > 0 ? "+" : ""}{formatMoney(b.taxAndTipShare, currency)}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </Card>
      )}

      {valid && memberIds.length > 0 && (splitType === "equal" || breakdowns.length === 0) && (
        <Card>
          <Text style={styles.h2}>Each person&apos;s share</Text>
          {Object.entries(shares).map(([mid, share]) => (
            <View key={mid} style={{ flexDirection: "row", paddingVertical: 3 }}>
              <Text style={{ flex: 1, color: colors.text }}>{name(mid)}</Text>
              <Text style={{ color: colors.text }}>{formatMoney(share, currency)}</Text>
              {currency !== trip.baseCurrency && (
                <Text style={[styles.muted, { width: 100, textAlign: "right" }]}>
                  {formatMoney(share * rate!, trip.baseCurrency)}
                </Text>
              )}
            </View>
          ))}
        </Card>
      )}

      <Button
        title={existing ? "Save changes" : "Add expense"}
        onPress={handleSave}
        disabled={scanning || saving || rateLoading}
        loading={checkingDuplicate || saving}
      />
      {existing && <Button title="Delete expense" variant="danger" onPress={handleDelete} style={{ marginTop: 10 }} />}
    </ScrollView>
  );
}

function toggle(list: string[], memberId: string) {
  return list.includes(memberId) ? list.filter((x) => x !== memberId) : [...list, memberId];
}

function createExpenseRecord(params: {
  id: string;
  existing?: Expense;
  queued?: { id: string; capturedAt: number };
  description: string;
  category: Category;
  amount: number;
  currency: string;
  rateToBase: number;
  paidBy: string;
  date: string;
  split: Split;
  receipt?: ReceiptData;
}): Expense {
  const now = Date.now();
  return {
    id: params.id,
    description: params.description.trim(),
    category: params.category,
    amount: params.amount,
    currency: params.currency,
    rateToBase: params.rateToBase,
    paidBy: params.paidBy,
    date: params.date,
    split: params.split,
    receipt: params.receipt,
    ...(params.existing?.createdBy ? { createdBy: params.existing.createdBy } : {}),
    createdAt: params.existing?.createdAt ?? params.queued?.capturedAt ?? now,
    updatedAt: now,
  };
}

/**
 * The scanned line items, with who had each one when splitting by item.
 * Memoized: a long receipt is a lot of chips, and typing elsewhere in the
 * form shouldn't redraw them all.
 */
const ReceiptItems = memo(function ReceiptItems({
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
        <Text style={styles.h2}>
          Line items {receipt?.language && <Text style={[styles.muted, { fontSize: 13 }]}>· {receipt.language}</Text>}
        </Text>
        {items.length > 0 && (
          <Text style={{ fontWeight: "700", color: colors.text }}>
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
                  placeholder="Item name"
                  value={editTitle}
                  onChangeText={setEditTitle}
                  style={{ marginBottom: 6 }}
                />
                <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                  <Input
                    placeholder="Price"
                    value={editPrice}
                    onChangeText={setEditPrice}
                    keyboardType="decimal-pad"
                    style={{ flex: 2 }}
                  />
                  <Input
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

          return (
            <View
              key={i}
              style={{ paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: colors.border }}
            >
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "600", color: colors.text }}>
                    {item.quantity > 1 ? `${item.quantity}× ` : ""}
                    {item.translatedName || item.name}
                  </Text>
                  {item.translatedName && item.name && item.translatedName !== item.name && (
                    <Text style={[styles.muted, { fontSize: 12 }]}>{item.name}</Text>
                  )}
                </View>
                <Text style={{ color: colors.text, fontWeight: "600", marginRight: 10 }}>
                  {formatMoney(item.price, currency)}
                </Text>
                <Pressable onPress={() => startEdit(i)} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
                  <Text style={{ color: colors.tint, fontSize: 13, fontWeight: "600" }}>Edit</Text>
                </Pressable>
                <Pressable
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
                    {memberIds.map((mid) => (
                      <Chip
                        key={mid}
                        label={members.find((m) => m.id === mid)?.name ?? "?"}
                        selected={(assignments[i] ?? []).includes(mid)}
                        onPress={() => onToggle(i, mid)}
                      />
                    ))}
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
            placeholder="Item title (e.g. Pasta, Coffee)"
            value={addTitle}
            onChangeText={setAddTitle}
            style={{ marginBottom: 6 }}
          />
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
            <Input
              placeholder="Price"
              value={addPrice}
              onChangeText={setAddPrice}
              keyboardType="decimal-pad"
              style={{ flex: 2 }}
            />
            <Input
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
            <Text style={{ fontSize: 13, color: colors.text }}>
              Items: {formatMoney(itemsSubtotal, currency)}
              {tax > 0 ? ` + Tax: ${formatMoney(tax, currency)}` : ""}
              {tip > 0 ? ` + Tip: ${formatMoney(tip, currency)}` : ""}
              {fees > 0 ? ` + Fees: ${formatMoney(fees, currency)}` : ""}
              {" = "}
              <Text style={{ fontWeight: "700" }}>{formatMoney(calculatedTotal, currency)}</Text>
            </Text>
            {toMinor(amount ?? 0, currency) !== toMinor(calculatedTotal, currency) && calculatedTotal > 0 && (
              <Pressable
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
