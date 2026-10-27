import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import { Alert, FlatList, Image, Pressable, Text, View, type ListRenderItem } from "react-native";
import { InviteSheet } from "../../../components/InviteSheet";
import { PendingReceipts } from "../../../components/PendingReceipts";
import { Banner, Button, Card, Chip, CurrencyPicker, Input, useTheme } from "../../../components/ui";
import { useAuth } from "../../../context/AuthContext";
import type { HomeCurrencyView } from "../../../lib/homeCurrency";
import { baseAmount, Ledger, type SettlementPlan, type Transfer } from "../../../lib/ledger";
import { formatMoney } from "../../../lib/money";
import { pickReceiptImage } from "../../../lib/receiptImage";
import { categoryIcon, type Expense, type Trip } from "../../../lib/types";
import {
  useAppInForeground,
  useMe,
  useNetwork,
  useOnline,
  usePendingCount,
  useTrip,
  useTripActions,
} from "../../../state/TripsContext";
import { useHomeCurrency } from "../../../state/useHomeCurrency";

type Tab = "expenses" | "balances";

const NO_EXPENSES: Expense[] = [];

export default function TripScreen() {
  const { styles } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { refresh } = useTripActions();
  const trip = useTrip(id);
  const { connected } = useNetwork();
  const foreground = useAppInForeground();

  // Poll while the screen is open so everyone sees new expenses quickly. Not
  // in the background or without a connection, where it would only fail and
  // use battery; it picks up straight away when either comes back.
  useFocusEffect(
    useCallback(() => {
      if (!connected || !foreground) return;
      refresh(id);
      const t = setInterval(() => refresh(id), 5000);
      return () => clearInterval(t);
    }, [id, refresh, connected, foreground]),
  );

  if (!trip) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.muted}>Trip not found on this device.</Text>
      </View>
    );
  }
  return <TripView trip={trip} />;
}

function TripView({ trip }: { trip: Trip }) {
  const { colors, styles } = useTheme();
  const { addMember, removeTripLocally, setHomeCurrency, queueReceipt } = useTripActions();
  const { user, displayName: authName, avatarUrl: authAvatar } = useAuth();
  const me = useMe(trip.id);
  const pending = usePendingCount(trip.id);
  const online = useOnline();
  const network = useNetwork();
  const [tab, setTab] = useState<Tab>("expenses");
  const [adding, setAdding] = useState(false);
  const [newMember, setNewMember] = useState("");
  const [showDirect, setShowDirect] = useState(false);
  const [inviting, setInviting] = useState(false);

  // One pass over the expenses per trip version; the plan is computed lazily.
  const ledger = useMemo(() => new Ledger(trip), [trip]);
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
    try {
      const picked = await pickReceiptImage("camera");
      if (picked) await queueReceipt(trip.id, picked.uri);
    } catch (err) {
      Alert.alert("Couldn't save the receipt", err instanceof Error ? err.message : String(err));
    }
  };

  const confirmRemove = () =>
    Alert.alert("Remove from this device?", "The trip stays on the server for everyone else.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          removeTripLocally(trip.id);
          router.back();
        },
      },
    ]);

  const header = (
    <>
      {(pending > 0 || !online) && (
        <Banner>
          {online
            ? `Syncing ${pending} change${pending === 1 ? "" : "s"}…`
            : `Offline${pending ? ` — ${pending} change${pending === 1 ? "" : "s"} waiting to sync` : ""}. ` +
              "Receipts you snap are saved and read once you're back on Wi-Fi."}
        </Banner>
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
            <Text style={styles.h1}>{total.main}</Text>
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
          >
            {Math.abs(myBalance.net) < 0.01
              ? "You're all square"
              : myBalance.net > 0
                ? `You are owed ${withOriginal(view, myBalance.net)}`
                : `You owe ${withOriginal(view, -myBalance.net)}`}
          </Text>
        )}
        <Pressable onPress={() => setInviting(true)} style={{ marginTop: 12 }}>
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
                    <View key={b.memberId} style={{ flexDirection: "row", paddingVertical: 6 }}>
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
              <SettleUpCard
                plan={ledger.settlementPlan()}
                view={view}
                rateInfo={rateInfo}
                name={name}
                me={me}
                showDirect={showDirect}
                onToggleDirect={() => setShowDirect((v) => !v)}
              />
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
                        onPress={() => {}}
                      />
                    );
                  })}
                  <Chip label="+ Add" selected={false} onPress={() => setAdding(true)} />
                </View>
                {adding && (
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Input
                      autoFocus
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
          title={network.connected ? "📷 Scan receipt" : "📷 Snap for later"}
          style={{ flex: 1.4 }}
          onPress={() =>
            network.connected
              ? router.push({ pathname: "/trip/[id]/expense", params: { id: trip.id, scan: "camera" } })
              : snapForLater()
          }
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
  return (
    <Pressable
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

function SettleUpCard({
  plan,
  view,
  rateInfo,
  name,
  me,
  showDirect,
  onToggleDirect,
}: {
  plan: SettlementPlan;
  view: HomeCurrencyView;
  rateInfo: string | null;
  name: (memberId: string) => string;
  me?: string;
  showDirect: boolean;
  onToggleDirect: () => void;
}) {
  const { colors, styles } = useTheme();
  const row = (t: Transfer, i: number, dim = false) => (
    <Text key={i} style={{ paddingVertical: 6, color: dim ? colors.muted : colors.text }}>
      <Text style={{ fontWeight: dim ? "400" : "600" }}>{t.from === me ? "You" : name(t.from)}</Text>
      {t.from === me ? " pay " : " pays "}
      <Text style={{ fontWeight: dim ? "400" : "600" }}>{t.to === me ? "you" : name(t.to)}</Text>{" "}
      {withOriginal(view, t.amount)}
    </Text>
  );

  return (
    <Card>
      <Text style={styles.h2}>Settle up</Text>
      {plan.transfers.length === 0 ? (
        <Text style={styles.muted}>Everyone is square. 🎉</Text>
      ) : (
        <>
          {plan.transfers.map((t, i) => row(t, i))}
          <Text style={{ marginTop: 6, fontWeight: "600", color: colors.positive }}>
            {plan.saved > 0
              ? `Simplified: ${plan.transfers.length} payment${plan.transfers.length === 1 ? "" : "s"} instead of ${plan.direct.length}`
              : `${plan.transfers.length} payment${plan.transfers.length === 1 ? "" : "s"} — already the fewest possible`}
          </Text>
        </>
      )}
      {plan.saved > 0 && (
        <>
          <Pressable onPress={onToggleDirect} style={{ marginTop: 10 }}>
            <Text style={styles.link}>
              {showDirect ? "Hide" : "Show"} who owes whom without simplifying
            </Text>
          </Pressable>
          {showDirect && (
            <View style={{ marginTop: 6 }}>
              {plan.direct.map((t, i) => row(t, i, true))}
              <Text style={[styles.muted, { fontSize: 12, marginTop: 4 }]}>
                Debts that pass through someone (A owes B, B owes C) are combined so money
                goes straight to the person who is owed.
              </Text>
            </View>
          )}
        </>
      )}
      <Text style={[styles.muted, { marginTop: 8, fontSize: 12 }]}>
        Amounts use the exchange rate locked in on each expense.
        {view.translated &&
          ` The group settles up in ${view.tripCurrency}; ${view.home} figures use today's rate` +
            (rateInfo ? ` (${rateInfo}).` : ".")}
      </Text>
    </Card>
  );
}
