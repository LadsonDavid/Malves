import { useEffect, useState } from "react";
import { Linking, Text } from "react-native";
import { loadPushLink, savePushLink } from "./storage";
import { Banner, Button, Card, styles } from "./ui";

const NTFY_ON_PLAY = "https://play.google.com/store/apps/details?id=io.heckel.ntfy";

/**
 * Notifications come through the free ntfy app, straight from the computer over
 * Tailscale. One tap here subscribes it. The card comes back if the computer
 * changes the link (e.g. after revoking a phone), since the old one stops working.
 */
export function PushCard({
  link,
  quiet = false,
}: {
  link: string | null;
  /** Show nothing unless there's something to set up (the home screen). */
  quiet?: boolean;
}) {
  const [done, setDone] = useState<string | null>();
  const [missingApp, setMissingApp] = useState(false);

  useEffect(() => {
    void loadPushLink().then(setDone);
  }, []);

  if (done === undefined) return null;
  if (quiet && (!link || done === link)) return null;
  if (!link) {
    return (
      <Text style={styles.muted}>
        Notifications are off. They need Tailscale on your computer and phone.
      </Text>
    );
  }
  if (done === link) return <Text style={styles.muted}>Notifications: on, through ntfy.</Text>;

  const setUp = async () => {
    try {
      await Linking.openURL(link);
      await savePushLink(link);
      setDone(link);
      setMissingApp(false);
    } catch {
      setMissingApp(true);
    }
  };

  return (
    <Card>
      <Text style={styles.body}>
        {done
          ? "Your computer changed its notification link. Set it up again to keep getting questions."
          : "Get questions as notifications, and answer them from the lock screen."}
      </Text>
      <Button title="Set up notifications" onPress={() => void setUp()} />
      {missingApp ? (
        <>
          <Banner tone="info">
            Install the free ntfy app first (Google Play or F-Droid), then tap Set up again. In
            ntfy, allow notifications.
          </Banner>
          <Button
            title="Get ntfy on Google Play"
            kind="plain"
            onPress={() => void Linking.openURL(NTFY_ON_PLAY)}
          />
        </>
      ) : null}
    </Card>
  );
}
