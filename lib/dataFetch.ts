import getPostsMetadata from "components/PostMetadata";
import { NextResponse } from "next/server";
import { Contact, Project } from "@/types";
import contactsData from "@/data/contacts.json";
import projectsData from "@/data/projects.json";

export async function getAllContacts() {
  const contacts = contactsData as Contact[];
  // Sort by platform alphabetically
  const sortedContacts = [...contacts].sort((a, b) => a.platform.localeCompare(b.platform));
  return NextResponse.json(sortedContacts);
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
  const projects = projectsData as Project[];
  // Sort by relevance descending
  const sortedProjects = [...projects].sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
  return NextResponse.json(sortedProjects);
}
