export interface DocMeta {
  url: string;
  final_url: string;
  title?: string;
  author?: string;
  published?: string;
  lang?: string;
  description?: string;
  site?: string;
  status: number;
  content_type?: string;
  fetched_at: string;
  /** Only "http" in this build. */
  mode: "http";
  extractor: string;
  /** Approximate token count of the full converted document. */
  tokens: number;
  warnings: string[];
  injection_suspected?: string[];
}

export interface Doc {
  meta: DocMeta;
  markdown: string;
}
