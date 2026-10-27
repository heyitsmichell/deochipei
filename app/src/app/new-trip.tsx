import { router } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { Button, CurrencyPicker, Field, Label, useTheme } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { useSettings, useTripActions } from "../state/TripsContext";

export default function NewTripScreen() {
  const { styles } = useTheme();
  const { createTrip, setHomeCurrency } = useTripActions();
  const { user, displayName: authName, avatarUrl } = useAuth();
  const settings = useSettings();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState(settings.homeCurrency ?? "USD");
  // Until picked, your home currency follows the trip currency.
  const [home, setHome] = useState(settings.homeCurrency);
  const [me, setMe] = useState(authName || "");
  const [others, setOthers] = useState("");

  const submit = () => {
    const memberNames = [me, ...others.split(",")].map((n) => n.trim()).filter(Boolean);
    if (!name.trim() || !me.trim()) {
      Alert.alert("Almost there", "Give the trip a name and tell us your name.");
      return;
    }
    const myHome = home ?? currency;
    if (myHome !== settings.homeCurrency) setHomeCurrency(myHome);
    const trip = createTrip({
      name: name.trim(),
      baseCurrency: currency,
      memberNames,
      ownerId: user?.id,
      ownerEmail: user?.email,
      ownerAvatarUrl: avatarUrl,
    });
    router.replace(`/trip/${trip.id}`);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Field label="Trip name" placeholder="Japan spring 2027" value={name} onChangeText={setName} />
      <View style={{ marginBottom: 14 }}>
        <Label>Trip currency (everyone settles up in this)</Label>
        <CurrencyPicker value={currency} onChange={setCurrency} />
      </View>
      <View style={{ marginBottom: 14 }}>
        <Label>Your home currency (you see totals and balances in this)</Label>
        <CurrencyPicker value={home ?? currency} onChange={setHome} />
        <Text style={[styles.muted, { fontSize: 12, marginTop: 6 }]}>
          Everyone picks their own, so a friend from abroad sees the same trip in theirs.
        </Text>
      </View>
      <Field label="Your name" placeholder="Alex" value={me} onChangeText={setMe} />
      <Field
        label="Travel buddies (comma separated, optional)"
        placeholder="Sam, Priya, Jun"
        value={others}
        onChangeText={setOthers}
      />
      <Text style={[styles.muted, { marginBottom: 16 }]}>
        Others can also join later with the trip code and add themselves.
      </Text>
      <Button title="Create trip" onPress={submit} />
    </ScrollView>
  );
}
