export interface Contact {
  id: number;
  platform: string;
  label: string;
  link: string;
  description: string | null;
  is_main: boolean;
}

export interface Track {
  id: number;
  slug: string;
  title: string;
  artist: string;
  album: string | null;
  /** who released it first, when this is someone else's song */
  originalArtist: string | null;
  kind: "cover" | "original";
  date: string;
  duration: number;
  src: string;
  cover: string | null;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  link: string | null;
  git_link: string;
  language: string | null;
  date: string;
  status: string;
  tech_stack: string[];
  full_name: string | null;
  relevance: number | null;
}
