import { PrismaClient } from "@prisma/client";
import getPostsMetadata from "components/PostMetadata";
import { NextResponse } from "next/server";
import prisma from "./db";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

export async function getAllContacts() {
  const contacts = await prisma.contact.findMany({
    orderBy: {
      platform: "asc",
    },
  });

  return NextResponse.json(contacts);
}

export async function getAllPosts() {
  const posts = getPostsMetadata();
  const linkablePosts = posts.map((post) => ({
    name: post.title,
    description: post.description,
    link: `https://kualta.dev/posts/${post.filename}`,
  }));
  return NextResponse.json(linkablePosts);
}

export async function getAllProjects() {
  const projects = await prisma.project.findMany({
    orderBy: {
      relevance: "desc",
    },
  });

  return NextResponse.json(projects);
}

export async function getRandomImage() {
  try {
    const { data, error } = await supabase.storage.from("kuolluts").list();
    if (error || !data) throw error;

    const randomFile = data[Math.floor(Math.random() * data.length)];

    const {
      data: { publicUrl },
    } = supabase.storage.from("kuolluts").getPublicUrl(randomFile.name);

    return NextResponse.json({ url: publicUrl }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: `Could not fetch a kuollut: ${error}` }, { status: 500 });
  }
}
