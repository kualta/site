import { getAllContacts } from "@/lib/dataFetch";

export async function GET(request: Request) {
  return await getAllContacts();
}
