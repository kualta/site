import type { APIRoute } from "astro";
import type { Contact } from "@/types";
import contactsData from "@/data/contacts.json";

export const GET: APIRoute = () => {
  const sorted = [...(contactsData as Contact[])].sort(
    (a, b) =>
      a.platform.length + a.label.length - (b.platform.length + b.label.length),
  );
  return new Response(JSON.stringify(sorted), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
