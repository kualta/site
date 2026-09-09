export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface NewsletterDB {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}
export interface NewsletterEnv {
  NEWSLETTER_DB?: NewsletterDB;
  PLUNK_SECRET_KEY?: string;
  NEWSLETTER_TOKEN_SECRET?: string;
  NEWSLETTER_ADMIN_SECRET?: string;
  NEWSLETTER_WEBHOOK_SECRET?: string;
  NEWSLETTER_ORIGIN?: string;
}
export interface Subscriber {
  id: string;
  email: string;
  status: "pending" | "active" | "unsubscribed" | "suppressed";
  confirmation_hash: string | null;
  confirmation_expires: number | null;
}
export interface Delivery {
  id: string;
  subscriber_id: string;
  issue_id: string | null;
  kind: "confirmation" | "newsletter" | "test";
  state: string;
  provider_id: string | null;
}
export interface Issue {
  id: string;
  title: string;
  preview: string;
  paragraphs: string[];
  markdown?: string;
  articleUrl: string;
}
export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  idempotencyKey: string;
  unsubscribeUrl?: string;
}
export type EmailSender = (email: OutgoingEmail) => Promise<string>;
