import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Share, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { SafeAreaView } from "react-native-safe-area-context";
import type { HomeCurrencyView } from "../lib/homeCurrency";
import type { SettlementPlan, Transfer } from "../lib/ledger";
import { formatMoney, parseAmount, toMinor } from "../lib/money";
import { paymentRequestParams } from "../lib/paymentLink";
import { isISODate } from "../lib/receiptScan";
import { newId, todayISO, type Settlement, type Trip } from "../lib/types";
import { Alert } from "../lib/alert";
import { QrCode } from "./QrCode";
import { Button, Card, Chip, Input, Label, useTheme } from "./ui";

const METHODS = ["Cash", "Bank transfer", "Venmo", "PayNow", "PayPal", "Other"];

export function SettleUpCard({
  trip,
  plan,
  view,
  rateInfo,
  name,
  me,
  userId,
  showDirect,
  onToggleDirect,
  onRecord,
  onDelete,
  initialTransfer,
}: {
  trip: Trip;
  plan: SettlementPlan;
  view: HomeCurrencyView;
  rateInfo: string | null;
  name: (memberId: string) => string;
  me?: string;
  /** Signed-in account, used to decide who may undo a payment. */
  userId?: string;
  showDirect: boolean;
  onToggleDirect: () => void;
  onRecord: (settlement: Settlement) => void;
  onDelete: (settlementId: string) => void;
  /** A payment from a deep link or QR code; opens the recording form. */
  initialTransfer?: Transfer;
}) {
  const { colors, styles } = useTheme();
  const [draft, setDraft] = useState<{ from: string; to: string; amount: string } | null>(null);
  const [requesting, setRequesting] = useState<Transfer | null>(null);
  const [from, setFrom] = useState(me ?? trip.members[0]?.id ?? "");
  const [to, setTo] = useState(trip.members.find((member) => member.id !== (me ?? trip.members[0]?.id))?.id ?? "");
  const [amountText, setAmountText] = useState("");
  const [date, setDate] = useState(todayISO());
  const [method, setMethod] = useState("Cash");
  const [note, setNote] = useState("");
  const openedRequest = useRef<string | null>(null);

  const members = trip.members;
  const history = [...(trip.settlements ?? [])].sort((a, b) =>
    b.date === a.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date),
  );

  const startRecording = (transfer?: Transfer) => {
    const nextFrom = transfer?.from ?? me ?? members[0]?.id ?? "";
    const nextTo = transfer?.to ?? members.find((member) => member.id !== nextFrom)?.id ?? "";
    setFrom(nextFrom);
    setTo(nextTo);
    setAmountText(transfer ? String(Number(transfer.amount.toPrecision(10))) : "");
    setDate(todayISO());
    setMethod("Cash");
    setNote("");
    setDraft({ from: nextFrom, to: nextTo, amount: transfer ? String(transfer.amount) : "" });
  };

  const cancel = () => setDraft(null);

  // A QR code or link may open the trip while it is already on screen.
  useEffect(() => {
    if (!initialTransfer) return;
    const key = `${initialTransfer.from}:${initialTransfer.to}:${initialTransfer.amount}`;
    if (openedRequest.current === key) return;
    openedRequest.current = key;
    startRecording(initialTransfer);
    // startRecording only sets state; it does not need to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTransfer]);

  const submit = () => {
    const amount = parseAmount(amountText, trip.baseCurrency);
    if (!from || !to || from === to) {
      Alert.alert("Choose two people", "A payment needs someone paying and someone receiving.");
      return;
    }
    if (!members.some((member) => member.id === from) || !members.some((member) => member.id === to)) {
      Alert.alert("Person not on this trip", "This payment link may be out of date. Pick two people on the trip.");
      return;
    }
    if (amount == null || amount <= 0 || toMinor(amount, trip.baseCurrency) <= 0) {
      Alert.alert("Enter an amount", `Enter how much was paid in ${trip.baseCurrency}.`);
      return;
    }
    if (!isISODate(date)) {
      Alert.alert("Invalid date", "Enter the payment date as YYYY-MM-DD.");
      return;
    }
    const now = Date.now();
    onRecord({
      id: newId(),
      from,
      to,
      amount,
      currency: trip.baseCurrency,
      date,
      method: method || undefined,
      note: note.trim() || undefined,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    setDraft(null);
  };

  const canUndo = (settlement: Settlement) =>
    !settlement.createdBy || !userId || settlement.createdBy === userId || trip.ownerId === userId;

  const row = (transfer: Transfer, i: number, dim = false) => (
    <View
      key={`${transfer.from}-${transfer.to}-${i}`}
      style={{ paddingVertical: 7, borderTopWidth: i ? 1 : 0, borderTopColor: colors.border }}
      accessibilityLabel={
        dim
          ? `${name(transfer.from)} owes ${name(transfer.to)} ${withOriginal(view, transfer.amount)} without simplifying`
          : `${name(transfer.from)} pays ${name(transfer.to)} ${withOriginal(view, transfer.amount)}`
      }
    >
      <Text style={{ color: dim ? colors.muted : colors.text }}>
        <Text style={{ fontWeight: dim ? "400" : "600" }}>{transfer.from === me ? "You" : name(transfer.from)}</Text>
        {transfer.from === me ? " pay " : " pays "}
        <Text style={{ fontWeight: dim ? "400" : "600" }}>{transfer.to === me ? "you" : name(transfer.to)}</Text>{" "}
        {withOriginal(view, transfer.amount)}
      </Text>
      {!dim && (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
          <Button
            title={transfer.from === me ? "I paid this" : "Mark paid"}
            variant="secondary"
            style={{ flex: 1, paddingVertical: 7 }}
            onPress={() => startRecording(transfer)}
          />
          <Button
            title="Request"
            variant="ghost"
            style={{ flex: 0.8, paddingVertical: 7 }}
            onPress={() => setRequesting(transfer)}
            accessibilityHint="Shows a QR code and link the other person can scan"
          />
        </View>
      )}
    </View>
  );

  return (
    <Card>
      <Text style={styles.h2} accessibilityRole="header">Settle up</Text>
      <Text style={[styles.muted, { fontSize: 12, marginBottom: 6 }]}>
        Suggested payments bring every balance to zero. Record one once the money has actually moved.
      </Text>
      {plan.transfers.length === 0 ? (
        <Text style={styles.muted}>Everyone is square. 🎉</Text>
      ) : (
        <>
          {plan.transfers.map((transfer, i) => row(transfer, i))}
          <Text style={{ marginTop: 6, fontWeight: "600", color: colors.positive }}>
            {plan.saved > 0
              ? `Simplified: ${plan.transfers.length} payment${plan.transfers.length === 1 ? "" : "s"} instead of ${plan.direct.length}`
              : `${plan.transfers.length} payment${plan.transfers.length === 1 ? "" : "s"} — already the fewest possible`}
          </Text>
        </>
      )}

      <Button
        title="+ Record a payment"
        variant="secondary"
        onPress={() => startRecording()}
        style={{ marginTop: 10 }}
        accessibilityHint="Record money that has already changed hands"
      />

      {draft && (
        <View style={{ marginTop: 12, padding: 12, borderRadius: 10, backgroundColor: colors.primarySoft }}>
          <Text style={[styles.label, { color: colors.text }]}>Payment details</Text>
          <Label>From</Label>
          <View style={[styles.chips, { marginBottom: 8 }]}>
            {members.map((member) => (
              <Chip
                key={member.id}
                label={member.name}
                selected={from === member.id}
                accessibilityLabel={`Paid by ${member.name}`}
                onPress={() => setFrom(member.id)}
              />
            ))}
          </View>
          <Label>To</Label>
          <View style={[styles.chips, { marginBottom: 8 }]}>
            {members.map((member) => (
              <Chip
                key={member.id}
                label={member.name}
                selected={to === member.id}
                accessibilityLabel={`Paid to ${member.name}`}
                onPress={() => setTo(member.id)}
              />
            ))}
          </View>
          <Label>Amount ({trip.baseCurrency})</Label>
          <Input
            keyboardType="decimal-pad"
            placeholder="0"
            value={amountText}
            onChangeText={setAmountText}
            accessibilityLabel={`Payment amount in ${trip.baseCurrency}`}
          />
          <View style={{ height: 8 }} />
          <Label>Date (YYYY-MM-DD)</Label>
          <Input value={date} onChangeText={setDate} accessibilityLabel="Payment date" />
          <View style={{ height: 8 }} />
          <Label>Method</Label>
          <View style={[styles.chips, { marginBottom: 8 }]}>
            {METHODS.map((option) => (
              <Chip
                key={option}
                label={option}
                selected={method === option}
                accessibilityLabel={`Payment method ${option}`}
                onPress={() => setMethod(option)}
              />
            ))}
          </View>
          <Label>Note (optional)</Label>
          <Input
            placeholder="e.g. paid at dinner"
            value={note}
            onChangeText={setNote}
            accessibilityLabel="Payment note"
          />
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <Button title="Save payment" onPress={submit} style={{ flex: 1 }} />
            <Button title="Cancel" variant="ghost" onPress={cancel} style={{ flex: 1 }} />
          </View>
        </View>
      )}

      {history.length > 0 && (
        <View style={{ marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
          <Text style={[styles.h2, { fontSize: 16 }]} accessibilityRole="header">Payments recorded</Text>
          {history.map((settlement) => (
            <View
              key={settlement.id}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 }}
              accessibilityLabel={
                `${name(settlement.from)} paid ${name(settlement.to)} ` +
                `${formatMoney(settlement.amount, settlement.currency)} on ${settlement.date}` +
                `${settlement.method ? ` by ${settlement.method}` : ""}`
              }
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text }}>
                  {name(settlement.from)} → {name(settlement.to)} ·{" "}
                  {formatMoney(settlement.amount, settlement.currency)}
                </Text>
                <Text style={[styles.muted, { fontSize: 12 }]}>
                  {settlement.date}
                  {settlement.method ? ` · ${settlement.method}` : ""}
                  {settlement.note ? ` · ${settlement.note}` : ""}
                </Text>
              </View>
              {canUndo(settlement) && (
                <Pressable
                  onPress={() =>
                    Alert.alert("Undo this payment?", "Balances will go back to what they were before this payment was recorded.", [
                      { text: "Cancel", style: "cancel" },
                      { text: "Undo", style: "destructive", onPress: () => onDelete(settlement.id) },
                    ])
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Undo payment from ${name(settlement.from)} to ${name(settlement.to)}`}
                  style={{ padding: 6 }}
                >
                  <Text style={{ color: colors.negative, fontWeight: "600" }}>Undo</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}

      {plan.saved > 0 && (
        <>
          <Pressable
            onPress={onToggleDirect}
            style={{ marginTop: 10 }}
            accessibilityRole="button"
            accessibilityLabel={
              showDirect ? "Hide who owes whom without simplifying" : "Show who owes whom without simplifying"
            }
            accessibilityState={{ expanded: showDirect }}
          >
            <Text style={styles.link}>
              {showDirect ? "Hide" : "Show"} who owes whom without simplifying
            </Text>
          </Pressable>
          {showDirect && (
            <View style={{ marginTop: 6 }}>
              {plan.direct.map((transfer, i) => row(transfer, i, true))}
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

      {requesting && (
        <PaymentRequestSheet
          trip={trip}
          transfer={requesting}
          view={view}
          name={name}
          onClose={() => setRequesting(null)}
        />
      )}
    </Card>
  );
}

/**
 * A QR code and deep link that opens this trip with the payment pre-filled.
 * The link only carries member ids and an amount; it grants no access.
 */
function PaymentRequestSheet({
  trip,
  transfer,
  view,
  name,
  onClose,
}: {
  trip: Trip;
  transfer: Transfer;
  view: HomeCurrencyView;
  name: (memberId: string) => string;
  onClose: () => void;
}) {
  const { colors, styles } = useTheme();
  const url = Linking.createURL(`/trip/${encodeURIComponent(trip.id)}`, {
    queryParams: paymentRequestParams(transfer),
  });
  const amount = view.format(transfer.amount);
  const payer = name(transfer.from);
  const payee = name(transfer.to);

  const share = () => {
    void Share.share({
      message:
        `${payer} → ${payee}: ${amount.main}` +
        (amount.original ? ` (${amount.original})` : "") +
        ` for ${trip.name}.\n\nOpen this link to record the payment in Deochipei:\n${url}`,
    }).catch(() => {
      // The QR code and link remain available if the share sheet is dismissed.
    });
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <SafeAreaView style={{ backgroundColor: colors.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18 }}>
          <ScrollView contentContainerStyle={[styles.content, { alignItems: "center" }]}>
            <Text style={[styles.h2, { textAlign: "center" }]} accessibilityRole="header">
              Payment request
            </Text>
            <Text style={{ color: colors.text, marginTop: 4, marginBottom: 12, textAlign: "center" }}>
              {payer} pays {payee} · {amount.main}
              {amount.original ? ` (${amount.original})` : ""}
            </Text>
            <Card style={{ padding: 12, alignItems: "center" }}>
              <QrCode value={url} size={220} />
            </Card>
            <Text style={[styles.muted, { fontSize: 12, textAlign: "center", marginTop: 10 }]}>
              Scan with a phone camera, or send the link. It opens this trip with the payment ready to record.
            </Text>
            <Text
              selectable
              style={{ color: colors.tint, fontSize: 11, textAlign: "center", marginTop: 8 }}
              accessibilityLabel="Payment request link"
            >
              {url}
            </Text>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 16, alignSelf: "stretch" }}>
              <Button title="Send request" onPress={share} style={{ flex: 1 }} />
              <Button title="Done" variant="ghost" onPress={onClose} style={{ flex: 1 }} />
            </View>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

/** "$45.20 (¥6,800)": the viewer's currency, with what the group settles in. */
function withOriginal(view: HomeCurrencyView, tripAmount: number) {
  const { main, original } = view.format(tripAmount);
  return original ? `${main} (${original})` : main;
}
