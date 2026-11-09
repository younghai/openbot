/**
 * Scholarly research tools (OpenResearch pattern): arXiv and PubMed search
 * with no API key, plus a structured Markdown research report generator.
 * Paper abstracts are external content — the injection guard wraps them.
 */
import fs from "node:fs";
import path from "node:path";
import { registerTool, safeWorkspacePath } from "./gateway.js";
import { workspaceFor, ensureWorkspace } from "../computers/index.js";
import { indexDocument } from "../knowledge.js";

const ARXIV_BASE = process.env.OPENBOT_ARXIV_API_BASE ?? "http://export.arxiv.org/api/query";
const PUBMED_BASE = process.env.OPENBOT_PUBMED_API_BASE ?? "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const NET_TIMEOUT = 15_000;

export interface ResearchPaper {
  source: "arxiv" | "pubmed";
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  published: string;
  url: string;
  pdfUrl?: string;
  categories?: string[];
  journal?: string;
  doi?: string;
}

// ---------------------------------------------------------------- XML helpers (no dependency)

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ").trim();
}

function extractTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]) : null;
}

function extractAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(decodeXml(m[1]));
  return out;
}

// ---------------------------------------------------------------- arXiv

async function searchArxiv(query: string, maxResults: number): Promise<ResearchPaper[]> {
  const url = `${ARXIV_BASE}?search_query=${encodeURIComponent(`all:${query}`)}&start=0&max_results=${maxResults}&sortBy=relevance`;
  const res = await fetch(url, { signal: AbortSignal.timeout(NET_TIMEOUT) });
  if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`);
  const xml = await res.text();
  const papers: ResearchPaper[] = [];
  const entries = xml.split(/<entry>/).slice(1);
  for (const entry of entries) {
    const idUrl = extractTag(entry, "id") ?? "";
    const id = idUrl.split("/abs/").pop() ?? idUrl;
    const title = extractTag(entry, "title") ?? "";
    const summary = extractTag(entry, "summary") ?? "";
    const published = extractTag(entry, "published") ?? "";
    const authors = extractAll(entry, "name");
    const pdfMatch = /href="([^"]*\.pdf)"/.exec(entry);
    const categories = [...entry.matchAll(/term="([^"]+)"/g)].map((c) => c[1]).slice(0, 4);
    if (title && id) {
      papers.push({
        source: "arxiv",
        id,
        title: title.slice(0, 200),
        authors: authors.slice(0, 8),
        abstract: summary.slice(0, 800),
        published: published.slice(0, 10),
        url: `https://arxiv.org/abs/${id}`,
        pdfUrl: pdfMatch?.[1],
        categories,
      });
    }
  }
  return papers;
}

// ---------------------------------------------------------------- PubMed

async function searchPubmed(query: string, maxResults: number): Promise<ResearchPaper[]> {
  // Step 1: ESearch to get PMIDs
  const searchUrl = `${PUBMED_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmode=json&retmax=${maxResults}`;
  const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(NET_TIMEOUT) });
  if (!searchRes.ok) throw new Error(`PubMed esearch HTTP ${searchRes.status}`);
  const searchJson = (await searchRes.json()) as { esearchresult?: { idlist?: string[] } };
  const pmids = searchJson.esearchresult?.idlist ?? [];
  if (pmids.length === 0) return [];

  // Step 2: ESummary to get details
  const summaryUrl = `${PUBMED_BASE}/esummary.fcgi?db=pubmed&id=${pmids.join(",")}&retmode=json`;
  const summaryRes = await fetch(summaryUrl, { signal: AbortSignal.timeout(NET_TIMEOUT) });
  if (!summaryRes.ok) throw new Error(`PubMed esummary HTTP ${summaryRes.status}`);
  const summaryJson = (await summaryRes.json()) as {
    result?: Record<string, {
      title?: string;
      authors?: { name: string }[];
      pubdate?: string;
      fulljournalname?: string;
      elocationid?: string;
      articleids?: { idtype: string; value: string }[];
    }>;
  };
  const papers: ResearchPaper[] = [];
  for (const pmid of pmids) {
    const item = summaryJson.result?.[pmid];
    if (!item?.title) continue;
    const doi = item.articleids?.find((a) => a.idtype === "doi")?.value;
    papers.push({
      source: "pubmed",
      id: pmid,
      title: item.title.slice(0, 200),
      authors: (item.authors ?? []).map((a) => a.name).slice(0, 8),
      abstract: "", // esummary doesn't include abstracts; use efetch for full text
      published: (item.pubdate ?? "").slice(0, 10),
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      journal: item.fulljournalname,
      doi,
    });
  }
  return papers;
}

// ---------------------------------------------------------------- tools

registerTool({
  name: "arxiv.search",
  description: "Search arXiv for academic papers (physics, CS, math, biology). No API key. Returns title, authors, abstract, URL, and publication date.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "search query (keywords)" },
      maxResults: { type: "number", description: "max papers to return (1-20, default 5)" },
    },
    required: ["query"],
  },
  async execute(_ctx, args) {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query required");
    const max = Math.min(Math.max(Number(args.maxResults ?? 5), 1), 20);
    const papers = await searchArxiv(query, max);
    return { query, source: "arxiv", papers, count: papers.length };
  },
});

registerTool({
  name: "pubmed.search",
  description: "Search PubMed for biomedical literature citations. No API key. Returns PMID, title, authors, journal, and URL.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "search query (medical/biology keywords)" },
      maxResults: { type: "number", description: "max papers (1-20, default 5)" },
    },
    required: ["query"],
  },
  async execute(_ctx, args) {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query required");
    const max = Math.min(Math.max(Number(args.maxResults ?? 5), 1), 20);
    const papers = await searchPubmed(query, max);
    return { query, source: "pubmed", papers, count: papers.length };
  },
});

registerTool({
  name: "research.report",
  description: "Generate a structured Markdown research report from your findings. Writes to the bot workspace under research/ and indexes it as searchable knowledge. Sections: Research Question, Literature Review, Hypothesis, Experiment Design, Findings, Conclusion, References.",
  parameters: {
    type: "object",
    properties: {
      researchQuestion: { type: "string", description: "the question being investigated" },
      literature: { type: "string", description: "summary of reviewed papers with citations" },
      hypothesis: { type: "string", description: "the falsifiable hypothesis" },
      experimentDesign: { type: "string", description: "how the hypothesis was tested" },
      findings: { type: "string", description: "results and analysis" },
      conclusion: { type: "string", description: "answer to the research question with limitations" },
      references: { type: "array", items: { type: "string" }, description: "citation list (paper titles + URLs)" },
    },
    required: ["researchQuestion", "literature", "hypothesis", "experimentDesign", "findings", "conclusion"],
  },
  async execute(ctx, args) {
    const ws = ensureWorkspace(workspaceFor(ctx.computer, ctx.bot.id));
    const researchDir = path.join(ws, "research");
    fs.mkdirSync(researchDir, { recursive: true });
    const slug = String(args.researchQuestion ?? "report").toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").slice(0, 40).replace(/^-|-$/g, "") || "report";
    const filename = `${new Date().toISOString().slice(0, 10)}-${slug}.md`;
    const filepath = path.join(researchDir, filename);

    const refs = Array.isArray(args.references) ? (args.references as string[]) : [];
    const md = [
      `# Research Report: ${args.researchQuestion}`,
      ``,
      `**Generated:** ${new Date().toISOString()} | **Bot:** ${ctx.bot.name}`,
      ``,
      `## Research Question`,
      String(args.researchQuestion ?? ""),
      ``,
      `## Literature Review`,
      String(args.literature ?? ""),
      ``,
      `## Hypothesis`,
      String(args.hypothesis ?? ""),
      ``,
      `## Experiment Design`,
      String(args.experimentDesign ?? ""),
      ``,
      `## Findings`,
      String(args.findings ?? ""),
      ``,
      `## Conclusion`,
      String(args.conclusion ?? ""),
      ``,
      `## References`,
      ...(refs.length > 0 ? refs.map((r, i) => `${i + 1}. ${r}`) : ["(none provided)"]),
    ].join("\n");

    fs.writeFileSync(filepath, md);

    // Index as searchable knowledge
    const chunks = indexDocument(ctx.bot.id, filename, md);

    return {
      ok: true,
      path: path.relative(ws, filepath),
      filename,
      chunksIndexed: chunks,
      sections: 7,
    };
  },
});
