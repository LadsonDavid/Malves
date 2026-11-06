import { politeFetch } from "./polite.js";

export type CollectedJob = {
  id: string;
  title: string;
  location?: string | undefined;
  url: string;
  updatedAt?: number | undefined;
};

/** Collects open roles from Greenhouse boards API without login. */
export async function collectGreenhouseJobs(
  boardToken: string,
  fetchFn: typeof politeFetch = politeFetch,
): Promise<CollectedJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs`;
  const res = await fetchFn(url);
  if (res.status !== 200) return [];
  const data = (await res.json()) as {
    jobs?: Array<{
      id: number;
      title: string;
      location?: { name?: string };
      absolute_url: string;
      updated_at?: string;
    }>;
  };

  return (data.jobs ?? []).map((j) => ({
    id: `gh-${j.id}`,
    title: j.title,
    location: j.location?.name,
    url: j.absolute_url,
    updatedAt: j.updated_at ? new Date(j.updated_at).getTime() : undefined,
  }));
}

/** Collects open roles from Lever postings API without login. */
export async function collectLeverJobs(
  company: string,
  fetchFn: typeof politeFetch = politeFetch,
): Promise<CollectedJob[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`;
  const res = await fetchFn(url);
  if (res.status !== 200) return [];
  const data = (await res.json()) as Array<{
    id: string;
    text: string;
    categories?: { location?: string };
    hostedUrl: string;
    createdAt?: number;
  }>;

  return (Array.isArray(data) ? data : []).map((p) => ({
    id: `lever-${p.id}`,
    title: p.text,
    location: p.categories?.location,
    url: p.hostedUrl,
    updatedAt: p.createdAt,
  }));
}

/** Collects open roles from Ashby job board API without login. */
export async function collectAshbyJobs(
  company: string,
  fetchFn: typeof politeFetch = politeFetch,
): Promise<CollectedJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company)}`;
  const res = await fetchFn(url);
  if (res.status !== 200) return [];
  const data = (await res.json()) as {
    jobs?: Array<{
      id: string;
      title: string;
      location?: string;
      jobUrl: string;
      publishedAt?: string;
    }>;
  };

  return (data.jobs ?? []).map((j) => ({
    id: `ashby-${j.id}`,
    title: j.title,
    location: j.location,
    url: j.jobUrl,
    updatedAt: j.publishedAt ? new Date(j.publishedAt).getTime() : undefined,
  }));
}
