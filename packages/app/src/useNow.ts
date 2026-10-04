import { useEffect, useState } from "react";

/** The current time, refreshed every `everyMs`, for countdowns and "running 3 min". */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
