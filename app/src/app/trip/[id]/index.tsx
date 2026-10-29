import { Alert } from "../../../lib/alert";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Image, Pressable, Text, View, type ListRenderItem } from "react-native";
import { ExpenseConflicts } from "../../../components/ExpenseConflicts";
import { InviteSheet } from "../../../components/InviteSheet";
import { PendingReceipts } from "../../../components/PendingReceipts";
import { SettleUpCard } from "../../../components/SettleUpCard";
import { TripExportCard } from "../../../components/TripExportCard";
import { TripInsightsCard } from "../../../components/TripInsightsCard";
import { Banner, Button, Card, Chip, CurrencyPicker, Input, useTheme } from "../../../components/ui";
import { useAuth } from "../../../context/AuthContext";
import type { HomeCurrencyView } from "../../../lib/homeCurrency";
import { baseAmount, inspectLedger, type Ledger, type Transfer } from "../../../lib/ledger";
import { formatMoney } from "../../../lib/money";
import { parsePaymentRequest } from "../../../lib/paymentLink";
import { pickReceiptImage } from "../../../lib/receiptImage";
import { categoryIcon, type Expense, type Trip } from "../../../lib/types";
import {
  useAppInForeground,
  useMe,
  useNetwork,
  useOnline,
  useStorageError,
  useSyncError,
  usePendingCount,
  useConflicts,
  useFailedCount,
  useRecoveredCount,
  useTrip,
  useTripActions,
} from "../../../state/TripsContext";
import { useHomeCurrency } from "../../../state/useHomeCurrency";

type Tab = "expenses" | "balances";

const NO_EXPENSES: Expense[] = [];

export default function TripScreen() {
  const { styles } = useTheme();
  const params = useLocalSearchParams<{
    id: string;
    settleFrom?: string;
    settleTo?: string;
    settleAmount?: string;
  }>();
  const id = params.id;
  const { refresh } = useTripActions();
  const trip = useTrip(id);
  const { connected } = useNetwork();
  const foreground = useAppInForeground();
  const paymentRequest = parsePaymentRequest(params);

  // Poll while the screen is open so everyone sees new expenses quickly. Not
  // in the background or without a connection, where it would only fail and
  // use battery; it picks up straight away when either comes back.
  useFocusEffect(
    useCallback(() => {
      if (!connected || !foreground || !trip?.syncEnabled) return;
      refresh(id);
      const t = setInterval(() => refresh(id), 5000);
      return () => clearInterval(t);
    }, [id, refresh, connected, foreground, trip?.syncEnabled]),
  );

  if (!trip) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.muted}>Trip not found on this device.</Text>
      </View>
    );
  }
  return <TripView trip={trip} paymentRequest={paymentRequest} />;
}

function TripView({ trip, paymentRequest }: { trip: Trip; paymentRequest?: Transfer }) {
  const { styles } = useTheme();
  const { removeDamagedExpense, removeDamagedSettlement, saveChanges } = useTripActions();
  const result = useMemo(() => inspectLedger(trip), [trip]);
  if (result.ledger) return <TripContent trip={trip} ledger={result.ledger} paymentRequest={paymentRequest} />;
  return <View style={[styles.screen, styles.content]}>
    <Text style={styles.h2}>A record needs correction</Text>
    <Text style={styles.muted}>Totals and settlements are unavailable until damaged records are removed and entered again. Other records are still kept.</Text>
    {result.invalid.map((expense) => <Card key={`${expense.kind ?? "expense"}-${expense.index}`}>
      <Text style={styles.h2}>{expense.description || (expense.kind === "settlement" ? "Damaged payment" : "Damaged expense")}</Text>
      <Text style={styles.muted}>Record: {expense.id ?? `entry ${expense.index + 1}`}</Text>
      <Button title={expense.kind === "settlement" ? "Remove damaged payment" : expense.id && trip.syncEnabled ? "Repair shared expense" : "Remove damaged expense"} variant="danger" onPress={() => Alert.alert(expense.kind === "settlement" ? "Remove damaged payment?" : "Repair damaged expense?",
        expense.kind === "settlement"
          ? "The damaged payment will be removed from the trip ledger. Keep any details you need before confirming."
          : expense.id && trip.syncEnabled
          ? "An intact server copy will be restored. If the server copy is also damaged, the expense will be removed for everyone. Unsent edits to this expense will be discarded. Keep any details you need before confirming."
          : "Keep any details you need, then enter the expense again.", [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: async () => {
          try {
            if (expense.kind === "settlement") {
              removeDamagedSettlement(trip.id, expense.index, expense.value);
            } else {
              await removeDamagedExpense(trip.id, expense.index, expense.value);
            }
            await saveChanges();
          }
          catch (error) { Alert.alert("Couldn't save the removal", error instanceof Error ? error.message : "Try again."); }
        } },
      ])} />
    </Card>)}
  </View>;
}

function TripContent({ trip, ledger, paymentRequest }: { trip: Trip; ledger: Ledger; paymentRequest?: Transfer }) {
  const { colors, styles } = useTheme();
  const { addMember, removeTripLocally, claimTripMember, setHomeCurrency, queueReceipt, retryFailed, discardFailed, resolveConflict, saveSettlement, deleteSettlement, patchTrip } = useTripActions();
  const { user, session, displayName: authName, avatarUrl: authAvatar } = useAuth();
  const me = useMe(trip.id);
  const pending = usePendingCount(trip.id);
  const failed = useFailedCount(trip.id);
  const conflicts = useConflicts(trip.id);
  const recovered = useRecoveredCount(trip.id);
  const online = useOnline();
  const syncError = useSyncError(trip.id);
  const storageError = useStorageError();
  const network = useNetwork();
  const syncOffline = !online && Boolean(trip.syncEnabled);
  const [tab, setTab] = useState<Tab>(paymentRequest ? "balances" : "expenses");
  const [adding, setAdding] = useState(false);
  const [newMember, setNewMember] = useState("");
  const [showDirect, setShowDirect] = useState(false);
  const [inviting, setInviting] = useState(false);

  // One pass over the expenses per trip version; the plan is computed lazily.
  // Everything is accounted in the trip currency and shown in this person's own.
  const { view, home, rateInfo } = useHomeCurrency(trip);

  const names = useMemo(() => new Map(trip.members.map((m) => [m.id, m.name])), [trip.members]);
  const name = useCallback((memberId: string) => names.get(memberId) ?? "Someone", [names]);
  const myBalance = me ? ledger.balanceOf(me) : undefined;
  const total = view.format(ledger.totalSpent);
  // Sorted once per change to the trip, not on every render (typing a name, switching tabs).
  const expenses = useMemo(
    () =>
      [...trip.expenses].sort((a, b) =>
        b.date === a.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date),
      ),
    [trip.expenses],
  );
  const lastIndex = expenses.length - 1;
  const renderExpense = useCallback<ListRenderItem<Expense>>(
    ({ item, index }) => (
      <ExpenseRow
        expense={item}
        tripId={trip.id}
        payer={name(item.paidBy)}
        view={view}
        first={index === 0}
        last={index === lastIndex}
      />
    ),
    [trip.id, name, view, lastIndex],
  );

  // No connection: keep the photo and read it later instead of opening the live scanner.
  const snapForLater = async () => {
    if (!session) {
      Alert.alert("Sign in required", "Sign in from Settings before scanning receipts.");
      return;
    }
    try {
      const picked = await pickReceiptImage("camera");
      if (picked) await queueReceipt(trip.id, picked.uri);
    } catch (err) {
      Alert.alert("Couldn't save the receipt", err instanceof Error ? err.message : String(err));
    }
  };

  const confirmRemove = () =>
    Alert.alert(
      "Remove from this device?",
      !trip.syncEnabled
        ? "This guest trip exists only on this device. Removing it permanently deletes its local data."
        : pending > 0 || failed > 0
          ? "This removes the trip and any changes that have not reached the server yet."
          : "The synced trip stays on the server for everyone else.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            removeTripLocally(trip.id);
            router.back();
          },
        },
      ],
    );

  const header = (
    <>
      <ExpenseConflicts trip={trip} conflicts={conflicts} onResolve={(c, choice) => resolveConflict(c.tripId, c.expenseId, choice)} />
      {(pending > 0 || failed > 0 || syncOffline || !!syncError || storageError) && (
        <Banner>
          {storageError
            ? "Local storage is unavailable; changes will not survive until it recovers."
            : syncError
            ? syncError
            : recovered
              ? "Recovered offline changes need review. Retry to send your changes, or discard to use the server copy."
            : failed
              ? `${failed} change${failed === 1 ? " was" : "s were"} rejected by the server. Review ${failed === 1 ? "it" : "them"} while online.`
              : online
                ? `Syncing ${pending} change${pending === 1 ? "" : "s"}…`
                : `Offline${pending ? ` — ${pending} change${pending === 1 ? "" : "s"} waiting to sync` : ""}. ` +
                  "Receipts you snap are saved and read once you're back on Wi-Fi."}
        </Banner>
      )}
      {failed > 0 && (
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
          <Button title="Retry changes" variant="secondary" onPress={() => retryFailed(trip.id)} style={{ flex: 1 }} />
          <Button title="Discard" variant="ghost" onPress={() => void discardFailed(trip.id).catch((error) => Alert.alert("Couldn’t discard changes", error instanceof Error ? error.message : "Try again while online."))} style={{ flex: 0.5 }} />
        </View>
      )}

      <Card>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
            paddingBottom: 10,
            borderBottomWidth: styles.card.borderWidth,
            borderBottomColor: colors.border,
          }}
        >
          {authAvatar ? (
            <Image source={{ uri: authAvatar }} style={{ width: 24, height: 24, borderRadius: 12 }} />
          ) : (
            <Text style={{ fontSize: 16 }}>{user ? "👤" : "⚪"}</Text>
          )}
          <Text style={[styles.muted, { fontSize: 13, flex: 1 }]} numberOfLines={1}>
            {user ? (
              <>
                Signed in as <Text style={{ color: colors.text, fontWeight: "600" }}>{authName}</Text> ({user.email})
              </>
            ) : (
              "Guest mode · Local device user"
            )}
          </Text>
        </View>

        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.muted}>Trip total</Text>
            <Text
              style={styles.h1}
              accessibilityRole="header"
              accessibilityLabel={`Trip total ${total.main}${total.original ? `, ${total.original}` : ""}`}
            >
              {total.main}
            </Text>
            {total.original && (
              <Text style={[styles.muted, { fontSize: 13 }]}>
                {total.original} · 1 {trip.baseCurrency} = {Number(view.rate!.toPrecision(4))} {home}
              </Text>
            )}
            {!view.translated && home !== trip.baseCurrency && rateInfo && (
              <Text style={[styles.muted, { fontSize: 13 }]}>
                {rateInfo}, so amounts are in {trip.baseCurrency}.
              </Text>
            )}
          </View>
          <View style={{ alignItems: "center" }}>
            <CurrencyPicker compact value={home} onChange={setHomeCurrency} />
            <Text style={[styles.muted, { fontSize: 11, marginTop: 4 }]}>your currency</Text>
          </View>
        </View>
        {myBalance && (
          <Text
            style={{
              marginTop: 6,
              fontWeight: "600",
              color: myBalance.net >= 0 ? colors.positive : colors.negative,
            }}
            accessibilityLiveRegion="polite"
          >
            {Math.abs(myBalance.net) < 0.01
              ? "You're all square"
              : myBalance.net > 0
                ? `You are owed ${withOriginal(view, myBalance.net)}`
                : `You owe ${withOriginal(view, -myBalance.net)}`}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={trip.code ? `Trip code ${trip.code}. Invite people with a QR code` : "Invite people. The code appears once synced"}
          onPress={() => setInviting(true)}
          style={{ marginTop: 12 }}
        >
          <Text style={styles.link}>
            {trip.code ? `Trip code: ${trip.code} · Invite with QR code` : "Invite people (code appears once synced)"}
          </Text>
        </Pressable>
      </Card>

      <PendingReceipts tripId={trip.id} />

      <View style={[styles.chips, { marginBottom: 4 }]}>
        <Chip label="Expenses" selected={tab === "expenses"} onPress={() => setTab("expenses")} />
        <Chip label="Balances" selected={tab === "balances"} onPress={() => setTab("balances")} />
      </View>
    </>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: trip.name }} />
      {/* A list, so a long trip only renders the expenses on screen. */}
      <FlatList
        contentContainerStyle={[styles.content, { paddingBottom: 140 }]}
        data={tab === "expenses" ? expenses : NO_EXPENSES}
        keyExtractor={(e) => e.id}
        renderItem={renderExpense}
        ListHeaderComponent={header}
        ListEmptyComponent={
          tab === "expenses" ? (
            <Card>
              <Text style={styles.h2}>No expenses yet</Text>
              <Text style={styles.muted}>Scan a receipt — any language works — or add one by hand.</Text>
            </Card>
          ) : undefined
        }
        ListFooterComponent={
          tab === "balances" ? (
            <>
              <Card>
                <Text style={styles.h2}>Who&apos;s up, who&apos;s down</Text>
                {ledger.balances().map((b) => {
                  const shown = view.format(b.net);
                  return (
                    <View
                      key={b.memberId}
                      style={{ flexDirection: "row", paddingVertical: 6 }}
                      accessibilityLabel={
                        `${name(b.memberId)}${b.memberId === me ? ", you" : ""}: ` +
                        (Math.abs(b.net) < 0.005
                          ? "settled up"
                          : b.net > 0
                            ? `is owed ${shown.main}${shown.original ? `, ${shown.original}` : ""}`
                            : `owes ${shown.main}${shown.original ? `, ${shown.original}` : ""}`)
                      }
                    >
                      <Text style={{ flex: 1, color: colors.text }}>
                        {name(b.memberId)}
                        {b.memberId === me ? " (you)" : ""}
                      </Text>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text
                          style={{
                            fontWeight: "600",
                            color: b.net > 0.005 ? colors.positive : b.net < -0.005 ? colors.negative : colors.muted,
                          }}
                        >
                          {b.net > 0 ? "+" : ""}
                          {shown.main}
                        </Text>
                        {shown.original && <Text style={[styles.muted, { fontSize: 12 }]}>{shown.original}</Text>}
                      </View>
                    </View>
                  );
                })}
              </Card>
              <TripInsightsCard
                trip={trip}
                editable={trip.ownerId ? trip.ownerId === user?.id : !trip.syncEnabled}
                onSaveBudget={(budget) => {
                  try {
                    patchTrip(trip.id, { budget });
                  } catch (error) {
                    Alert.alert("Couldn't save the budget", error instanceof Error ? error.message : "Try again.");
                  }
                }}
              />
              <SettleUpCard
                trip={trip}
                plan={ledger.settlementPlan()}
                view={view}
                rateInfo={rateInfo}
                name={name}
                me={me}
                userId={user?.id}
                showDirect={showDirect}
                onToggleDirect={() => setShowDirect((v) => !v)}
                onRecord={(settlement) => saveSettlement(trip.id, settlement)}
                onDelete={(settlementId) => deleteSettlement(trip.id, settlementId)}
                initialTransfer={paymentRequest}
              />
              <TripExportCard trip={trip} ledger={ledger} />
              <Card>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <Text style={styles.h2}>People</Text>
                  {user && trip.ownerId === user.id && (
                    <Text style={[styles.muted, { fontSize: 12, color: colors.tint, fontWeight: "600" }]}>
                      👑 You are the trip owner
                    </Text>
                  )}
                </View>
                <View style={styles.chips}>
                  {trip.members.map((m, index) => {
                    const isOwner =
                      Boolean(trip.ownerId && (m.userId === trip.ownerId || m.id === trip.ownerId)) ||
                      (!trip.ownerId && index === 0);
                    const ownerBadge = isOwner ? " 👑 Owner" : "";
                    const currencySuffix = m.homeCurrency ? ` · ${m.homeCurrency}` : "";
                    return (
                      <Chip
                        key={m.id}
                        label={`${m.name}${ownerBadge}${currencySuffix}`}
                        selected={m.id === me}
                        accessibilityLabel={
                          `${m.name}${isOwner ? ", trip owner" : ""}${m.homeCurrency ? `, home currency ${m.homeCurrency}` : ""}`
                        }
                        accessibilityHint={m.id === me ? "This is you" : "Select this person as you"}
                        onPress={() => void claimTripMember(trip.id, m.id, user?.id ? {
                          id: user.id, email: user.email, avatarUrl: authAvatar,
                        } : undefined).catch((error) => Alert.alert("Couldn’t select member", error instanceof Error ? error.message : "Try again while online."))}
                      />
                    );
                  })}
                  <Chip label="+ Add" selected={false} accessibilityLabel="Add a person to this trip" onPress={() => setAdding(true)} />
                </View>
                {adding && (
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Input
                      autoFocus
                      accessibilityLabel="New member name"
                      placeholder="Name"
                      value={newMember}
                      onChangeText={setNewMember}
                      style={{ flex: 1 }}
                    />
                    <Button
                      title="Add"
                      disabled={!newMember.trim()}
                      onPress={() => {
                        addMember(trip.id, newMember);
                        setNewMember("");
                        setAdding(false);
                      }}
                    />
                  </View>
                )}
                <Button
                  title="Invite with QR code"
                  variant="secondary"
                  onPress={() => setInviting(true)}
                  style={{ marginTop: 4 }}
                />
              </Card>
              <Button title="Remove trip from this device" variant="ghost" onPress={confirmRemove} />
            </>
          ) : undefined
        }
      />

      <View
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          bottom: 28,
          flexDirection: "row",
          gap: 10,
        }}
      >
        <Button
          title={!session ? "🔒 Sign in to scan" : network.connected ? "📷 Scan receipt" : "📷 Snap for later"}
          style={{ flex: 1.4 }}
          onPress={() => {
            if (!session) {
              Alert.alert("Sign in required", "Sign in from Settings before scanning receipts.");
            } else if (network.connected) {
              router.push({ pathname: "/trip/[id]/expense", params: { id: trip.id, scan: "camera" } });
            } else {
              void snapForLater();
            }
          }}
        />
        <Button
          title="+ Manual"
          variant="secondary"
          style={{ flex: 1 }}
          onPress={() => router.push({ pathname: "/trip/[id]/expense", params: { id: trip.id } })}
        />
      </View>

      <InviteSheet trip={trip} visible={inviting} onClose={() => setInviting(false)} />
    </View>
  );
}

/**
 * One expense in the list, drawn as part of one rounded card. Memoized, so
 * when the trip changes only the rows whose expense changed re-render.
 */
const ExpenseRow = memo(function ExpenseRow({
  expense: e,
  tripId,
  payer,
  view,
  first,
  last,
}: {
  expense: Expense;
  tripId: string;
  payer: string;
  view: HomeCurrencyView;
  first: boolean;
  last: boolean;
}) {
  const { colors, styles } = useTheme();
  const amountText = formatMoney(e.amount, e.currency);
  const convertedText = e.currency !== view.currency ? formatMoney(view.convert(baseAmount(e)), view.currency) : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        `${e.description || "Expense"}, ${amountText}${convertedText ? `, about ${convertedText}` : ""}, ` +
        `paid by ${payer} on ${e.date}${e.receipt ? `, receipt in ${e.receipt.language}` : ""}`
      }
      accessibilityHint="Opens this expense for editing"
      style={[
        styles.row,
        {
          backgroundColor: colors.card,
          borderLeftWidth: styles.card.borderWidth,
          borderRightWidth: styles.card.borderWidth,
          borderColor: colors.border,
        },
        first && { borderTopWidth: styles.card.borderWidth, borderTopLeftRadius: 14, borderTopRightRadius: 14 },
        last && { borderBottomLeftRadius: 14, borderBottomRightRadius: 14, marginBottom: 12 },
      ]}
      onPress={() => router.push({ pathname: "/trip/[id]/expense", params: { id: tripId, expenseId: e.id } })}
    >
      <Text style={{ fontSize: 22 }}>{categoryIcon(e.category)}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: "600", color: colors.text }} numberOfLines={1}>
          {e.description || "Expense"}
        </Text>
        <Text style={[styles.muted, { fontSize: 13 }]}>
          {payer} paid · {e.date}
          {e.receipt ? ` · 🧾 ${e.receipt.language}` : ""}
          {e.rateSource ? ` · rate: ${e.rateSource}` : ""}
        </Text>
        {e.needsReview && (
          <Text style={{ color: colors.warning, fontSize: 13 }}>Read from a photo · tap to check the split</Text>
        )}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={{ fontWeight: "700", color: colors.text }}>{formatMoney(e.amount, e.currency)}</Text>
        {e.currency !== view.currency && (
          <Text style={[styles.muted, { fontSize: 12 }]}>≈ {formatMoney(view.convert(baseAmount(e)), view.currency)}</Text>
        )}
      </View>
    </Pressable>
  );
});

/** "$45.20 (¥6,800)": the viewer's currency, with what the group settles in. */
function withOriginal(view: HomeCurrencyView, tripAmount: number) {
  const { main, original } = view.format(tripAmount);
  return original ? `${main} (${original})` : main;
}
