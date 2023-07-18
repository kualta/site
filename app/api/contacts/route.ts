import { getAllContacts } from "../../../extra/dataFetch";

export async function GET(request: Request) {
  return await getAllContacts();
}
