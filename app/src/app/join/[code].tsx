import { useLocalSearchParams } from "expo-router";
import { JoinTrip } from "../../components/JoinTrip";

/** Where invite links and QR codes land: deochipei://join/<code> or https://…/join/<code>. */
export default function JoinFromLinkScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  return <JoinTrip initialCode={code} />;
}
