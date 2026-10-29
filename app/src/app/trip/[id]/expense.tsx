import { Alert } from "../../../lib/alert";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  ScrollView,
  Text,
  View,
} from "react-native";
import { describeExpense } from "../../../components/ExpenseConflicts";
import { RateField } from "../../../components/expense/RateField";
import { ReceiptItems } from "../../../components/expense/ReceiptItems";
import { ShareWeights } from "../../../components/expense/ShareWeights";
import { ItemizedShareBreakdown, ShareSummary } from "../../../components/expense/SplitPreview";
import { Banner, Button, Card, Chip, CurrencyPicker, Field, Input, Label, useTheme } from "../../../components/ui";
import { useAuth } from "../../../context/AuthContext";
import { api, ApiError } from "../../../lib/api";
import { findDuplicate, type DuplicateMatch } from "../../../lib/duplicates";
import { createExpenseRecord } from "../../../lib/expenseDraft";
import { formatMoney, parseAmount, parseRate } from "../../../lib/money";
import { describeAge, rateService } from "../../../lib/rates";
import { pickReceiptImage, type ImageSource } from "../../../lib/receiptImage";
import { isCurrencyCode, isISODate, normalizeReceiptQuantities, receiptFromScan, receiptItemsNeedRepair } from "../../../lib/receiptScan";
import { computeItemizedBreakdown, computeShares } from "../../../lib/split";
import {
  CATEGORIES,
  newId,
  todayISO,
  type Category,
  type Expense,
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
  const { deleteExpense, removeDamagedExpense, saveChanges } = useTripActions();
  const [repairing, setRepairing] = useState(false);
  const params = useLocalSearchParams<Params>();
  const trip = useTrip(params.id);
  if (!trip) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.muted}>Trip not found on this device.</Text>
      </View>
    );
  }
  const existing = trip.expenses.find((expense) => expense.id === params.expenseId);
  if (existing?.receipt && receiptItemsNeedRepair(existing.receipt)) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Stack.Screen options={{ title: "Receipt needs repair" }} />
        <Banner>This receipt&apos;s saved item details can&apos;t be edited safely. The original details have been kept.</Banner>
        {trip.syncEnabled && <Button title="Restore server copy" loading={repairing} onPress={() =>
          Alert.alert("Restore this expense?", "An intact server copy will replace this expense. Unsent edits to this expense will be discarded. If no intact copy is available, your saved details will be kept.", [
            { text: "Cancel", style: "cancel" },
            { text: "Restore", onPress: async () => {
              setRepairing(true);
              try {
                await removeDamagedExpense(trip.id, trip.expenses.indexOf(existing), existing, true);
                await saveChanges();
              } catch (error) {
                Alert.alert("Couldn't restore the receipt", error instanceof Error ? error.message : "Try again while online.");
              } finally { setRepairing(false); }
            } },
          ])
        } />}
        <Text style={styles.muted}>To replace the receipt, delete this expense and add it again from the original receipt.</Text>
        <Button title="Delete expense" variant="danger" onPress={() =>
          Alert.alert("Delete this expense?", "This removes the expense and its saved receipt details for everyone on the trip. You can add it again from the original receipt.", [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: () => {
              deleteExpense(trip.id, existing.id);
              router.back();
            } },
          ])
        } />
        <Button title="Back to trip" onPress={() => router.back()} />
      </View>
    );
  }
  return <ExpenseEditor trip={trip} {...params} />;
}

function ExpenseEditor({ trip, expenseId, scan, queuedId }: Params & { trip: Trip }) {
  const { colors, styles } = useTheme();
  const { session } = useAuth();
  const { saveExpense, saveChanges, deleteExpense, queueReceipt, discardReceipt, refresh, getTrip, staleExpense } = useTripActions();
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
  const [rateSource, setRateSource] = useState<string | undefined>(existing?.rateSource);
  const [rateFetchedAt, setRateFetchedAt] = useState<number | undefined>(existing?.rateFetchedAt);
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
  const [weights, setWeights] = useState<Record<string, number>>(
    existing?.split?.type === "shares" && existing.split.weights ? existing.split.weights : {},
  );
  const [assignments, setAssignments] = useState<Record<number, string[]>>(
    existing?.split?.type === "items" && existing.split.assignments ? existing.split.assignments : {},
  );
  const [receipt, setReceipt] = useState<ReceiptData | undefined>(() => existing?.receipt ? normalizeReceiptQuantities(existing.receipt) : undefined);
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
      setRateSource("Base currency");
      setRateFetchedAt(undefined);
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
      setRateSource(table?.source ?? "Live rate");
      setRateFetchedAt(table?.fetchedAt);
      setRateEdited(false);
    } catch {
      if (request === rateRequest.current) {
        setRateInfo("Couldn't fetch a live rate — enter one manually.");
        setRateSource(undefined);
        setRateFetchedAt(undefined);
      }
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
    setRateSource(undefined);
    setRateFetchedAt(undefined);
    setRateLoading(code !== trip.baseCurrency);
    setCurrency(code);
  };

  const runScan = async (source: ImageSource) => {
    if (!session) {
      Alert.alert("Sign in required", "Sign in from Settings before scanning receipts.");
      return;
    }
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
        : splitType === "shares"
          ? {
              type: "shares",
              memberIds,
              weights: Object.fromEntries(memberIds.map((memberId) => [memberId, weights[memberId] ?? 1])),
            }
          : { type: "equal", memberIds },
    [splitType, receipt, memberIds, assignments, weights],
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

  const handleCommit = async (overwriteConfirmed = false) => {
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
        rateSource,
        rateFetchedAt,
      });
      // Someone else saved this expense while the form was open: say so rather than overwrite them.
      const newer = staleExpense(trip.id, expense);
      if (newer && !overwriteConfirmed) {
        Alert.alert(
          "This expense changed",
          `Someone else updated it while you were editing:\n\n${describeExpense(newer, trip)}\n\nSaving now replaces their version with yours.`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Replace theirs", style: "destructive", onPress: () => void handleCommit(true) },
          ],
        );
        return;
      }
      saveExpense(trip.id, newer ? { ...expense, revision: newer.revision } : expense);
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
          { text: "Add anyway", style: "destructive", onPress: () => void handleCommit() },
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
          <Image
            source={{ uri: preview }}
            accessible
            accessibilityLabel="Receipt photo preview"
            style={{ width: 120, height: 160, borderRadius: 8, marginBottom: 12 }}
          />
        )}
        {scanning ? (
          <View style={{ alignItems: "center", gap: 8, paddingVertical: 8 }} accessibilityLiveRegion="polite">
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
          accessibilityLabel={`Amount in ${currency}`}
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
        <RateField
          currency={currency}
          baseCurrency={trip.baseCurrency}
          rateText={rateText}
          rateLoading={rateLoading}
          rateInfo={rateInfo}
          rateWarning={rateWarning}
          amount={amount}
          rate={rate}
          onRateChange={(t) => {
            ++rateRequest.current;
            setRateEdited(true);
            setRateCurrency(currency);
            setRateBase(trip.baseCurrency);
            setRateLoading(false);
            setRateText(t);
            setRateInfo("Custom rate");
            setRateSource("Custom rate");
            setRateFetchedAt(Date.now());
          }}
          onRefresh={() => loadRate(currency, true)}
        />
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
          <Chip key={c.key} label={`${c.icon} ${c.label}`} selected={category === c.key} accessibilityLabel={`Category ${c.label}`} onPress={() => setCategory(c.key)} />
        ))}
      </View>

      <Label>Paid by</Label>
      <View style={[styles.chips, { marginBottom: 8 }]}>
        {trip.members.map((m) => (
          <Chip
            key={m.id}
            label={m.name}
            selected={paidBy === m.id}
            accessibilityLabel={`Paid by ${m.name}`}
            onPress={() => setPaidBy(m.id)}
          />
        ))}
      </View>

      <Label>Split between</Label>
      <View style={[styles.chips, { marginBottom: 8 }]}>
        {trip.members.map((m) => (
          <Chip
            key={m.id}
            label={m.name}
            selected={memberIds.includes(m.id)}
            accessibilityLabel={`Split with ${m.name}`}
            onPress={() => {
              setMemberIds(toggle(memberIds, m.id));
              setWeights((current) => ({ ...current, [m.id]: current[m.id] ?? 1 }));
            }}
          />
        ))}
      </View>

      <Label>How to split</Label>
      <View style={[styles.chips, { marginBottom: 8 }]}>
        <Chip label="Equally" selected={splitType === "equal"} accessibilityLabel="Split equally" onPress={() => setSplitType("equal")} />
        <Chip label="By item" selected={splitType === "items"} accessibilityLabel="Split by item" onPress={() => setSplitType("items")} />
        <Chip label="By shares" selected={splitType === "shares"} accessibilityLabel="Split by shares" onPress={() => setSplitType("shares")} />
      </View>

      {splitType === "shares" && (
        <ShareWeights
          members={trip.members}
          memberIds={memberIds}
          weights={weights}
          onChange={(memberId, weight) => setWeights((current) => ({ ...current, [memberId]: weight }))}
        />
      )}

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
        <ItemizedShareBreakdown
          breakdowns={breakdowns}
          members={trip.members}
          currency={currency}
          baseCurrency={trip.baseCurrency}
        />
      )}

      {valid && memberIds.length > 0 && (splitType === "equal" || breakdowns.length === 0) && (
        <ShareSummary
          shares={shares}
          members={trip.members}
          currency={currency}
          baseCurrency={trip.baseCurrency}
          rate={rate}
        />
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
