import { type KeyPair, LinkClient, type LinkStatus, type Welcome } from "@malves/protocol";
import { useEffect, useReducer, useRef, useState } from "react";
import { emptyModel, type Model, reduce } from "./model";

export type Connection = {
  url: string;
  runnerKey: string;
  keys: KeyPair;
  /** Only while pairing: the code from the QR, and this phone's name. */
  pair?: { code: string; name: string };
};

export type Link = {
  model: Model;
  status: LinkStatus;
  /** Why the runner refused us, or why the connection dropped. */
  detail: string | undefined;
  client: LinkClient | undefined;
};

/**
 * Owns the one connection to the runner. Events flow down into the model;
 * commands go up through `client`. Reconnecting and resuming are the client's
 * job, so this hook only wires it to React state.
 */
export function useLink(connection: Connection | null, onWelcome?: (w: Welcome) => void): Link {
  const [model, dispatch] = useReducer(reduce, emptyModel);
  const [status, setStatus] = useState<LinkStatus>("connecting");
  const [detail, setDetail] = useState<string>();
  const [client, setClient] = useState<LinkClient>();
  const welcomed = useRef(onWelcome);
  welcomed.current = onWelcome;

  useEffect(() => {
    if (!connection) return;
    dispatch({ type: "reset" });
    const link = new LinkClient({
      url: connection.url,
      runnerKey: connection.runnerKey,
      keys: connection.keys,
      ...(connection.pair ? { pair: connection.pair } : {}),
      onWelcome: (welcome) => {
        dispatch({ type: "welcome", welcome });
        welcomed.current?.(welcome);
      },
      onAgents: (agents) => dispatch({ type: "agents", agents }),
      onLeads: (leads, fetchedAt) => dispatch({ type: "leads", leads, fetchedAt }),
      onEvent: (event) => dispatch({ type: "event", event }),
      onStatus: (next, why) => {
        setStatus(next);
        setDetail(why);
      },
    });
    setClient(link);
    link.connect();
    return () => link.close();
  }, [connection]);

  return { model, status, detail, client };
}
