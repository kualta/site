import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { NextApiRequest, NextApiResponse } from "next";
import { NextResponse } from "next/server";

const supabaseUrl: string = process.env.SUPABASE_URL!;
const supabaseKey: string = process.env.SUPABASE_KEY!;
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

export async function GET(request: Request) {
  try {
    const { data, error } = await supabase.storage.from("kuolluts").list();

    if (error) throw error;

    const randomFile = data![Math.floor(Math.random() * data!.length)];

    // Get the download URL for the random file
    const {
      data: { publicUrl },
    } = supabase.storage.from("kuolluts").getPublicUrl(randomFile.name);

    // Return the download URL
    return NextResponse.json({ url: publicUrl }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: `Could not fetch a kuollut: ${error}` }, { status: 500 });
  }
}
