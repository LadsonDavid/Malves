import type { Lead, LinkClient } from "@malves/protocol";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { type Model, pickAgent, researchPrompt } from "../model";
import { Banner, Button, Card, color, Section, styles } from "../ui";

type Props = {
  model: Model;
  client: LinkClient | undefined;
  lastAgent: string | undefined;
  onClose: () => void;
};

const TIER_COLOR: Record<Lead["tier"], string> = {
  hot: color.danger,
  warm: color.warn,
  cold: color.muted,
};

/** Who to contact this week, and why (points 1 and 7) — from the lead engine, via the computer. */
export function LeadsScreen({ model, client, lastAgent, onClose }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [started, setStarted] = useState<string>();

  const refresh = async () => {
    if (!client) return;
    setRefreshing(true);
    setProblem(undefined);
    try {
      const ack = await client.refreshLeads();
      if (!ack.ok) setProblem(ack.error ?? "The computer couldn't get the leads.");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  };

  const research = async (lead: Lead) => {
    const workspaceId = model.workspaces[0]?.id;
    const agent = pickAgent(model.agents, lastAgent);
    if (!client) return;
    if (!workspaceId)
      return setProblem("Add a project folder on the computer first (add <folder>).");
    if (!agent) return setProblem("No agent is ready on the computer.");
    setProblem(undefined);
    const ack = await client
      .createTask({ workspaceId, agent, prompt: researchPrompt(lead) })
      .catch((error: unknown) => ({ ok: false, error: String(error) }));
    if (ack.ok) setStarted(lead.domain);
    else setProblem(ack.error ?? "The computer couldn't start the research.");
  };

  const leads = model.leads;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.title}>Leads</Text>
      <Text style={styles.muted}>
        {leads
          ? `${leads.list.length} to contact · updated ${new Date(leads.fetchedAt).toLocaleTimeString()}`
          : "Not fetched yet."}
      </Text>
      <Button title="Refresh" busy={refreshing} onPress={() => void refresh()} />
      {problem ? <Banner tone="bad">{problem}</Banner> : null}
      {started ? (
        <Banner tone="info">
          Research on {started} started. It's under Running, and asks you before it opens the site.
        </Banner>
      ) : null}

      {leads && leads.list.length === 0 ? (
        <Text style={styles.muted}>No leads this week. The lead engine found no new signals.</Text>
      ) : null}
      <Section title="This week">
        {leads?.list.map((lead) => (
          <LeadCard key={lead.domain} lead={lead} onResearch={() => void research(lead)} />
        ))}
      </Section>

      <Button title="Back" kind="plain" onPress={onClose} />
    </ScrollView>
  );
}

function LeadCard({ lead, onResearch }: { lead: Lead; onResearch: () => void }) {
  return (
    <Card>
      <View style={styles.row}>
        <Text style={{ color: TIER_COLOR[lead.tier], fontWeight: "700" }}>
          {lead.tier.toUpperCase()}
        </Text>
        <Text style={styles.muted}>
          {lead.domain} · score {Math.round(lead.score)} · {lead.signals} signal(s)
        </Text>
      </View>
      <Text style={[styles.body, { fontWeight: "600" }]}>{lead.name}</Text>
      <Text style={styles.body}>{lead.why}</Text>
      {lead.trigger ? <Text style={styles.muted}>Latest: {lead.trigger}</Text> : null}
      {lead.opener ? <Text style={styles.body}>Opener: “{lead.opener}”</Text> : null}
      <Text style={styles.muted}>
        {lead.contact
          ? `${lead.contact.name}, ${lead.contact.title} · ${lead.contact.email}`
          : "No contact found yet."}
      </Text>
      <Button title="Research in browser" kind="plain" onPress={onResearch} />
    </Card>
  );
}
