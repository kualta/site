import { getAllContacts } from "../../../prisma/dataFetch";

export async function GET(request: Request) {
  return await getAllContacts();
}
