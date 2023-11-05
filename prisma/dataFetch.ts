import { PrismaClient } from "@prisma/client";
import getPostMetadata from "components/PostMetadata";
import { NextResponse } from "next/server";
import prisma from "./db";

export async function getAllContacts() {
  const contacts = await prisma.contact.findMany({
    orderBy: {
      platform: "asc",
    },
  });

  return NextResponse.json(contacts);
}

export async function getAllPosts() {
  const posts = getPostMetadata();
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

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { NextApiRequest, NextApiResponse } from "next";

const supabaseUrl: string = process.env.SUPABASE_URL!;
const supabaseKey: string = process.env.SUPABASE_KEY!;
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

export async function getRandomImage() {
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
    return NextResponse.json(
      { error: `Could not fetch a kuollut: ${error}` },
      { status: 500 }
    );
  }
}
