import type { Lead, LinkClient } from "@malves/protocol";
import { useState } from "react";
import { Linking, RefreshControl, ScrollView, Share, Text, View } from "react-native";
import { type Model, mailtoFor, pickAgent, researchPrompt } from "../model";
import { Banner, Button, buzz, Card, Chip, Choices, styles, type Tone } from "../ui";

type Props = {
  model: Model;
  client: LinkClient | undefined;
  lastAgent: string | undefined;
  onOpenTask: (taskId: string) => void;
};

type TierFilter = "all" | Lead["tier"];

const TIER_TONE: Record<Lead["tier"], Tone | "plain"> = { hot: "bad", warm: "warn", cold: "plain" };

/** Who to contact this week, and why (points 1 and 7) — from the lead engine, via the computer. */
export function LeadsScreen({ model, client, lastAgent, onOpenTask }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [started, setStarted] = useState<{ domain: string; taskId?: string }>();
  const [tier, setTier] = useState<TierFilter>("all");

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
    if (!workspaceId) {
      return setProblem("Add a project folder on the computer first (add <folder>).");
    }
    if (!agent) return setProblem("No agent is ready on the computer.");
    setProblem(undefined);
    const ack = await client
      .createTask({ workspaceId, agent, prompt: researchPrompt(lead) })
      .catch((error: unknown) => ({ ok: false, error: String(error), result: undefined }));
    if (ack.ok) {
      buzz();
      setStarted({ domain: lead.domain, ...(ack.result ? { taskId: ack.result } : {}) });
    } else setProblem(ack.error ?? "The computer couldn't start the research.");
  };

  const leads = model.leads;
  const shown = leads?.list.filter((l) => tier === "all" || l.tier === tier) ?? [];
  const count = (t: Lead["tier"]) => leads?.list.filter((l) => l.tier === t).length ?? 0;

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <Text style={styles.title}>Leads</Text>
      <Text style={styles.muted}>
        {leads
          ? `${leads.list.length} to contact this week · updated ${new Date(leads.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : "Pull down, or tap Get leads, to fetch this week's list from your lead engine."}
      </Text>
      {!leads ? (
        <Button title="Get leads" busy={refreshing} onPress={() => void refresh()} />
      ) : null}
      {problem ? <Banner tone="bad">{problem}</Banner> : null}
      {started ? (
        <Card>
          <Text style={styles.body}>
            Researching {started.domain}. It asks you before it opens the site.
          </Text>
          {started.taskId ? (
            <Button title="See it" kind="plain" onPress={() => onOpenTask(started.taskId ?? "")} />
          ) : null}
        </Card>
      ) : null}

      {leads && leads.list.length > 0 ? (
        <Choices
          options={[
            { value: "all", label: `All ${leads.list.length}` },
            { value: "hot", label: `Hot ${count("hot")}` },
            { value: "warm", label: `Warm ${count("warm")}` },
            { value: "cold", label: `Cold ${count("cold")}` },
          ]}
          value={tier}
          onChange={setTier}
        />
      ) : null}
      {leads && leads.list.length === 0 ? (
        <Text style={styles.muted}>No leads this week. The lead engine found no new signals.</Text>
      ) : null}
      {shown.map((lead) => (
        <LeadCard key={lead.domain} lead={lead} onResearch={() => void research(lead)} />
      ))}
    </ScrollView>
  );
}

function LeadCard({ lead, onResearch }: { lead: Lead; onResearch: () => void }) {
  const mail = mailtoFor(lead);
  return (
    <Card>
      <View style={[styles.row, { alignItems: "center" }]}>
        <Chip label={lead.tier.toUpperCase()} tone={TIER_TONE[lead.tier]} />
        <Text style={styles.muted}>
          {lead.domain} · score {Math.round(lead.score)} · {lead.signals} signal
          {lead.signals === 1 ? "" : "s"}
        </Text>
      </View>
      <Text style={[styles.body, { fontWeight: "600" }]}>{lead.name}</Text>
      <Text style={styles.body}>{lead.why}</Text>
      {lead.trigger ? <Text style={styles.muted}>Latest: {lead.trigger}</Text> : null}
      {lead.opener ? (
        <Text style={styles.body} selectable>
          Opener: “{lead.opener}”
        </Text>
      ) : null}
      <Text style={styles.muted} selectable>
        {lead.contact
          ? `${lead.contact.name}, ${lead.contact.title} · ${lead.contact.email}`
          : "No contact found yet."}
      </Text>
      <View style={styles.row}>
        {mail ? (
          <Button title="Email" onPress={() => void Linking.openURL(mail).catch(() => {})} />
        ) : null}
        {lead.opener ? (
          <Button
            title="Share opener"
            kind="plain"
            onPress={() => void Share.share({ message: lead.opener })}
          />
        ) : null}
        <Button title="Research in browser" kind="plain" onPress={onResearch} />
      </View>
    </Card>
  );
}
